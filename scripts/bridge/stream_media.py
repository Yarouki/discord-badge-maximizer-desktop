from __future__ import annotations

import os

from bridge import child_processes
from bridge.protocol import log
from bridge.upstream import stream_mod

STREAM_SETTINGS: dict = {"mode": "video", "media": "", "fallback": "", "pump": None}
_original_start_media_stream = None

VIDEO_NAMES = ("video.mp4", "hero_arena.mp4")
FFMPEG_MISSING_TEXT = "FFmpeg wasn't found, so the stream sends silence instead of the video."
VIDEO_MISSING_TEXT = "The video file wasn't found, so the stream sends silence instead of the video."
FFMPEG_FAILED_TEXT = "FFmpeg didn't start, so the stream sends silence instead of the video."


def _start_media_or_silence(self, video_path: str) -> bool:
    if STREAM_SETTINGS["mode"] == "silent":
        self.start_silence_pump()
        STREAM_SETTINGS["media"] = "silent"
        return True
    started = _original_start_media_stream(self, video_path)
    if started:
        STREAM_SETTINGS.update(media="video", pump=(self, getattr(self, "_media_pump", None)))
    else:
        STREAM_SETTINGS.update(media="silent", fallback=FFMPEG_FAILED_TEXT, pump=None)
    return started


def find_video_file() -> str | None:
    here = os.path.join(os.path.dirname(os.path.abspath(stream_mod.__file__)), "assets")
    for name in VIDEO_NAMES:
        for folder in (here, "assets"):
            candidate = os.path.join(folder, name)
            if os.path.exists(candidate):
                return candidate
    return None


def video_preflight(mode: str, ffmpeg_finder=None, video_finder=None) -> tuple:
    if mode != "video":
        return mode, ""
    if not (ffmpeg_finder or child_processes.resolve_ffmpeg)():
        return "silent", FFMPEG_MISSING_TEXT
    if not (video_finder or find_video_file)():
        return "silent", VIDEO_MISSING_TEXT
    return "video", ""


def check_media_pump() -> None:
    entry = STREAM_SETTINGS.get("pump")
    if not entry:
        return
    conn, pump = entry
    if not getattr(pump, "running", False) or getattr(conn, "_media_pump", None) is not pump:
        return
    processes = (getattr(pump, "v_proc", None), getattr(pump, "a_proc", None))
    if not any(p is not None and p.poll() is not None for p in processes):
        return
    STREAM_SETTINGS.update(pump=None, media="silent")
    conn.stop_media_stream()
    if getattr(conn, "running", False):
        conn.start_silence_pump()
    log("FFmpeg stopped, so the stream now sends silence instead of the video.", "warning")
