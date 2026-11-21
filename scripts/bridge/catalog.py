from __future__ import annotations

import os
import tempfile
import time
import urllib.request
from pathlib import Path

from bridge import state_files
from bridge.diagnostics import detail
from bridge.protocol import log
from bridge.upstream import games_mod

CATALOG_MAX_AGE_SEC = 7 * 24 * 3600
CATALOG_TIMEOUT_SEC = 30
_CATALOG_MEMO: dict = {"key": None, "titles": []}


def _parse_catalog(raw: str) -> list:
    try:
        return games_mod.parse_catalog_entries(raw)
    except Exception:
        return []


def _download_catalog() -> str:
    request = urllib.request.Request(games_mod.DISCORD_CATALOG_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=CATALOG_TIMEOUT_SEC) as resp:
        return resp.read().decode("utf-8")


def _write_catalog(path: Path, raw: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                out.write(raw)
            state_files._replace(temp, path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise
    except OSError as exc:
        detail(f"games list save: {type(exc).__name__}: {exc}")


def _catalog_key(path: Path) -> tuple:
    try:
        info = path.stat()
    except OSError:
        return None, 0.0
    return (str(path), info.st_mtime_ns, info.st_size), info.st_mtime


def load_catalog(now=time.time) -> list:
    path = Path(games_mod.DATABASE_STORAGE_PATH)
    key, mtime = _catalog_key(path)
    fresh = key is not None and now() - mtime < CATALOG_MAX_AGE_SEC
    cached: list = []
    if key is not None and key == _CATALOG_MEMO["key"]:
        cached = _CATALOG_MEMO["titles"]
    elif key is not None:
        try:
            cached = _parse_catalog(path.read_bytes().decode("utf-8"))
        except (OSError, ValueError):
            cached = []
        _CATALOG_MEMO.update(key=key, titles=cached)
    if cached and fresh:
        return cached
    try:
        raw = _download_catalog()
        titles = _parse_catalog(raw)
    except Exception as exc:
        detail(f"games list download: {type(exc).__name__}: {exc}")
        titles = []
    if titles:
        _write_catalog(path, raw)
        _CATALOG_MEMO.update(key=_catalog_key(path)[0], titles=titles)
        return titles
    if cached:
        log("Couldn't refresh the detectable games list, so the saved copy is used.", "warning")
    return cached
