from __future__ import annotations

import json
import sys
import threading
from typing import Callable, TextIO

from bridge import account, alt_viewer, badges, claims, servers, streams
from bridge import selfcheck
from bridge.checks import _run_id
from bridge.diagnostics import detail, detail_exception
from bridge.errors import REINSTALL_TEXT, plain_reason
from bridge.protocol import reply
from bridge.upstream import games_mod, stream_mod

WORK_STOP_TIMEOUT_SEC = 5.0


class BridgeAdapter(
    account.AccountMixin,
    claims.ClaimsMixin,
    streams.StreamsMixin,
    alt_viewer.AltViewerMixin,
    servers.ServersMixin,
    badges.BadgesMixin,
):
    SLOW_METHODS = {"validate", "legacy-login", "badges", "voice-servers", "voice-channels", "connect-alt", "logout", "claim", "stream", "set-auto-watch", "disconnect-alt"}
    WITHOUT_UPSTREAM = frozenset({"shutdown", "logout", "disconnect-alt"})

    def __init__(self, commands: TextIO | None = None) -> None:
        self.commands: TextIO = commands if commands is not None else sys.stdin
        self.startup_problem: str | None = None
        self._badges_logged: str | None = None
        self.state: games_mod.AccountSessionState | None = None
        self.user_id = ""
        self.stream_state: stream_mod.State | None = None
        self.runtime_ctx: games_mod.RuntimeClientContext | None = None
        self.session: stream_mod.Session | None = None
        self.fabricator: games_mod.TelemetryEventFabricator | None = None
        self.catalog: list[games_mod.DetectableTitle] = []

        self.stream_engine: stream_mod.GatewayStreamEngine | None = None
        self.viewer_engine: stream_mod.ViewerEngine | None = None
        self.claim_thread: threading.Thread | None = None
        self.stream_thread: threading.Thread | None = None
        self.claim_cancel = threading.Event()
        self.stream_cancel = threading.Event()
        self.claim_run: int | None = None
        self.stream_run: int | None = None
        self._early_stops: dict = {"claim": None, "stream": None}
        self._run_lock = threading.Lock()
        self.auto_watch = True
        self.account_lock = threading.Lock()
        self.start_lock = threading.Lock()
        self.alt_lock = threading.RLock()
        self.running = True
        self.handlers: dict[str, Callable[[str, dict], None]] = {
            "validate": self.handle_validate,
            "claim": self.handle_claim,
            "stop-claim": self.handle_stop_claim,
            "stream": self.handle_stream,
            "stop-stream": self.handle_stop_stream,
            "connect-alt": self.handle_connect_alt,
            "disconnect-alt": self.handle_disconnect_alt,
            "set-auto-watch": self.handle_set_auto_watch,
            "legacy-login": self.handle_legacy_login,
            "legacy-clear": self.handle_legacy_clear,
            "logout": self.handle_logout,
            "badges": self.handle_badges,
            "voice-servers": self.handle_voice_servers,
            "voice-channels": self.handle_voice_channels,
            "shutdown": self.handle_shutdown,
        }

    def _stop_work(self) -> None:
        self.claim_cancel.set()
        self.stream_cancel.set()
        engine = self.stream_engine
        if engine:
            engine.running = False
        for thread in (self.claim_thread, self.stream_thread):
            if thread and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=WORK_STOP_TIMEOUT_SEC)

    def _install_run(self, kind: str, run: int, cancel: threading.Event) -> None:
        with self._run_lock:
            setattr(self, f"{kind}_cancel", cancel)
            setattr(self, f"{kind}_run", run)
            if run and self._early_stops[kind] == run:
                self._early_stops[kind] = None
                cancel.set()

    def _stop_run(self, kind: str, params: dict) -> bool:
        run = _run_id(params)
        with self._run_lock:
            current = getattr(self, f"{kind}_run")
            if not run or run == current:
                getattr(self, f"{kind}_cancel").set()
                return True
            if current is None or run > current:
                self._early_stops[kind] = run
            return False

    def _shut_down(self) -> None:
        self.running = False
        self._stop_work()
        with self.alt_lock:
            if self.viewer_engine:
                self.viewer_engine.stop()

    def handle_shutdown(self, msg_id: str, _params: dict) -> None:
        self._shut_down()
        reply(msg_id, {"ok": True})

    def _call(self, handler: Callable[[str, dict], None], msg_id: str, params: dict) -> None:
        try:
            handler(msg_id, params)
        except Exception as exc:
            detail_exception("request:", exc)
            reply(msg_id, error=f"The request failed ({plain_reason(exc)}). Try again.")

    def dispatch(self, msg: object) -> None:
        if not isinstance(msg, dict):
            return
        msg_id = str(msg.get("id", "0"))
        method = msg.get("method")
        params = msg.get("params")
        if not isinstance(params, dict):
            params = {}
        handler = self.handlers.get(method) if isinstance(method, str) else None
        if self.startup_problem and method not in self.WITHOUT_UPSTREAM:
            reply(msg_id, error=self.startup_problem)
            return
        if handler is None:
            detail(f"unknown method: {str(method)[:80]!r}")
            reply(msg_id, error=f"The app and its backend don't match. {REINSTALL_TEXT}")
            return
        if method in self.SLOW_METHODS:
            threading.Thread(target=self._call, args=(handler, msg_id, params), daemon=True).start()
        else:
            self._call(handler, msg_id, params)

    def run(self) -> None:
        while self.running:
            line = self.commands.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except (ValueError, RecursionError):
                detail("ignored a line that isn't JSON")
                continue
            self.dispatch(msg)
        if self.running:
            self._shut_down()
