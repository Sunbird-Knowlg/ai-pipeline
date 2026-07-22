import os
from typing import Any

import yaml

ENV_PREFIX = "SUNBIRD_AI_"


class JobConfig:
    """YAML config with env-var overrides.

    Any key path can be overridden by an env var named
    SUNBIRD_AI_<KEY>_<PATH> (dots -> underscores, upper-cased).
    e.g. kafka.brokers -> SUNBIRD_AI_KAFKA_BROKERS
    """

    def __init__(self, config_path: str):
        with open(config_path, "r") as f:
            self._data: dict[str, Any] = yaml.safe_load(f) or {}

    def get(self, dotted_key: str, default: Any = None) -> Any:
        env_key = ENV_PREFIX + dotted_key.upper().replace(".", "_")
        if env_key in os.environ:
            return os.environ[env_key]

        node: Any = self._data
        for part in dotted_key.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def get_required(self, dotted_key: str) -> Any:
        value = self.get(dotted_key)
        if value is None:
            raise KeyError(f"Missing required config key: {dotted_key}")
        return value
