#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from bridge import adapter, selfcheck, state_files
from bridge.diagnostics import install_excepthooks
from bridge.protocol import use_private_stdin, use_protocol_stdout


if __name__ == "__main__":
    install_excepthooks()
    use_protocol_stdout()
    command_reader = use_private_stdin()
    if os.environ.get("BADGE_DATA_DIR"):
        state_files.configure_data_dir(os.environ["BADGE_DATA_DIR"])
    bridge = adapter.BridgeAdapter(commands=command_reader)
    bridge.startup_problem = selfcheck.startup_problem()
    bridge.run()
