from __future__ import annotations

import sys
import time
from pathlib import Path

from bridge import state_files
from bridge.diagnostics import detail
from bridge.protocol import log

MAX_TICK_GAP_SEC = 5.0
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

MIN_SAVED_STREAM_SEC = 10.0

MAX_PENDING_SEC = 7 * 24 * 3600.0


def _execution_state_call():
    import ctypes
    return ctypes.windll.kernel32.SetThreadExecutionState


def _set_keep_awake(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    try:
        _execution_state_call()(ES_CONTINUOUS | ES_SYSTEM_REQUIRED if enabled else ES_CONTINUOUS)
    except Exception as exc:
        detail(f"keep awake: {type(exc).__name__}: {exc}")


def run_stream_ticker(engine, clock=time.monotonic, wait=time.sleep) -> None:
    _set_keep_awake(True)
    try:
        last = clock()
        while engine.running:
            wait(1.0)
            if not engine.running:
                break
            now = clock()
            gap, last = now - last, now
            if 0 < gap <= MAX_TICK_GAP_SEC and engine.stream_connected and engine.get_viewer_count() > 0:
                engine.counted_stream_seconds += gap
    finally:
        _set_keep_awake(False)


def fill_channel_members(engine) -> None:
    for guild in getattr(engine, "_cached_supplemental_guilds", None) or []:
        if not isinstance(guild, dict) or str(guild.get("id")) != str(engine.guild_id):
            continue
        for state in guild.get("voice_states") or []:
            if isinstance(state, dict) and str(state.get("channel_id")) == str(engine.channel_id):
                user = str(state.get("user_id"))
                if user != str(engine.user_id):
                    engine.channel_members.add(user)


def checkpoint_stream(engine) -> None:
    path = getattr(engine.state, "_state_file", None)
    if not path:
        return
    with state_files._STATE_LOCK:
        if not engine.running:
            return
        try:
            state_files._merge_write(path, {"pending_stream_seconds": round(float(engine.counted_stream_seconds), 1)})
        except OSError as exc:
            detail(f"stream checkpoint: {type(exc).__name__}: {exc}")


def fold_pending_stream(stream_state, path: Path) -> None:
    try:
        pending = state_files._read_json(path).get("pending_stream_seconds")
    except OSError:
        return
    if isinstance(pending, bool) or not isinstance(pending, (int, float)):
        return
    if not MIN_SAVED_STREAM_SEC <= pending <= MAX_PENDING_SEC:
        return
    stream_state.total_stream_hours_claimed += pending / 3600.0
    stream_state.total_stream_sessions += 1
    try:
        stream_state.save()
    except OSError as exc:
        detail(f"fold pending stream: {type(exc).__name__}: {exc}")
    log(f"Added {pending / 3600.0:.2f} h from a stream that didn't end cleanly.")


def finish_stream(engine, seconds: float) -> str:
    state = engine.state
    sessions_before = state.total_stream_sessions
    cleanup_failed = False
    try:
        engine._cleanup(engine.guild_id)
    except Exception as exc:
        cleanup_failed = True
        detail(f"stream cleanup: {type(exc).__name__}: {exc}")
    if seconds < MIN_SAVED_STREAM_SEC:
        return ""
    needs_save = cleanup_failed
    if state.total_stream_sessions == sessions_before:
        state.total_stream_hours_claimed += seconds / 3600.0
        state.total_stream_sessions += 1
        needs_save = True
    if needs_save:
        try:
            state.save()
        except OSError as exc:
            detail(f"stream save: {type(exc).__name__}: {exc}")
            return ("The watched hours couldn't be saved to the data folder. Close any program that has "
                    "files there open before the next stream.")
    return ""
