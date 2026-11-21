from __future__ import annotations

import re


def has_control_chars(value: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)


def normalize_cookie_header(raw: str | None) -> str:
    value = str(raw or "").strip()
    if value.lower().startswith("cookie:"):
        value = value[len("cookie:"):].strip()
    if value and "=" not in value:
        value = f"cf_clearance={value}"
    return value


DISCORD_ID = re.compile(r"[0-9]{17,20}")
MAX_HOURS_PER_GAME = 1000
MAX_RUN_ID = 2**53 - 1

ACCOUNT_ID = re.compile(r"[0-9]{5,25}")


def _run_id(params: dict) -> int:
    run = params.get("run", 0)
    valid = isinstance(run, int) and not isinstance(run, bool) and 0 <= run <= MAX_RUN_ID
    return run if valid else 0


def _whole_number(value: object, low: int, high: int) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if number != value:
        text = value.strip() if isinstance(value, str) else ""
        if not (text.isascii() and text.isdigit()):
            return None
    return number if low <= number <= high else None
