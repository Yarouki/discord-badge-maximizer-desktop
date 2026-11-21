from __future__ import annotations

import importlib.util
import inspect
import re
import threading

from bridge import (
    alt_viewer, catalog, child_processes, console, properties, state_files, stream_media, stream_watch,
)
from bridge.diagnostics import detail
from bridge.errors import REINSTALL_TEXT
from bridge.upstream import games_mod, stream_mod

REQUIRED_PACKAGES = (("cryptography", "cryptography", "HAS_CRYPTO"), ("dave", "dave.py", "HAS_DAVE"))


def missing_packages(find_spec=importlib.util.find_spec, stream: object = None) -> list:
    missing = []
    for module, package, flag in REQUIRED_PACKAGES:
        try:
            found = find_spec(module)
        except (ImportError, ValueError):
            found = None
        if found is None or (stream is not None and getattr(stream, flag, True) is not True):
            missing.append(package)
    return missing


def _is_compiled() -> bool:
    return "__compiled__" in globals()


def package_problem(missing: list, compiled: bool | None = None) -> str | None:
    if not missing:
        return None
    names = " and ".join(missing)
    if compiled if compiled is not None else _is_compiled():
        detail(f"missing packages: {names}")
        return f"A part the stream needs is missing. {REINSTALL_TEXT}"
    return (f"Python is missing {names}, which the stream needs. Run py -3.11 -m pip install -r requirements.txt "
            "without --user, from an administrator terminal if Python is installed for all users. "
            "The app doesn't see packages installed only for your user.")


MISSING_PACKAGES = missing_packages(stream=stream_mod)

PROMPT_TEST_SEC = 2.0


def prompt_self_test(timeout: float = PROMPT_TEST_SEC) -> str | None:
    finished = threading.Event()

    def end_of_stream() -> None:
        try:
            stream_mod.GatewayStreamEngine(stream_mod.State(), None, console.ConsoleProxy())._cleanup("")
        except Exception as exc:
            detail(f"prompt self-test: {type(exc).__name__}: {exc}")
        finally:
            finished.set()

    threading.Thread(target=end_of_stream, daemon=True).start()
    if finished.wait(timeout):
        return None
    return upstream_mismatch("stream.py", "its end-of-stream prompt still waits for input")


def upstream_mismatch(file: str, what: str) -> str:
    detail(f"self-check: {file}: {what}")
    return f"This version of {file} doesn't work with the app. {REINSTALL_TEXT}"


GAMES_NAMES = (
    "STATE_STORAGE_PATH", "DATABASE_STORAGE_PATH", "DISCORD_CATALOG_URL", "REST_IDENTITY_URL",
    "DISCORD_USERS_API", "USER_AGENT_IDENTIFIER", "DISPATCH_BATCH_LIMIT", "NETWORK_COOLDOWN_SEC",
    "extract_account_snowflake", "synchronize_credentials", "load_game_catalog", "parse_catalog_entries",
    "assemble_super_properties", "generate_fallback_properties",
    "AccountSessionState.restore", "AccountSessionState.persist", "AccountSessionState.requires_refresh",
    "RuntimeClientContext.initialize", "DetectableTitle",
    "TelemetryEventFabricator.assemble_complete_session", "TelemetryEventFabricator.post_telemetry_batch",
)
STREAM_NAMES = (
    "STATE_FILE", "ME_URL", "USER_AGENT", "GATEWAY_URL", "subprocess", "Console", "HAS_CRYPTO", "HAS_DAVE",
    "_user_id_from_token", "ensure_token", "build_super_props", "_local_props",
    "State.load", "State.save", "State.is_stale", "Session.new",
    "MiniWebSocket.connect", "MiniWebSocket.send", "MiniWebSocket.recv", "MiniWebSocket.close",
    "MediaStreamPump.start", "MediaStreamPump.stop",
    "VoiceConnection.start_media_stream", "VoiceConnection.stop_media_stream", "VoiceConnection.start_silence_pump",
    "ViewerEngine.start", "ViewerEngine.stop", "ViewerEngine.watch",
    "GatewayStreamEngine._event_loop", "GatewayStreamEngine._cleanup", "GatewayStreamEngine.get_viewer_count",
    "GatewayStreamEngine._force_rejoin_voice",
)
ENGINE_ATTRIBUTES = (
    "state", "ws", "running", "start_time", "counted_stream_seconds", "user_id", "stream_ever_active",
    "_stream_recreate_attempts", "_user_left_vc", "_was_already_in_vc", "ready_received", "guild_id",
    "channel_id", "channel_name", "voice_connected", "stream_connected", "viewer_engine", "_ticker_thread",
    "stream_key", "voice_conn", "stream_conn", "channel_members", "stream_viewer_ids",
    "_cached_supplemental_guilds",
)
VIEWER_ATTRIBUTES = ("token", "username", "running", "ws", "user_id", "stream_key", "_is_watching", "_thread",
                     "guild_id", "channel_id")
