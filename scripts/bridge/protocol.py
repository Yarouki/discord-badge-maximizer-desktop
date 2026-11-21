from __future__ import annotations

import builtins
import io
import json
import os
import sys
import threading
from typing import TextIO

_OUT = sys.stdout
_OUT_LOCK = threading.Lock()


def _write(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    with _OUT_LOCK:
        _OUT.write(line + "\n")
        _OUT.flush()


class _Discard(io.TextIOBase):
    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        return len(text)


class _EnterForever(io.TextIOBase):
    encoding = "utf-8"

    def readable(self) -> bool:
        return True

    def readline(self, _size: int = -1) -> str:
        return "\n"

    def read(self, _size: int = -1) -> str:
        return ""


def use_protocol_stdout(out_fd: int = 1, err_fd: int = 2) -> None:
    global _OUT
    _OUT = os.fdopen(os.dup(out_fd), "w", encoding="utf-8", errors="replace", newline="\n")
    os.dup2(err_fd, out_fd)
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.stdout = _Discard()
    builtins.print = _quiet_print


def use_private_stdin(in_fd: int = 0) -> TextIO:
    commands = os.fdopen(os.dup(in_fd), "r", encoding="utf-8", errors="replace", newline="\n")
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, in_fd)
    os.close(devnull)
    sys.stdin = _EnterForever()
    builtins.input = _no_prompt
    return commands


def emit(event: str, data: dict) -> None:
    _write({"event": event, "data": data})


def reply(msg_id: str, result: dict | None = None, error: str | None = None) -> None:
    obj: dict = {"id": msg_id}
    if error is not None:
        obj["error"] = error
    else:
        obj["result"] = result if result is not None else {}
    _write(obj)


def log(text: str, level: str = "info") -> None:
    emit("log", {"type": level, "text": text})


def _no_prompt(*_args, **_kwargs) -> str:
    return ""


_REAL_PRINT = builtins.print


def _quiet_print(*args, file=None, **kwargs) -> None:
    if file is not None:
        _REAL_PRINT(*args, file=file, **kwargs)
