from __future__ import annotations

import http.client
import socket
import ssl
import urllib.error

from bridge.diagnostics import detail, detail_exception

REINSTALL_TEXT = "Install Badge Maximizer again."

CLOSING_TEXT = "The app is closing."

REASON_NO_CONNECTION = "no connection to Discord"
REASON_UNREADABLE = "Discord sent an answer the app couldn't read"
REASON_FILE = "a file the app couldn't read or write"
REASON_UNEXPECTED = "an unexpected error"
REASON_REDIRECT = "Discord sent the request to another address"
UNEXPECTED_ACCOUNT_TEXT = "Discord sent an unexpected account ID. Log in again."


class _Friendly(RuntimeError):
    pass


def _friendly_http_error(exc: Exception, who: str = "this login") -> _Friendly:
    if isinstance(exc, _Friendly):
        return exc
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return _Friendly(f"Discord didn't accept {who}. Log in again.")
        if exc.code == 429:
            return _Friendly("Discord is rate limiting this account. Wait a few minutes and try again.")
        if 500 <= exc.code <= 599:
            return _Friendly(f"Discord is having problems right now (HTTP {exc.code}). Try again later.")
        if 300 <= exc.code <= 399:
            return _Friendly(f"{REASON_REDIRECT}, which the app doesn't follow. Try again later.")
        return _Friendly(f"Discord refused the request (HTTP {exc.code}). Try again later.")
    if plain_reason(exc) == REASON_NO_CONNECTION:
        return _Friendly("Couldn't reach Discord. Check your internet connection.")
    detail(f"discord request: {type(exc).__name__}: {exc}")
    return _Friendly("Discord sent an answer the app couldn't read. Try again in a minute.")


def plain_reason(exc: BaseException) -> str:
    if type(exc) is RuntimeError and exc.__cause__ is not None:
        exc = exc.__cause__
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return "Discord no longer accepts this login"
        if 300 <= exc.code <= 399:
            return REASON_REDIRECT
        return f"Discord refused the request (HTTP {exc.code})"
    if isinstance(exc, (urllib.error.URLError, ConnectionError, TimeoutError, socket.error, ssl.SSLError,
                        http.client.HTTPException)):
        if isinstance(exc, OSError) and getattr(exc, "filename", None) and not isinstance(exc, urllib.error.URLError):
            return REASON_FILE
        return REASON_NO_CONNECTION
    if isinstance(exc, (ValueError, KeyError)):
        return REASON_UNREADABLE
    return REASON_UNEXPECTED


def user_message(exc: BaseException, action: str) -> str:
    if isinstance(exc, _Friendly):
        return str(exc)
    cause = exc.__cause__ if type(exc) is RuntimeError else None
    if isinstance(cause, urllib.error.HTTPError) and cause.code in (401, 403):
        return "Discord no longer accepts this login. Log out and log in again."
    detail_exception(f"{action}:", exc)
    return f"{action} ({plain_reason(exc)})."
