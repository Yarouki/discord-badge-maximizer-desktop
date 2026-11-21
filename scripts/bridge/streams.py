from __future__ import annotations

import json
import threading
import time

from bridge import account, alt_viewer, console, stream_hours, stream_media, stream_watch
from bridge.checks import DISCORD_ID, _run_id
from bridge.diagnostics import detail, detail_exception
from bridge.errors import CLOSING_TEXT, REASON_NO_CONNECTION, plain_reason, user_message
from bridge.protocol import emit, log, reply
from bridge.upstream import stream_mod

READY_WAIT_SEC = 20.0
VOICE_WAIT_SEC = 10.0
STREAM_WAIT_SEC = 25.0
MEDIA_WAIT_SEC = 5.0
WATCHDOG_SEC = 10.0
CHECKPOINT_SEC = 60.0
VIEWER_TICK_SEC = 2.0


def _stream_failure_text(exc: BaseException) -> str:
    reason = plain_reason(exc)
    if reason == REASON_NO_CONNECTION:
        return "Lost the connection to Discord. Check your internet connection and start the stream again."
    return f"The stream stopped because of {reason}. Start it again."


class _Ended(Exception):
    pass


class StreamsMixin:
    def handle_stream(self, msg_id: str, params: dict) -> None:
        with self.start_lock:
            self._start_stream(msg_id, params)

    def _start_stream(self, msg_id: str, params: dict) -> None:
        if not self.running:
            reply(msg_id, error=CLOSING_TEXT)
            return
        stream_state = self.stream_state
        if not stream_state or not self.session:
            reply(msg_id, error="Not logged in. Log in first.")
            return
        if self.stream_thread and self.stream_thread.is_alive():
            reply(msg_id, error="The last stream is still stopping. Try again in a moment.")
            return
        server_id = str(params.get("serverId") or "").strip()
        channel_id = str(params.get("channelId") or "").strip()
        if not DISCORD_ID.fullmatch(server_id) or not DISCORD_ID.fullmatch(channel_id):
            reply(msg_id, error="Server ID and voice channel ID must be 17 to 20 digits. "
                                "Pick the server and channel again.")
            return
        mode = "silent" if params.get("mode") == "silent" else "video"
        run = _run_id(params)
        cancel = threading.Event()
        self._install_run("stream", run, cancel)

        try:
            if stream_state.is_stale:
                self.session = stream_mod.Session.new()
                account.refresh_login(stream_mod.ensure_token, stream_state, self.session.super_props, lambda s: s.is_stale)
        except Exception as exc:
            reply(msg_id, error=user_message(exc, "Couldn't refresh the login"))
            return
        if cancel.is_set():
            reply(msg_id, {"ok": True, "run": run})
            emit("stream-ended", {"hours": 0.0, "seconds": 0.0, "run": run})
            return

        stream_state.last_guild_id = server_id
        stream_state.last_channel_id = channel_id
        try:
            stream_state.save()
        except OSError as exc:
            detail(f"stream start save: {type(exc).__name__}: {exc}")
            log("Couldn't save the chosen server and channel to the data folder.", "warning")
        stream_media.STREAM_SETTINGS["mode"] = mode

        engine = stream_mod.GatewayStreamEngine(stream_state, self.session, console.ConsoleProxy())
        self.stream_engine = engine
        self.stream_thread = threading.Thread(
            target=self._run_stream, args=(engine, cancel, run, server_id, channel_id, mode), daemon=True
        )
        self.stream_thread.start()
        reply(msg_id, {"ok": True, "run": run})

    def _wait_for(self, engine, cancel: threading.Event, check, seconds: float) -> bool:
        test = check if callable(check) else (lambda: bool(getattr(engine, check, False)))
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if test():
                return True
            if cancel.is_set() or not engine.running:
                return False
            cancel.wait(0.1)
        return bool(test())

    def _ended_text(self, engine, watch: stream_watch.StreamWatch) -> str:
        return stream_watch.end_reason(engine, getattr(engine, "console", None), stream_watch.fatal_close_code(watch.event_thread), watch)

    def _setup_failure(self, engine, watch: stream_watch.StreamWatch, timeout_text: str) -> _Ended:
        return _Ended(self._ended_text(engine, watch) if not engine.running else timeout_text)

    def _run_stream(self, engine, cancel: threading.Event, run: int, server_id: str, channel_id: str, mode: str) -> None:
        started = False
        error = ""
        tick: threading.Thread | None = None
        watch = stream_watch.StreamWatch()
        requested = mode
        try:
            mode, fallback = stream_media.video_preflight(mode)
            if fallback:
                log(fallback, "warning")
            stream_media.STREAM_SETTINGS.update(mode=mode, media="", fallback=fallback, pump=None)
            emit("stream-step", {"step": 0, "label": "Connecting to gateway", "run": run})
            engine.ws = stream_mod.MiniWebSocket(stream_mod.GATEWAY_URL, path="/?v=9&encoding=json")
            engine.ws.connect()
            if cancel.is_set():
                return
            engine.running = True
            started = True
            engine.start_time = time.time()
            engine.counted_stream_seconds = 0.0
            engine.user_id = stream_mod._user_id_from_token(engine.state.token) or ""
            engine.stream_ever_active = False
            engine._stream_recreate_attempts = 0
            engine._user_left_vc = False
            engine._was_already_in_vc = False
            engine.ready_received.clear()
            emit("stream-step", {"step": 1, "label": "Gateway connected", "run": run})

            watch.event_thread = threading.Thread(target=engine._event_loop, daemon=True)
            watch.event_thread.start()
            if not self._wait_for(engine, cancel, engine.ready_received.is_set, READY_WAIT_SEC):
                if cancel.is_set():
                    return
                raise self._setup_failure(engine, watch, f"Discord didn't finish logging in within {READY_WAIT_SEC:.0f} "
                                                         "seconds. Start the stream again.")

            engine.guild_id = server_id
            engine.channel_id = channel_id
            engine.channel_name = channel_id
            stream_hours.fill_channel_members(engine)
            emit("stream-step", {"step": 2, "label": "Joining voice channel", "run": run})
            gateway = engine.ws
            if gateway is None or gateway.closed:
                raise _Ended("The connection to Discord closed while joining the voice channel. Start the stream again.")
            gateway.send(json.dumps({
                "op": 4,
                "d": {"guild_id": server_id, "channel_id": channel_id, "self_mute": False, "self_deaf": False, "self_video": False},
            }))
            engine._ticker_thread = threading.Thread(target=stream_hours.run_stream_ticker, args=(engine,), daemon=True)
            engine._ticker_thread.start()

            self._attach_viewer(engine)

            if not self._wait_for(engine, cancel, "voice_connected", VOICE_WAIT_SEC):
                if cancel.is_set():
                    return
                raise self._setup_failure(engine, watch, f"Couldn't join the voice channel within {VOICE_WAIT_SEC:.0f} "
                                                         "seconds. Check that this account is allowed to connect to it.")
            emit("stream-step", {"step": 3, "label": "Voice connected, creating stream", "run": run})

            if not self._wait_for(engine, cancel, lambda: stream_watch._stream_ready(engine), STREAM_WAIT_SEC):
                if cancel.is_set():
                    return
                raise self._setup_failure(engine, watch, "The voice channel was joined, but Discord didn't start the "
                                                         f"stream within {STREAM_WAIT_SEC:.0f} seconds. Check that this "
                                                         "account is allowed to share its screen there.")
            if mode == "video":
                self._wait_for(engine, cancel, lambda: bool(stream_media.STREAM_SETTINGS["media"]), MEDIA_WAIT_SEC)
            emit("stream-step", {"step": 4, "label": "Encryption ready (DAVE)", "run": run})
            live: dict = {"mode": "silent" if "silent" in (mode, stream_media.STREAM_SETTINGS["media"]) else "video", "run": run}
            if requested == "video" and live["mode"] == "silent":
                live["fallback"] = stream_media.STREAM_SETTINGS["fallback"] or stream_media.FFMPEG_FAILED_TEXT
            emit("stream-live", live)
            log("Discord only counts the hours when 'Use data to personalize my Discord experience' "
                "is on (User Settings, Data & Privacy).")

            tick = threading.Thread(target=self._viewer_tick, args=(engine, cancel, run, watch), daemon=True)
            tick.start()
            while engine.running and not cancel.is_set():
                cancel.wait(1.0)
            if not cancel.is_set():
                raise _Ended(self._ended_text(engine, watch))
        except _Ended as exc:
            error = str(exc)
        except Exception as exc:
            detail_exception("stream:", exc)
            error = _stream_failure_text(exc)
        finally:
            seconds = 0.0
            if started:
                engine.running = False
                if tick is not None:
                    tick.join(VIEWER_TICK_SEC + 1.0)
                seconds = float(getattr(engine, "counted_stream_seconds", 0.0) or 0.0)
                if seconds < stream_hours.MIN_SAVED_STREAM_SEC:
                    seconds = 0.0
                save_problem = stream_hours.finish_stream(engine, seconds)
                if save_problem:
                    error = f"{error} {save_problem}".strip()
            elif getattr(engine, "ws", None):
                try:
                    engine.ws.close()
                except Exception as exc:
                    detail(f"closing the connection: {type(exc).__name__}: {exc}")
            stream_media.STREAM_SETTINGS["pump"] = None
            if self.stream_engine is engine:
                self.stream_engine = None
            ended = {"hours": seconds / 3600.0, "seconds": seconds, "run": run}
            if error:
                ended["error"] = error
            if seconds or not error:
                log(f"Watched time this stream: {seconds / 3600.0:.2f} h")
            emit("stream-ended", ended)

    def _viewer_tick(self, engine, cancel: threading.Event, run: int, watch: stream_watch.StreamWatch | None = None) -> None:
        watch = watch or stream_watch.StreamWatch()
        last_alt = None
        next_watch = watch.clock() + WATCHDOG_SEC
        next_checkpoint = watch.clock() + CHECKPOINT_SEC
        while engine.running and not cancel.is_set():
            try:
                stream_media.check_media_pump()
                viewer = engine.viewer_engine
                alt_error = alt_viewer.check_alt_viewer(viewer, watch)
                if alt_error:
                    dropped = self._drop_rejected_alt(engine, viewer)
                    status = {"status": "idle", "run": run, "error": alt_error, **({"dropped": True} if dropped else {})}
                    emit("alt-status", status)
                    last_alt = "idle"
                counted = float(getattr(engine, "counted_stream_seconds", 0.0) or 0.0)
                emit("viewers", {"count": engine.get_viewer_count(), "counted": counted, "run": run})
                alt = alt_viewer.alt_viewer_status(engine.viewer_engine)
                if alt != last_alt:
                    emit("alt-status", {"status": alt, "run": run})
                    last_alt = alt
                if not engine.running:
                    break
                now = watch.clock()
                if now >= next_watch:
                    next_watch = now + WATCHDOG_SEC
                    stream_watch.watch_connections(engine, watch)
                if now >= next_checkpoint:
                    next_checkpoint = now + CHECKPOINT_SEC
                    stream_hours.checkpoint_stream(engine)
            except Exception as exc:
                detail(f"viewer tick: {type(exc).__name__}: {exc}")
            cancel.wait(VIEWER_TICK_SEC)
        emit("alt-status", {"status": "idle", "run": run})

    def handle_stop_stream(self, msg_id: str, params: dict) -> None:
        engine = self.stream_engine
        if self._stop_run("stream", params) and engine:
            engine.running = False
        reply(msg_id, {"ok": True})
