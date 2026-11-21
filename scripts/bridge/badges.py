from __future__ import annotations

import re

from bridge import discord_http
from bridge.checks import ACCOUNT_ID
from bridge.errors import UNEXPECTED_ACCOUNT_TEXT, _Friendly, user_message
from bridge.protocol import log, reply
from bridge.upstream import games_mod

BADGE_KINDS = {
    "gametime": re.compile(r"game[\s_-]*time|play[\s_-]*time|spielzeit", re.IGNORECASE),
    "variety": re.compile(r"variety|vielfalt", re.IGNORECASE),
    "stream": re.compile(r"(?<![a-z])stream(?:ing|er)?(?![a-z])|stream[\s_-]*time", re.IGNORECASE),
}
TIER_WORDS = r"(?:tier|level|lvl|stufe|niveau|nivel|palier|livello|poziom|stage)"
TIER_IN_TEXT = re.compile(TIER_WORDS + r"\D{0,3}(?<!\d)(\d{1,3})(?!\d)", re.IGNORECASE)
LAST_STANDALONE_NUMBER = re.compile(r"(?<!\d)(\d{1,3})(?!\d)(?!.*\d)")
MAX_TIER = 10

ICON_HASH = re.compile(r"[0-9a-f]{32}")
BADGE_ICON_URL = "https://cdn.discordapp.com/badge-icons/{}.png"


def _tier_from(badge: dict) -> int | None:
    badge_id = str(badge.get("id") or "")
    description = str(badge.get("description") or "")
    for text, pattern in ((badge_id, TIER_IN_TEXT), (description, TIER_IN_TEXT), (badge_id, LAST_STANDALONE_NUMBER)):
        match = pattern.search(text)
        if match:
            tier = int(match.group(1))
            return tier if 1 <= tier <= MAX_TIER else None
    return None


def _kind_of(badge: dict) -> str | None:
    for text in (str(badge.get("id") or ""), str(badge.get("description") or "")):
        for kind, pattern in BADGE_KINDS.items():
            if pattern.search(text):
                return kind
    return None


def parse_progress_badges(badges: list) -> dict:
    tiers: dict = {kind: None for kind in BADGE_KINDS}
    for badge in badges or []:
        if not isinstance(badge, dict):
            continue
        kind = _kind_of(badge)
        tier = _tier_from(badge) if kind else None
        if kind and tier is not None and (tiers[kind] is None or tier > tiers[kind]):
            tiers[kind] = tier
    return tiers


def progress_badge_icons(badges: list) -> dict:
    earned: dict = {}
    for badge in badges or []:
        if not isinstance(badge, dict):
            continue
        kind = _kind_of(badge)
        if kind and kind not in earned:
            icon = str(badge.get("icon") or "")
            earned[kind] = BADGE_ICON_URL.format(icon) if ICON_HASH.fullmatch(icon) else ""
    return earned


class BadgesMixin:
    def forget_logged_badges(self) -> None:
        self._badges_logged = None

    def _fetch_profile(self) -> dict:
        token = self.state.token
        props = self._props()
        uid = self.user_id
        if not ACCOUNT_ID.fullmatch(uid):
            uid = games_mod.extract_account_snowflake(token)
        if not ACCOUNT_ID.fullmatch(uid):
            uid = str(self._fetch_identity(token, props).get("id", ""))
        if not ACCOUNT_ID.fullmatch(uid):
            raise _Friendly(UNEXPECTED_ACCOUNT_TEXT)
        url = f"{games_mod.DISCORD_USERS_API}/{uid}/profile?with_mutual_guilds=false&with_mutual_friends_count=false"
        return discord_http._get_json(url, discord_http._discord_headers(token, props), timeout=15)

    def handle_badges(self, msg_id: str, _params: dict) -> None:
        if not self.state or not self.state.token:
            reply(msg_id, error="Not logged in. Log in first.")
            return
        try:
            badges = self._fetch_profile().get("badges", []) or []
        except Exception as exc:
            reply(msg_id, {"ok": False, "error": user_message(exc, "Couldn't read your Discord profile"), "totals": self._totals()})
            return
        names = ", ".join(str(b.get("description") or b.get("id")) for b in badges if isinstance(b, dict))
        if names != self._badges_logged:
            self._badges_logged = names
            log(f"Profile badges: {names or 'none shown'}")
        reply(msg_id, {"ok": True, "tiers": parse_progress_badges(badges), "earned": progress_badge_icons(badges),
                       "totals": self._totals()})
