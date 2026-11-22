from __future__ import annotations

import json
import threading
import time
import weakref

from bridge.diagnostics import detail
from bridge.protocol import log
from bridge.upstream import stream_mod

FATAL_GATEWAY_CODES = frozenset({4004, 4010, 4011, 4012, 4013, 4014})
_FATAL_CLOSES: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_original_recv = None


def _recv_recording_close(self, timeout: float = 5.0) -> dict | None:
    msg = _original_recv(self, timeout)
    if isinstance(msg, dict) and msg.get("op") == "close":
        code = msg.get("code")
        self.close_code = code
        if getattr(self, "host", "") == stream_mod.GATEWAY_URL and code in FATAL_GATEWAY_CODES:
            _FATAL_CLOSES[threading.current_thread()] = code
    return msg


def fatal_close_code(thread) -> int | None:
    return _FATAL_CLOSES.get(thread) if thread is not None else None


GATEWAY_DOWN_SEC = 120.0
MAX_REJOINS = 3
STREAM_REQUEST_TICKS = 3
MAX_STREAM_REQUESTS = 3


class StreamWatch:
    def __init__(self, event_thread: threading.Thread | None = None, clock=time.monotonic) -> None:
        self.event_thread = event_thread
        self.clock = clock
        self.reason = ""
        self.down_ticks = 0
        self.rejoins = 0
        self.stream_down_ticks = 0
        self.stream_requests = 0
        self.gateway_down_since: float | None = None
        self.viewer_waiting_since: dict = {}


def end_reason(engine, proxy, code: int | None, watch: StreamWatch) -> str:
    flags = getattr(proxy, "flags", set())
    if code == 4004 or "auth_rejected" in flags:
        return "Discord no longer accepts this login. Log out and log in again."
    if code in FATAL_GATEWAY_CODES or "fatal_gateway" in flags:
        return "Discord closed the connection, so the stream stopped. The login may have expired: log out and log in again."
    if "moved_vc" in flags:
        return "You switched voice channels in your Discord app, so the stream stopped."
    if "left_vc" in flags or getattr(engine, "_user_left_vc", False):
        return "You left the voice channel in your Discord app, so the stream stopped."
    if "repeated_stops" in flags:
        return "Discord stopped the stream three times in a row. Wait a few minutes, then start it again."
    if watch.reason:
        return watch.reason
    return "Discord ended the stream. Start it again."


def _stream_ready(engine) -> bool:
    conn = getattr(engine, "stream_conn", None)
    ws = getattr(conn, "ws", None)
    return bool(engine.stream_connected and conn is not None and getattr(conn, "running", False)
                and getattr(conn, "secret_key", b"") and getattr(conn, "udp_sock", None)
                and ws is not None and not ws.closed)


def _connection_dead(conn) -> bool:
    if conn is None:
        return False
    ws = getattr(conn, "ws", None)
    return bool(getattr(conn, "closed", False) or not getattr(conn, "running", False) or ws is None or ws.closed)


def watch_connections(engine, watch: StreamWatch) -> None:
    if fatal_close_code(watch.event_thread) is not None:
        engine.running = False
        return
    ws = engine.ws
    if ws is None or ws.closed:
        if watch.gateway_down_since is None:
            watch.gateway_down_since = watch.clock()
        elif watch.clock() - watch.gateway_down_since > GATEWAY_DOWN_SEC:
            watch.reason = ("Lost the connection to Discord and couldn't get it back within 2 minutes. "
                            "Check your internet connection and start the stream again.")
            engine.running = False
        return
    watch.gateway_down_since = None
    engine._clear_voice_if_dead(engine.voice_conn)
    if _connection_dead(engine.stream_conn):
        engine.stream_connected = False
    if engine.stream_connected:
        watch.down_ticks = watch.rejoins = 0
        if engine.stream_key:
            try:
                ws.send(json.dumps({"op": 22, "d": {"stream_key": engine.stream_key, "paused": False}}))
            except Exception as exc:
                detail(f"watchdog unpause: {type(exc).__name__}: {exc}")
            if engine.viewer_engine is not None:
                engine.viewer_engine.watch(engine.stream_key)
    if _stream_ready(engine):
        watch.stream_down_ticks = watch.stream_requests = 0
        return
    if getattr(engine, "_user_left_vc", False):
        return
    if engine.voice_connected:
        watch.down_ticks = 0
        _ask_for_the_stream_again(engine, watch, ws)
        return
    if engine.stream_connected:
        return
    watch.down_ticks += 1
    if watch.down_ticks < 2:
        return
    watch.down_ticks = 0
    if watch.rejoins >= MAX_REJOINS:
        watch.reason = ("The connection to Discord's voice server was lost and couldn't be restored. "
                        "Start the stream again.")
        engine.running = False
        return
    watch.rejoins += 1
    log("The voice connection stalled. Joining the channel again.", "warning")
    engine._force_rejoin_voice()


def _ask_for_the_stream_again(engine, watch: StreamWatch, ws) -> None:
    watch.stream_down_ticks += 1
    if watch.stream_down_ticks < STREAM_REQUEST_TICKS:
        return
    watch.stream_down_ticks = 0
    if watch.stream_requests >= MAX_STREAM_REQUESTS:
        watch.reason = ("The connection to Discord's stream server was lost and couldn't be restored. "
                        "Start the stream again.")
        engine.running = False
        return
    watch.stream_requests += 1
    log("The stream connection dropped. Asking Discord for the stream again.", "warning")
    try:
        ws.send(json.dumps({"op": 18, "d": {"type": "guild", "guild_id": engine.guild_id,
                                            "channel_id": engine.channel_id, "preferred_region": None}}))
    except Exception as exc:
        detail(f"watchdog stream request: {type(exc).__name__}: {exc}")
