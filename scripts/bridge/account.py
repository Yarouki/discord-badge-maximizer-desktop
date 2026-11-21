from __future__ import annotations

from pathlib import Path
from typing import Callable

from bridge import discord_http, state_files, stream_hours
from bridge.checks import ACCOUNT_ID, has_control_chars, normalize_cookie_header
from bridge.diagnostics import detail
from bridge.errors import UNEXPECTED_ACCOUNT_TEXT, _Friendly, plain_reason, user_message
from bridge.protocol import emit, log, reply
from bridge.upstream import games_mod, stream_mod


def refresh_login(refresh: Callable, state, props: str, still_needed: Callable) -> None:
    try:
        refresh(state, props)
    except OSError as exc:
        if still_needed(state):
            raise
        detail(f"login refresh save: {type(exc).__name__}: {exc}")
        log("The account's file couldn't be saved after the login was refreshed. This start goes on; "
            "close any program that has files in the app's data folder open.", "warning")


def games_loaded_text(count: int) -> str:
    return f"{count:,} detectable {'game' if count == 1 else 'games'} loaded"


class AccountMixin:
    def _check_credentials(self, token: str, cookie: str) -> str | None:
        if not token:
            return "The token is missing. Log in again."
        if not cookie:
            return "The cookie is missing. Log in again."
        if has_control_chars(token):
            return "The token contains line breaks or other invalid characters. Copy it again."
        if has_control_chars(cookie):
            return "The cookie contains line breaks or other invalid characters. Copy it again."
        if not token.isascii():
            return "The token contains characters a Discord token can't have. Copy it again."
        if not cookie.isascii():
            return "The cookie contains characters a Discord cookie can't have. Copy it again."
        return None

    def _fetch_identity(self, token: str, props: str) -> dict:
        return discord_http._get_json(games_mod.REST_IDENTITY_URL, discord_http._discord_headers(token, props), timeout=10)

    def _login(self, token: str, cookie: str) -> dict:
        same_token = self.state is not None and token == self.state.token and self.runtime_ctx is not None
        ctx = None if same_token else games_mod.RuntimeClientContext.initialize()
        log("Checking your Discord account")
        identity = self._fetch_identity(token, (ctx or self.runtime_ctx).encoded_properties)

        user_id = str(identity.get("id") or games_mod.extract_account_snowflake(token) or "")
        if not ACCOUNT_ID.fullmatch(user_id):
            raise _Friendly(UNEXPECTED_ACCOUNT_TEXT)
        if self.state is not None and self.stream_state is not None and user_id == self.user_id \
                and token == self.state.token:
            catalog = None if self.catalog else self._load_catalog()
            with self.start_lock:
                self.state.cookie = self.stream_state.cookie = cookie
                if catalog:
                    self.catalog = catalog
            if catalog:
                log(games_loaded_text(len(catalog)))
            return self._login_reply(identity, user_id)
        if ctx is None:
            ctx = games_mod.RuntimeClientContext.initialize()
        target = state_files.account_file(user_id)
        session = stream_mod.Session.new()
        catalog = self._load_catalog()

        with self.start_lock:
            state, stream_state = self._switch_account(target, token, cookie)
            self.user_id = user_id
            self.state, self.stream_state, self.runtime_ctx, self.session = state, stream_state, ctx, session
            self.fabricator = games_mod.TelemetryEventFabricator(state, ctx)
            self.catalog = catalog
        try:
            games_mod.synchronize_credentials(state, ctx.encoded_properties)
            stream_mod.ensure_token(stream_state, session.super_props)
        except Exception as exc:
            detail(f"analytics token: {type(exc).__name__}: {exc}")
            log(f"Couldn't prepare claiming yet ({plain_reason(exc)}). The app tries again when you start a claim.", "warning")

        reply_data = self._login_reply(identity, user_id)
        log(f"Logged in as {reply_data['user']['displayName']} ({user_id})")
        log(games_loaded_text(len(catalog)))
        self.forget_logged_badges()
        return reply_data

    def _login_reply(self, identity: dict, user_id: str) -> dict:
        username = str(identity.get("username") or "")
        display = str(identity.get("global_name") or username)
        stream_state = self.stream_state
        catalog = self.catalog
        return {
            "ok": True,
            "user": {"id": user_id, "username": username, "displayName": display},
            "catalog_size": len(catalog),
            "batch_size": games_mod.DISPATCH_BATCH_LIMIT,
            "last_guild_id": stream_state.last_guild_id,
            "last_channel_id": stream_state.last_channel_id,
            "totals": self._totals(),
        }

    def _load_catalog(self) -> list:
        try:
            log("Loading the detectable games list")
            return games_mod.load_game_catalog()
        except Exception as exc:
            detail(f"games list: {type(exc).__name__}: {exc}")
            log(f"Couldn't load the detectable games list ({plain_reason(exc)}). Restart the app to try again.", "error")
            return []

    def _switch_account(self, target: Path, token: str, cookie: str) -> tuple:
        self._stop_work()
        if self.stream_thread and self.stream_thread.is_alive():
            raise _Friendly("The last stream is still stopping. Try again in a moment.")
        if self.claim_thread and self.claim_thread.is_alive():
            raise _Friendly("The last claim is still stopping. Try again in a moment.")
        saved = state_files.read_account_data(target)
        state = state_files.state_from_saved(games_mod.AccountSessionState, saved)
        stream_state = state_files.state_from_saved(stream_mod.State, saved)
        games_mod.STATE_STORAGE_PATH = target
        stream_mod.STATE_FILE = target
        state_files.bind_state_file(state, target)
        state_files.bind_state_file(stream_state, target)
        stream_hours.fold_pending_stream(stream_state, target)
        state.token, state.cookie, state.analytics_token = token, cookie, ""
        stream_state.token, stream_state.cookie, stream_state.analytics_token = token, cookie, ""
        return state, stream_state

    def _totals(self) -> dict:
        games_state = self.state or games_mod.AccountSessionState.restore()
        stream_state = self.stream_state or stream_mod.State.load()
        return {
            "games": games_state.total_games_claimed,
            "gameHours": games_state.total_hours_claimed,
            "streamHours": stream_state.total_stream_hours_claimed,
            "streamSessions": stream_state.total_stream_sessions,
        }

    def handle_validate(self, msg_id: str, params: dict) -> None:
        token = str(params.get("token") or "").strip()
        cookie = normalize_cookie_header(params.get("cookie"))
        problem = self._check_credentials(token, cookie)
        if problem:
            reply(msg_id, error=problem)
            return
        with self.account_lock:
            try:
                reply(msg_id, self._login(token, cookie))
            except Exception as exc:
                reply(msg_id, error=user_message(exc, "Couldn't log in"))

    def handle_legacy_login(self, msg_id: str, _params: dict) -> None:
        legacy = state_files._data_folder() / "session.json"
        with state_files._STATE_LOCK:
            data = state_files._read_json(legacy)
            token = str(data.get("token") or "").strip()
            cookie = normalize_cookie_header(data.get("cookie"))
            alt = str(data.get("viewer_token") or "").strip()
            found = self._check_credentials(token, "x") is None
            if self._check_credentials("x", cookie) is not None:
                cookie = ""
            state_files.LEGACY_IMPORT["pending"] = found
            if not found:
                state_files.strip_legacy_secrets(legacy, data)
        if not found:
            reply(msg_id, {"ok": True, "found": False})
            return
        reply(msg_id, {"ok": True, "found": True, "token": token, "cookie": cookie,
                       "altToken": alt if alt and not has_control_chars(alt) else ""})

    def handle_legacy_clear(self, msg_id: str, _params: dict) -> None:
        legacy = state_files._data_folder() / "session.json"
        with state_files._STATE_LOCK:
            owner = state_files._legacy_owner(state_files._read_json(legacy))
            state_files._merge_write(legacy, {"totals_owner": owner} if owner else {})
            state_files.LEGACY_IMPORT["pending"] = False
        reply(msg_id, {"ok": True})

    def handle_logout(self, msg_id: str, _params: dict) -> None:
        with self.account_lock, self.start_lock:
            self._stop_work()
            self._forget_alt()
            self.state = self.stream_state = None
            self.fabricator = None
            self.session = None
            self.runtime_ctx = None
            log("Logged out")
            emit("alt-status", {"status": "idle"})
            reply(msg_id, {"ok": True})
