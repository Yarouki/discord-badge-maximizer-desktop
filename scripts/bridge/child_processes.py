from __future__ import annotations

import os
import subprocess
import sys

FFMPEG_NAMES = ("ffmpeg", "ffmpeg.exe")
_real_popen = subprocess.Popen


def _find_on_path(name: str, path_value: str, cwd: str) -> str | None:
    names = [name + ".exe", name] if sys.platform == "win32" else [name]
    here = os.path.normcase(os.path.abspath(cwd))
    for folder in path_value.split(os.pathsep):
        folder = folder.strip().strip('"')
        if not folder or not os.path.isabs(folder) or os.path.normcase(os.path.abspath(folder)) == here:
            continue
        for candidate in names:
            full = os.path.join(folder, candidate)
            if os.path.isfile(full):
                return full
    return None


def resolve_ffmpeg(env=None, cwd: str | None = None) -> str | None:
    env = os.environ if env is None else env
    bundled = env.get("BADGE_FFMPEG") or ""
    if bundled and os.path.isabs(bundled) and os.path.isfile(bundled):
        return bundled
    if env.get("BADGE_FFMPEG_ONLY") == "1":
        return None
    return _find_on_path("ffmpeg", env.get("PATH", ""), cwd if cwd is not None else os.getcwd())


def _upstream_popen(args: list | tuple | str, **kwargs) -> subprocess.Popen:
    kwargs["stdin"] = subprocess.DEVNULL
    if isinstance(args, (list, tuple)) and args and os.path.basename(str(args[0])).lower() in FFMPEG_NAMES:
        path = resolve_ffmpeg()
        if not path:
            raise FileNotFoundError("FFmpeg was not found")
        args = [path, "-nostdin", *args[1:]]
        if sys.platform == "win32":
            kwargs["creationflags"] = (kwargs.get("creationflags", 0)
                                       | subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    return _real_popen(args, **kwargs)


class _SubprocessForUpstream:
    def __getattr__(self, name: str):
        return getattr(subprocess, name)

    @staticmethod
    def Popen(args, **kwargs):
        return _upstream_popen(args, **kwargs)
