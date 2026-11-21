from __future__ import annotations

import dataclasses
import json
import os
import re
import tempfile
import threading
import time
from dataclasses import asdict
from pathlib import Path

from bridge.checks import ACCOUNT_ID
from bridge.diagnostics import detail
from bridge.errors import _Friendly
from bridge.protocol import log
from bridge.upstream import games_mod, stream_mod

_STATE_LOCK = threading.RLock()
SECRET_FIELDS = frozenset({"token", "cookie", "analytics_token", "viewer_token"})
READ_TRIES = 3
READ_RETRY_SEC = 0.05
REPLACE_TRIES = 5
REPLACE_RETRY_SEC = 0.04

_SECRET_VALUE = re.compile(
    rb'("(?:' + b"|".join(re.escape(f.encode()) for f in sorted(SECRET_FIELDS)) + rb')"\s*:\s*)"(?:[^"\\]|\\.)*"?'
)


def _blank_secrets(raw: bytes) -> bytes:
    return _SECRET_VALUE.sub(rb'\1""', raw)


def _set_aside(path: Path, raw: bytes = b"") -> None:
    aside = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
    cleaned = _blank_secrets(raw)
    if cleaned == raw:
        os.replace(path, aside)
    else:
        aside.write_bytes(cleaned)
        os.unlink(path)
    log(f"The saved totals in {path.name} couldn't be read. The file was kept as {aside.name}, "
        "and the totals for it start again from zero.", "error")


def _read_json(path: Path) -> dict:
    with _STATE_LOCK:
        raw = b""
        for attempt in range(READ_TRIES):
            try:
                raw = path.read_bytes()
                break
            except FileNotFoundError:
                return {}
            except OSError:
                if attempt == READ_TRIES - 1:
                    raise
                time.sleep(READ_RETRY_SEC * (attempt + 1))
        try:
            loaded = json.loads(raw.decode("utf-8"))
        except ValueError:
            loaded = None
        if isinstance(loaded, dict):
            return loaded
        _set_aside(path, raw)
        return {}


def _replace(temp: str, path: Path) -> None:
    for attempt in range(REPLACE_TRIES):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == REPLACE_TRIES - 1:
                raise
            time.sleep(REPLACE_RETRY_SEC * (attempt + 1))


def _merge_write(path: Path, data: dict, keep_secrets: bool = False) -> None:
    with _STATE_LOCK:
        existing = {k: v for k, v in _read_json(path).items() if keep_secrets or k not in SECRET_FIELDS}
        existing.update({k: v for k, v in data.items() if k not in SECRET_FIELDS})
        handle, temp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                out.write(json.dumps(existing, separators=(",", ":")))
                out.flush()
                os.fsync(out.fileno())
            _replace(temp, path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise


def bind_state_file(state: object, path: Path) -> None:
    state._state_file = path


def _games_persist(self) -> None:
    _merge_write(getattr(self, "_state_file", None) or games_mod.STATE_STORAGE_PATH, asdict(self))


def _stream_save(self) -> None:
    _merge_write(getattr(self, "_state_file", None) or stream_mod.STATE_FILE,
                 {**asdict(self), "pending_stream_seconds": 0})


DATA_DIR: dict = {"path": None}
_DEFAULT_DATA_FOLDER = Path(games_mod.STATE_STORAGE_PATH).parent


def configure_data_dir(path: str) -> None:
    folder = Path(path)
    folder.mkdir(parents=True, exist_ok=True)
    DATA_DIR["path"] = folder
    games_mod.STATE_STORAGE_PATH = folder / "session.json"
    stream_mod.STATE_FILE = folder / "session.json"
    games_mod.DATABASE_STORAGE_PATH = folder / "games.json"


def _data_folder() -> Path:
    return DATA_DIR["path"] or _DEFAULT_DATA_FOLDER


def account_file(user_id: str) -> Path:
    if not ACCOUNT_ID.fullmatch(str(user_id or "")):
        raise ValueError("not a Discord account ID")
    folder = _data_folder() / "accounts"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{user_id}.json"
    _take_over_old_totals(target, user_id)
    read_account_data(target)
    return target


def read_account_data(target: Path) -> dict:
    try:
        return _read_json(target)
    except OSError as exc:
        detail(f"account file: {type(exc).__name__}: {exc}")
        raise _Friendly("Couldn't read this account's saved totals. Close any program that has files in "
                        "the app's data folder open, then log in again.") from None


def state_from_saved(klass: type, saved: dict) -> object:
    names = {f.name for f in dataclasses.fields(klass)}
    return klass(**{k: v for k, v in saved.items() if k in names})


def use_account_files(user_id: str) -> Path:
    target = account_file(user_id)
    games_mod.STATE_STORAGE_PATH = target
    stream_mod.STATE_FILE = target
    return target


LEGACY_MARKERS = ("totals_moved_to", "totals_owner")


def _legacy_owner(old: dict) -> str:
    owner = str(old.get("totals_owner") or "")
    if ACCOUNT_ID.fullmatch(owner):
        return owner
    from_token = games_mod.extract_account_snowflake(str(old.get("token") or ""))
    return from_token if ACCOUNT_ID.fullmatch(from_token) else ""


def _take_over_old_totals(target: Path, user_id: str) -> None:
    legacy = _data_folder() / "session.json"
    with _STATE_LOCK:
        if not legacy.exists():
            return
        old = _read_json(legacy)
        moved_to = old.get("totals_moved_to")
        if not old or target.exists() or (moved_to and moved_to != user_id):
            strip_legacy_secrets(legacy, old)
            return
        if not moved_to:
            owner = _legacy_owner(old)
            if owner and owner != user_id:
                strip_legacy_secrets(legacy, old)
                return
            _merge_write(legacy, {"totals_moved_to": user_id}, keep_secrets=LEGACY_IMPORT["pending"])
        _merge_write(target, {k: v for k, v in old.items() if k not in LEGACY_MARKERS})


LEGACY_IMPORT: dict = {"pending": False}


def strip_legacy_secrets(legacy: Path, old: dict) -> None:
    if LEGACY_IMPORT["pending"] or not SECRET_FIELDS & old.keys():
        return
    owner = _legacy_owner(old)
    try:
        _merge_write(legacy, {"totals_owner": owner} if owner else {})
    except OSError as exc:
        detail(f"legacy secrets: {type(exc).__name__}: {exc}")
