"""Generates Sunbird-style "do_..." node identifiers, matching
org.sunbird.graph.common.Identifier (knowledge-platform, Java) — needed
when a Python job creates a graph node directly instead of going through
a knowlg HTTP API that would normally assign the ID.
"""

import random
import time

_DEFAULT_ENVIRONMENT_ID = 10000000
_DEFAULT_SHARD_ID = "1"


def generate_identifier(
    graph_id: str = "domain", environment_id: int = _DEFAULT_ENVIRONMENT_ID, shard_id: str = _DEFAULT_SHARD_ID
) -> str:
    """Builds a "do_..." identifier: <graph_id prefix>_<env><millis<<13><shard><rand>.

    Mirrors Identifier.getIdentifier(graphId, Identifier.getUniqueIdFromTimestamp())
    exactly, except for the trailing counter — the Java side uses an
    in-process AtomicInteger to disambiguate IDs generated in the same
    millisecond; a random 3-digit suffix serves the same purpose here
    without needing shared state across Flink subtasks/restarts.

    Args:
        graph_id: The graph name whose first two characters prefix the
            identifier (e.g. "domain" -> "do").
        environment_id: Matches the deployment's own environment.id config
            (Platform.config, knowledge-platform) — only the millions digit
            is used, same as the Java implementation.
        shard_id: Matches the deployment's own shard.id config.

    Returns:
        A "do_..." style identifier string.
    """
    prefix = graph_id[:2] if len(graph_id) >= 2 else graph_id
    env = environment_id // 10000000
    millis = int(time.time() * 1000) << 13
    counter = random.randint(100, 999)
    return f"{prefix}_{env}{millis}{shard_id}{counter}"
