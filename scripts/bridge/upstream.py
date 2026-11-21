from __future__ import annotations

import importlib
import subprocess
import types

from bridge.protocol import _no_prompt, _quiet_print


def _refuse_install(*_args, **_kwargs) -> None:
    raise ImportError("installing packages at import time is turned off")


def _import_without_pip(name: str) -> types.ModuleType:
    real = subprocess.check_call
    subprocess.check_call = _refuse_install
    try:
        return importlib.import_module(name)
    finally:
        subprocess.check_call = real


import games as games_mod

stream_mod = _import_without_pip("stream")

stream_mod.input = _no_prompt
games_mod.input = _no_prompt
stream_mod.print = _quiet_print
games_mod.print = _quiet_print
