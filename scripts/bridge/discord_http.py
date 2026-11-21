from __future__ import annotations

import json
import threading
import urllib.parse
import urllib.request

from bridge.diagnostics import detail
from bridge.errors import _Friendly, _friendly_http_error
from bridge.upstream import games_mod


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)

_RESPONSE_INFO = threading.local()
MAX_RETRY_WAIT_SEC = 60.0


class _RetryAfterRecorder(urllib.request.BaseHandler):
    handler_order = 400

    def https_response(self, _request, response):
        code = response.getcode()
        _RESPONSE_INFO.retry_after = response.headers.get("Retry-After") if code == 429 else None
        return response

    http_response = https_response


def _parse_retry_after(value) -> float | None:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds != seconds or seconds < 0:
        return None
    return min(seconds, MAX_RETRY_WAIT_SEC)


SECRET_HEADERS = frozenset({"authorization", "cookie"})


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        carries_secret = any(name.lower() in SECRET_HEADERS for name, _ in req.header_items())
        other_host = (new.hostname or "").lower() != (old.hostname or "").lower()
        if new.scheme != "https" or (carries_secret and other_host):
            detail(f"refused a redirect from {old.hostname} to {new.scheme}://{new.hostname}")
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


urllib.request.install_opener(urllib.request.build_opener(_SafeRedirect, _RetryAfterRecorder))


def _discord_headers(token: str, props: str = "", user_agent: str | None = None) -> dict:
    headers = {"authorization": token, "user-agent": user_agent or games_mod.USER_AGENT_IDENTIFIER}
    if props:
        headers["x-super-properties"] = props
    return headers


def _get_json(url: str, headers: dict, timeout: float, *, expect: tuple = (dict,),
              who: str = "this login") -> dict | list:
    try:
        request = urllib.request.Request(url, headers=headers)
        with _OPENER.open(request, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise _friendly_http_error(exc, who) from None
    if not isinstance(data, expect):
        raise _Friendly("Discord sent an answer the app couldn't read. Try again in a minute.")
    return data
