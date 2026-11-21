from __future__ import annotations

import re

from bridge import discord_http
from bridge.checks import DISCORD_ID
from bridge.errors import user_message
from bridge.protocol import reply

VOICE_CHANNEL_TYPES = (2, 13)

SERVER_ICON_HASH = re.compile(r"(a_)?[0-9a-f]{32}")
SERVER_ICON_URL = "https://cdn.discordapp.com/icons/{}/{}.png?size=64"


def shared_servers(main_guilds, alt_guilds) -> list:
    alt_ids = None
    if alt_guilds is not None:
        alt_ids = {str(g.get("id")) for g in alt_guilds if isinstance(g, dict)}
    servers = []
    for guild in main_guilds or []:
        if not isinstance(guild, dict):
            continue
        gid = str(guild.get("id") or "")
        if not DISCORD_ID.fullmatch(gid) or (alt_ids is not None and gid not in alt_ids):
            continue
        servers.append({"id": gid, "name": str(guild.get("name") or gid), "icon": server_icon_url(gid, guild.get("icon"))})
    return sorted(servers, key=lambda g: g["name"].lower())


def server_icon_url(guild_id: str, icon) -> str:
    if not isinstance(icon, str) or not SERVER_ICON_HASH.fullmatch(icon):
        return ""
    return SERVER_ICON_URL.format(guild_id, icon)


def voice_channels(channels) -> list:
    found = []
    for ch in channels or []:
        if not isinstance(ch, dict) or ch.get("type") not in VOICE_CHANNEL_TYPES:
            continue
        cid = str(ch.get("id") or "")
        if not DISCORD_ID.fullmatch(cid):
            continue
        position = ch.get("position") if isinstance(ch.get("position"), int) else 0
        found.append((position, str(ch.get("name") or cid).lower(), {"id": cid, "name": str(ch.get("name") or cid)}))
    return [item for _, _, item in sorted(found, key=lambda f: (f[0], f[1]))]


class ServersMixin:
    def _props(self) -> str:
        return self.runtime_ctx.encoded_properties if self.runtime_ctx else ""

    def _discord_get(self, path: str, token: str, who: str = "this login") -> dict | list:
        return discord_http._get_json(f"https://discord.com/api/v9{path}", discord_http._discord_headers(token, self._props()), timeout=15,
                         expect=(dict, list), who=who)

    def handle_voice_servers(self, msg_id: str, _params: dict) -> None:
        if not self.state or not self.state.token:
            reply(msg_id, error="Not logged in. Log in first.")
            return
        alt_token = getattr(self.viewer_engine, "token", "") or ""
        try:
            main = self._discord_get("/users/@me/guilds", self.state.token)
        except Exception as exc:
            reply(msg_id, error=user_message(exc, "Couldn't load your servers"))
            return
        alt = None
        alt_problem = ""
        if alt_token:
            try:
                alt = self._discord_get("/users/@me/guilds", alt_token, "the alt account's login")
            except Exception as exc:
                alt_problem = (f"The alt account's servers couldn't be read: {user_message(exc, 'The request failed')} "
                               "All your servers are listed, so pick one the alt is on too.")
        stream_state = self.stream_state
        answer = {
            "ok": True,
            "servers": shared_servers(main if isinstance(main, list) else [], alt if isinstance(alt, list) or alt is None else []),
            "withAlt": bool(alt_token) and not alt_problem,
            "lastGuildId": stream_state.last_guild_id if stream_state else "",
            "lastChannelId": stream_state.last_channel_id if stream_state else "",
        }
        if alt_problem:
            answer["altProblem"] = alt_problem
        reply(msg_id, answer)

    def handle_voice_channels(self, msg_id: str, params: dict) -> None:
        if not self.state or not self.state.token:
            reply(msg_id, error="Not logged in. Log in first.")
            return
        guild_id = str(params.get("guildId") or "")
        if not DISCORD_ID.fullmatch(guild_id):
            reply(msg_id, error="That server ID isn't valid. Pick the server again.")
            return
        try:
            channels = self._discord_get(f"/guilds/{guild_id}/channels", self.state.token)
        except Exception as exc:
            reply(msg_id, error=user_message(exc, "Couldn't load the voice channels"))
            return
        reply(msg_id, {"ok": True, "channels": voice_channels(channels if isinstance(channels, list) else [])})
