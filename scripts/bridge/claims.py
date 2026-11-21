from __future__ import annotations

import threading

from bridge import account, discord_http
from bridge.checks import MAX_HOURS_PER_GAME, _run_id, _whole_number
from bridge.diagnostics import detail, detail_exception
from bridge.errors import CLOSING_TEXT, REASON_REDIRECT, user_message
from bridge.protocol import emit, log, reply
from bridge.upstream import games_mod

CLAIM_RETRIES = 3
RETRY_BASE_SEC = 2.0


def _is_retryable(status: int) -> bool:
    return status == 0 or status == 429 or 500 <= status <= 599


def _batch_failure_reason(status: int) -> str:
    if status == 0:
        return "no connection to Discord"
    if status == 429:
        return "Discord is rate limiting this account"
    if 500 <= status <= 599:
        return f"Discord had a server problem (HTTP {status})"
    if 300 <= status <= 399:
        return REASON_REDIRECT
    return f"Discord refused it (HTTP {status})"


def _mark_used(state, title_ids: list) -> None:
    sent = set(title_ids)
    state.used_games = [gid for gid in state.used_games if gid not in sent] + list(title_ids)


class ClaimsMixin:
    def _select_titles(self, count: int, state) -> list:
        used = set(state.used_games)
        chosen = [item for item in self.catalog if item.title_id not in used][:count]
        if len(chosen) < count:
            registry = {item.title_id: item for item in self.catalog}
            seen: set = set()
            for gid in state.used_games:
                if len(chosen) >= count:
                    break
                if gid in registry and gid not in seen:
                    seen.add(gid)
                    chosen.append(registry[gid])
        return chosen

    def handle_claim(self, msg_id: str, params: dict) -> None:
        with self.start_lock:
            self._start_claim(msg_id, params)

    def _start_claim(self, msg_id: str, params: dict) -> None:
        if not self.running:
            reply(msg_id, error=CLOSING_TEXT)
            return
        state = self.state
        if not state or not self.fabricator:
            reply(msg_id, error="Not logged in. Log in first.")
            return
        if self.claim_thread and self.claim_thread.is_alive():
            reply(msg_id, error="The last claim is still stopping. Try again in a moment.")
            return
        if not self.catalog:
            reply(msg_id, error="The detectable games list isn't loaded. Restart the app to try again.")
            return
        hours = _whole_number(params.get("hours", 50), 1, MAX_HOURS_PER_GAME)
        games_count = len(self.catalog) if params.get("all") is True else _whole_number(params.get("games", 100), 1, len(self.catalog))
        if hours is None or games_count is None:
            reply(msg_id, error=f"Pick 1 to {len(self.catalog)} games and 1 to {MAX_HOURS_PER_GAME} hours per game.")
            return
        run = _run_id(params)
        cancel = threading.Event()
        self._install_run("claim", run, cancel)

        try:
            if state.requires_refresh:
                self.runtime_ctx = games_mod.RuntimeClientContext.initialize()
                self.fabricator = games_mod.TelemetryEventFabricator(state, self.runtime_ctx)
                account.refresh_login(games_mod.synchronize_credentials, state, self.runtime_ctx.encoded_properties,
                              lambda s: s.requires_refresh)
        except Exception as exc:
            reply(msg_id, error=user_message(exc, "Couldn't refresh the login"))
            return

        fabricator = self.fabricator
        selected = self._select_titles(games_count, state)
        if cancel.is_set():
            reply(msg_id, {"ok": True, "run": run})
            batches = (len(selected) + games_mod.DISPATCH_BATCH_LIMIT - 1) // games_mod.DISPATCH_BATCH_LIMIT
            emit("claim-done", {"games": 0, "hours": 0, "run": run, "batches": batches,
                                "failed": 0, "failedGames": 0, "stopped": True})
            return

        self.claim_thread = threading.Thread(
            target=self._run_claim, args=(state, fabricator, selected, hours, run, cancel), daemon=True
        )
        self.claim_thread.start()
        reply(msg_id, {"ok": True, "run": run})

    def _send_batch(self, fabricator, events: list, cancel: threading.Event) -> int:
        status = 0
        for attempt in range(CLAIM_RETRIES + 1):
            discord_http._RESPONSE_INFO.retry_after = None
            status = fabricator.post_telemetry_batch(events)
            if status == 204 or not _is_retryable(status) or attempt == CLAIM_RETRIES:
                return status
            asked = discord_http._parse_retry_after(getattr(discord_http._RESPONSE_INFO, "retry_after", None))
            wait = asked if asked is not None else RETRY_BASE_SEC * (2 ** attempt)
            if cancel.wait(min(wait, discord_http.MAX_RETRY_WAIT_SEC)):
                return status
        return status

    def _save_claim_state(self, state, warned: bool) -> bool:
        if state is not self.state and not getattr(state, "_state_file", None):
            return warned
        try:
            state.persist()
        except OSError as exc:
            detail(f"claim save: {type(exc).__name__}: {exc}")
            if not warned:
                log("Couldn't save the claim totals to the data folder. The claim goes on, "
                    "but totals from this claim may be missing after a restart.", "error")
            return True
        return warned

    def _run_claim(self, state, fabricator, selected: list, hours: int, run: int, cancel: threading.Event) -> None:
        processed = failed = failed_games = 0
        batch_size = games_mod.DISPATCH_BATCH_LIMIT
        total_batches = (len(selected) + batch_size - 1) // batch_size
        last_failure = ""
        save_warned = False

        def done(**extra) -> None:
            emit("claim-done", {"games": processed, "hours": processed * hours, "run": run,
                                "batches": total_batches, "failed": failed, "failedGames": failed_games, **extra})

        try:
            duration_ms = int(hours * 3600 * 1000)
            for batch_idx, start in enumerate(range(0, len(selected), batch_size), 1):
                if cancel.is_set():
                    break
                partition = selected[start:start + batch_size]
                events: list = []
                for title in partition:
                    events.extend(fabricator.assemble_complete_session(title, duration_ms))
                status = self._send_batch(fabricator, events, cancel)
                if status in (401, 403):
                    log(f"Batch {batch_idx} of {total_batches} was refused: Discord no longer accepts this login.", "error")
                    done(error="Discord no longer accepts this login. Log out and log in again.")
                    return
                if status != 204 and cancel.is_set():
                    break
                if status == 204:
                    processed += len(partition)
                    state.total_games_claimed += len(partition)
                    state.total_hours_claimed += len(partition) * hours
                    _mark_used(state, [title.title_id for title in partition])
                    save_warned = self._save_claim_state(state, save_warned)
                    log(f"Batch {batch_idx} of {total_batches} sent")
                else:
                    failed += 1
                    failed_games += len(partition)
                    last_failure = _batch_failure_reason(status)
                    log(f"Batch {batch_idx} of {total_batches} failed: {last_failure}. "
                        "Its games stay unclaimed and come first next time.", "error")
                emit("claim-progress", {
                    "batch": batch_idx, "total": total_batches, "processed": processed,
                    "target": len(selected), "run": run, "failed": failed,
                    "game": partition[-1].display_name if partition else "",
                })
                if cancel.wait(games_mod.NETWORK_COOLDOWN_SEC):
                    break
            if cancel.is_set():
                done(stopped=True)
                return
            if total_batches and failed == total_batches:
                done(error=f"None of the batches went through ({last_failure}). Try again later.")
                return
            done()
        except Exception as exc:
            detail_exception("claim:", exc)
            done(error="The claim stopped because of an unexpected error. Start it again.")

    def handle_stop_claim(self, msg_id: str, params: dict) -> None:
        self._stop_run("claim", params)
        reply(msg_id, {"ok": True})