GAMES_FIELDS = ("token", "cookie", "analytics_token", "fetched_at", "used_games", "total_games_claimed",
                "total_hours_claimed")
STREAM_FIELDS = ("token", "cookie", "analytics_token", "fetched_at", "total_stream_hours_claimed",
                 "total_stream_sessions", "last_guild_id", "last_channel_id")
SECRET_LOOKING = re.compile(r"token|cookie|secret|password|key", re.IGNORECASE)
SIGNATURES = (
    ("stream.py", "GatewayStreamEngine.__init__", ("state", "session", "console")),
    ("stream.py", "ViewerEngine.__init__", ("token", "console")),
    ("stream.py", "GatewayStreamEngine._cleanup", ("guild_id",)),
    ("stream.py", "VoiceConnection.start_media_stream", ("video_path",)),
)


def _lookup(module: object, dotted: str) -> object:
    target = module
    for part in dotted.split("."):
        target = getattr(target, part)
    return target


def find_missing(module: object, names) -> list:
    missing = []
    for dotted in names:
        try:
            _lookup(module, dotted)
        except AttributeError:
            missing.append(dotted)
    return missing


def _unsupported(file: str, missing: list) -> str:
    return upstream_mismatch(file, f"{', '.join(missing[:3])} is missing")


def _parameters(func) -> tuple | None:
    try:
        params = list(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return None
    return tuple(params[1:]) if params and params[0] == "self" else tuple(params)


def _instance_problems(stream: object) -> list:
    try:
        engine = stream.GatewayStreamEngine(stream.State(), None, console.ConsoleProxy())
        viewer = stream.ViewerEngine("", console.ConsoleProxy())
    except Exception as exc:
        return [f"a working engine ({type(exc).__name__}: {exc})"]
    missing = [f"GatewayStreamEngine.{a}" for a in ENGINE_ATTRIBUTES if not hasattr(engine, a)]
    return missing + [f"ViewerEngine.{a}" for a in VIEWER_ATTRIBUTES if not hasattr(viewer, a)]


def upstream_problem(games: object, stream: object) -> str | None:
    for file, module, names in (("games.py", games, GAMES_NAMES), ("stream.py", stream, STREAM_NAMES)):
        missing = find_missing(module, names)
        if missing:
            return _unsupported(file, missing)
    for file, klass, fields in (("games.py", games.AccountSessionState, GAMES_FIELDS),
                                ("stream.py", stream.State, STREAM_FIELDS)):
        names = set(getattr(klass, "__dataclass_fields__", {}))
        missing = [f"{klass.__name__}.{f}" for f in fields if f not in names]
        if missing:
            return _unsupported(file, missing)
        unstripped = sorted(n for n in names if SECRET_LOOKING.search(n) and n not in state_files.SECRET_FIELDS)
        if unstripped:
            return upstream_mismatch(file, f"{', '.join(unstripped)} looks secret and isn't kept out of "
                                           "the state file")
    for file, dotted, expected in SIGNATURES:
        func = _lookup(stream, dotted)
        if func is stream_media._start_media_or_silence:
            func = stream_media._original_start_media_stream
        found = _parameters(func)
        if found is not None and found != expected:
            return upstream_mismatch(file, f"{dotted} takes different arguments")
    missing = _instance_problems(stream)
    if missing:
        return _unsupported("stream.py", missing)
    return None


def startup_problem() -> str | None:
    return UPSTREAM_PROBLEM or package_problem(MISSING_PACKAGES) or prompt_self_test()


def _install_patches() -> None:
    games_mod.AccountSessionState.persist = state_files._games_persist
    stream_mod.State.save = state_files._stream_save
    stream_media._original_start_media_stream = stream_mod.VoiceConnection.start_media_stream
    stream_mod.VoiceConnection.start_media_stream = stream_media._start_media_or_silence
    stream_mod.subprocess = child_processes._SubprocessForUpstream()
    games_mod.load_game_catalog = catalog.load_catalog
    stream_watch._original_recv = stream_mod.MiniWebSocket.recv
    stream_mod.MiniWebSocket.recv = stream_watch._recv_recording_close
    stream_mod.GatewayStreamEngine.get_viewer_count = alt_viewer._viewer_count
    properties._original_assemble_super_properties = games_mod.assemble_super_properties
    games_mod.assemble_super_properties = properties._checked_assemble_super_properties
    properties._original_build_super_props = stream_mod.build_super_props
    stream_mod.build_super_props = properties._checked_build_super_props


UPSTREAM_PROBLEM = upstream_problem(games_mod, stream_mod)


if UPSTREAM_PROBLEM is None:
    _install_patches()
