from __future__ import annotations

import sys
import threading
import traceback

DETAIL_PREFIX = "detail: "
_ERR_LOCK = threading.Lock()


def detail(text: object) -> None:
    lines = str(text).splitlines() or [""]
    block = "".join(f"{DETAIL_PREFIX}{line}\n" for line in lines)
    stream = sys.stderr
    if stream is None:
        return
    with _ERR_LOCK:
        try:
            stream.write(block)
            stream.flush()
        except (OSError, ValueError):
            pass


def detail_exception(context: str, exc: BaseException | None = None) -> None:
    exc = exc if exc is not None else sys.exc_info()[1]
    trace = "".join(traceback.format_exception(exc)) if exc is not None else ""
    detail(f"{context}\n{trace}" if trace else context)


def _thread_excepthook(args) -> None:
    if args.exc_type is SystemExit:
        return
    detail_exception(f"uncaught error in thread {getattr(args.thread, 'name', '?')}:", args.exc_value)


def _main_excepthook(_exc_type, exc, _tb) -> None:
    detail_exception("uncaught error:", exc)


def install_excepthooks() -> None:
    threading.excepthook = _thread_excepthook
    sys.excepthook = _main_excepthook
