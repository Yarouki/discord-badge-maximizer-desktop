from __future__ import annotations

from bridge import console, discord_http, stream_watch
from bridge.checks import has_control_chars
from bridge.errors import user_message
from bridge.protocol import emit, log, reply
from bridge.upstream import stream_mod

VIEWER_LOGIN_SEC = 30.0

ALT_REJECTED_TEXT = ("Discord no longer accepts the alt account's login, so the alt was disconnected. "
                     "Log the alt in again.")
ALT_NO_LOGIN_TEXT = ("The alt account couldn't log in to Discord, so the alt was disconnected. "
                     "Pick it again under Alt viewer, or log the alt in again.")


def alt_viewer_status(viewer) -> str:
    if viewer is None or not getattr(viewer, "running", False):
        return "idle"
    ws = getattr(viewer, "ws", None)
    if ws is None or getattr(ws, "closed", True) or not getattr(viewer, "user_id", ""):
        return "idle"
    return "watching" if getattr(viewer, "_is_watching", False) else "joined"


def check_alt_viewer(viewer, watch: stream_watch.StreamWatch) -> str | None:
    if viewer is None or not getattr(viewer, "running", False):
        return None
    if stream_watch.fatal_close_code(getattr(viewer, "_thread", None)) is not None:
        viewer.stop()
        return ALT_REJECTED_TEXT
    if getattr(viewer, "user_id", ""):
        watch.viewer_waiting_since.pop(id(viewer), None)
        return None
    first = watch.viewer_waiting_since.setdefault(id(viewer), watch.clock())
    if watch.clock() - first > VIEWER_LOGIN_SEC:
        viewer.stop()
        return ALT_NO_LOGIN_TEXT
    return None


def _viewer_count(self) -> int:
    members = set(self.channel_members) | set(self.stream_viewer_ids)
    if self.user_id:
        members.discard(str(self.user_id))
    viewer = self.viewer_engine
    ws = getattr(viewer, "ws", None)
    if viewer is not None and viewer.running and viewer.user_id and ws is not None and not ws.closed:
        members.add(str(viewer.user_id))
    return len(members)


class AltViewerMixin:
    def _forget_alt(self) -> None:
        with self.alt_lock:
            self._drop_alt()

    def _drop_alt(self) -> None:
        if self.viewer_engine:
            self.viewer_engine.stop()
            self.viewer_engine = None

    def _drop_rejected_alt(self, engine, viewer) -> bool:
        with self.alt_lock:
            if engine.viewer_engine is viewer:
                engine.viewer_engine = None
            if self.viewer_engine is viewer:
                self.viewer_engine = None
                return True
            return False

    def _attach_viewer(self, engine) -> None:
        with self.alt_lock:
            viewer = self.viewer_engine
            if viewer is None or not self.auto_watch or engine is None or not engine.running or not engine.channel_id:
                return
            if not viewer.running:
                if getattr(viewer, "_thread", None) is not None:
                    fresh = stream_mod.ViewerEngine(viewer.token, console.ConsoleProxy())
                    fresh.username = viewer.username
                    viewer = self.viewer_engine = fresh
                viewer.stream_key = getattr(engine, "stream_key", "") or ""
                viewer._is_watching = False
                viewer.start(engine.guild_id, engine.channel_id)
            engine.viewer_engine = viewer

    def _connect_alt(self, token: str) -> str:
        with self.alt_lock:
            return self._switch_alt(token)

    def _switch_alt(self, token: str) -> str:
        data = discord_http._get_json(stream_mod.ME_URL, discord_http._discord_headers(token, user_agent=stream_mod.USER_AGENT), timeout=10,
                         who="the alt account's login")
        if self.viewer_engine:
            self.viewer_engine.stop()
        viewer = stream_mod.ViewerEngine(token, console.ConsoleProxy())
        viewer.username = str(data.get("username") or "")
        self.viewer_engine = viewer
        self._attach_viewer(self.stream_engine)
        username = str(data.get("global_name") or data.get("username") or "alt")
        log(f"Alt account connected: {username}")
        return username

    def handle_connect_alt(self, msg_id: str, params: dict) -> None:
        token = str(params.get("token") or "").strip()
        if not token:
            reply(msg_id, error="The alt account's token is missing. Log the alt in again.")
            return
        if has_control_chars(token) or not token.isascii():
            reply(msg_id, error="The alt token contains invalid characters. Log in again.")
            return
        try:
            username = self._connect_alt(token)
        except Exception as exc:
            reply(msg_id, error=user_message(exc, "Couldn't connect the alt account"))
            return
        reply(msg_id, {"ok": True, "username": username})

    def handle_disconnect_alt(self, msg_id: str, _params: dict) -> None:
        self._forget_alt()
        log("Alt account disconnected")
        emit("alt-status", {"status": "idle"})
        reply(msg_id, {"ok": True})

    def handle_set_auto_watch(self, msg_id: str, params: dict) -> None:
        with self.alt_lock:
            self.auto_watch = params.get("enabled", True) is True
            viewer = self.viewer_engine
            if viewer:
                if self.auto_watch:
                    self._attach_viewer(self.stream_engine)
                else:
                    viewer.stop()
        reply(msg_id, {"ok": True, "enabled": self.auto_watch})
