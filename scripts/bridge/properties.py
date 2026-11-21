from __future__ import annotations

import base64
import json
import uuid

from bridge.diagnostics import detail
from bridge.upstream import games_mod, stream_mod

MAX_PROPERTIES_BYTES = 8192
_original_assemble_super_properties = None
_original_build_super_props = None


def _properties_ok(props: object) -> bool:
    if not isinstance(props, dict) or not props:
        return False
    if not all(isinstance(k, str) and (v is None or isinstance(v, (str, int, float, bool))) for k, v in props.items()):
        return False
    return len(json.dumps(props, separators=(",", ":"))) <= MAX_PROPERTIES_BYTES


def _decoded_properties(encoded: object) -> object:
    try:
        return json.loads(base64.b64decode(str(encoded), validate=True))
    except (ValueError, TypeError):
        return None


def _local_properties(base: dict, signature: str, heartbeat: str) -> tuple:
    props = dict(base)
    props["client_launch_id"] = str(uuid.uuid4())
    props["launch_signature"] = signature
    props["client_heartbeat_session_id"] = heartbeat
    return base64.b64encode(json.dumps(props, separators=(",", ":")).encode("utf-8")).decode("ascii"), props


def _checked_assemble_super_properties(signature_id: str, session_id: str) -> str:
    try:
        encoded = _original_assemble_super_properties(signature_id, session_id)
        if _properties_ok(_decoded_properties(encoded)):
            return encoded
    except Exception as exc:
        detail(f"client properties: {type(exc).__name__}: {exc}")
    return _local_properties(games_mod.generate_fallback_properties(), signature_id, session_id)[0]


def _checked_build_super_props(launch_signature: str, heartbeat_session: str) -> tuple:
    try:
        encoded, props = _original_build_super_props(launch_signature, heartbeat_session)
        if _properties_ok(props) and _decoded_properties(encoded) == props:
            return encoded, props
    except Exception as exc:
        detail(f"client properties: {type(exc).__name__}: {exc}")
    return _local_properties(stream_mod._local_props(), launch_signature, heartbeat_session)
