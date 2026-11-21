from __future__ import annotations

import re
import time

from bridge.protocol import log

_CONSOLE_RULES: tuple = (
    ("code 4004", ("auth_rejected", None, None)),
    ("option 4 or 5", (None, None, None)),
    ("fatal gateway error", ("fatal_gateway", None, None)),
    ("user manually disconnected", ("left_vc", None, None)),
    ("user moved to another voice channel", ("moved_vc", None, None)),
    ("stream stopped repeatedly", ("repeated_stops", None, None)),
    ("voice server closed", (None, None, None)),
    ("no viewers detected", (None, "warning", "Nobody is watching yet, so hours aren't counting.")),
    ("have an alt or friend join", (None, "info", "Connect an alt in the Alt viewer section, or ask a friend to join the voice channel.")),
    ("detected in voice channel", (None, "info", "Someone is in the voice channel, so hours are counting.")),
    ("viewer joined voice channel", (None, "info", "A viewer joined. Hours are counting again.")),
    ("all viewers left", (None, "warning", "Everyone left the voice channel. Hours are paused until someone watches.")),
    ("transmitting real video and audio", (None, "info", "Sending the video with sound, on a loop.")),
    ("video file not found", (None, "warning", "The video file is missing, so the stream sends silence.")),
    ("failed to start ffmpeg pump", (None, "warning", "FFmpeg didn't start, so the stream sends silence instead of the video.")),
    ("cryptography package is missing", (None, "error", "A part the video stream needs is missing. Reinstall Badge Maximizer.")),
    ("encryption key or udp socket missing", (None, "warning", "The media connection wasn't ready, so the stream sends silence.")),
    ("stream stopped by server, re-requesting", (None, "warning", "Discord stopped the stream. Starting it again.")),
    ("reconnecting to gateway", ("reconnecting", "warning", "Lost the connection to Discord. Reconnecting.")),
    ("reconnected successfully", (None, "info", "Reconnected to Discord.")),
    ("session resumed", (None, "info", "Reconnected to Discord.")),
    ("badge progression typically syncs", (None, "info", "Discord can take 24 to 48 hours to show new hours on the badge.")),
    ("connection stalled", (None, "warning", "The voice connection stalled. Joining the channel again.")),
    ("voice websocket handshake failed", (None, "warning", "Couldn't connect to Discord's voice server. Trying again.")),
    ("stream media connection handshake failed", (None, "warning", "Couldn't connect to Discord's stream server.")),
    ("udp discovery failed", (None, "warning", "Couldn't set up the media route, so viewers may not see the stream.")),
    ("discord requires at least 1 other user", (None, None, None)),
    ("falling back to silent audio pump", (None, None, None)),
    ("ws connect failed", (None, None, None)),
    ("no hello from voice server", (None, None, None)),
    ("no ready from voice server", (None, None, None)),
    ("heartbeat failed", (None, None, None)),
    ("connection dropped", (None, None, None)),
    ("gateway closed connection", (None, None, None)),
    ("requested gateway reconnect", (None, None, None)),
    ("session invalidated", (None, None, None)),
    ("did not receive hello", (None, None, None)),
    ("ready not received", (None, None, None)),
    ("reconnect attempt", (None, None, None)),
    ("resume failed", (None, None, None)),
    ("empty voice server endpoint", (None, None, None)),
    ("stream create send error", (None, None, None)),
    ("voice server update received", (None, None, None)),
)
_GLYPHS = re.compile(
    "[•·›ℹ←-⇿⌀-⏿①-➿⤀-⯿"
    "️‍\U0001f000-\U0001faff]"
)
_NOT_FOR_USERS = re.compile(
    r"[A-Za-z0-9_\-.]{24,}|\d{17,20}|wss?://|https?://"
    r"|\b(?:token|cookie|session|ssrc|stream_key|endpoint|opcode|op \d+|heartbeat|authenticated|nonce|dave)\b",
    re.IGNORECASE,
)
_SHOUTING = re.compile(r"\b[A-Z]{4,}\b")
REPEAT_QUIET_SEC = 30.0


def _plain_console_text(detail: str) -> str:
    text = _GLYPHS.sub("", detail)
    text = re.sub(r"\s+[\u2014\u2013]\s+|\s+-\s+", ", ", text)
    text = text.replace("!", ".").replace("...", ".")
    text = _SHOUTING.sub(lambda m: m.group(0).lower(), text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    text = re.sub(r"\.{2,}", ".", text)
    if not text:
        return ""
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "?")) else text + "."


class ConsoleProxy:
    RED = ""
    ORANGE = ""
    GREEN = ""
    YELLOW = ""
    CYAN = ""
    WHITE = ""
    GREY = ""
    MAGENTA = ""
    RESET = ""

    def __init__(self) -> None:
        self.flags: set = set()
        self._recent: dict = {}

    def _say(self, level: str, detail: str) -> None:
        lowered = detail.lower()
        for needle, (flag, rule_level, sentence) in _CONSOLE_RULES:
            if needle not in lowered:
                continue
            if flag == "reconnecting":
                if "(attempt 1)" not in lowered:
                    return
            elif flag:
                self.flags.add(flag)
            if sentence:
                self._send(rule_level, sentence)
            return
        if level == "info" or _NOT_FOR_USERS.search(detail):
            return
        text = _plain_console_text(detail)
        if text:
            self._send(level, text)

    def _send(self, level: str, text: str) -> None:
        now = time.monotonic()
        if now - self._recent.get(text, -REPEAT_QUIET_SEC) < REPEAT_QUIET_SEC:
            return
        self._recent[text] = now
        log(text, level)

    def ok(self, _target: str, detail: str) -> None:
        self._say("info", str(detail))

    def sent(self, _target: str, detail: str) -> None:
        self._say("info", str(detail))

    def live(self, _target: str, detail: str) -> None:
        self._say("info", str(detail))

    def warn(self, _target: str, detail: str) -> None:
        self._say("warning", str(detail))

    def err(self, _target: str, detail: str) -> None:
        self._say("error", str(detail))

    def info(self, target_or_detail: str, detail: str = "") -> None:
        self._say("info", str(detail or target_or_detail))

    def rule(self, _char: str = "-", _color: str | None = None) -> None:
        pass

    def print_separator(self, _char: str = "-") -> None:
        pass

    def clear(self) -> None:
        pass

    def banner(self) -> None:
        pass

    @staticmethod
    def get_terminal_size() -> int:
        return 80

    def create_border(self, char: str = "=") -> str:
        return char * 46

    def separator(self, _char: str = "-") -> None:
        pass

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        if name.isupper():
            return ""
        return lambda *args, **kwargs: self._say("info", " ".join(str(a) for a in args[1:]))
