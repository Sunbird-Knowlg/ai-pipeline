import logging
import os
from typing import Any

import yaml

logger = logging.getLogger(__name__)

ENV_PREFIX = "SUNBIRD_AI_"


class JobConfig:
    """Loads a YAML configuration file and supports environment variable overrides.

    This class parses a YAML configuration file into a dictionary and provides 
    methods to retrieve nested values using dotted-path keys (e.g., 'kafka.brokers'). 
    Any key path can be overridden by setting an environment variable prefixed with 
    `SUNBIRD_AI_` followed by the uppercase, underscore-separated key path (e.g., 
    `SUNBIRD_AI_KAFKA_BROKERS` overrides `kafka.brokers`).
    """

    def __init__(self, config_path: str):
        """Initializes the configuration reader and loads the YAML file contents.

        Args:
            config_path: The filesystem path to the YAML configuration file.
        """
        logger.info("Loading job config", extra={"config_path": config_path})
        with open(config_path, "r") as f:
            self._data: dict[str, Any] = yaml.safe_load(f) or {}
        logger.debug(
            "Job config loaded",
            extra={"config_path": config_path, "top_level_keys": list(self._data.keys())},
        )

    def get(self, dotted_key: str, default: Any = None) -> Any:
        """Retrieves a configuration value by its dotted path, checking for env overrides first.

        This method first constructs an environment variable name by converting the 
        dotted key to uppercase, replacing dots with underscores, and prefixing it 
        with `SUNBIRD_AI_`. If that environment variable is set, its value is 
        returned. Otherwise, the method traverses the loaded YAML dictionary structure 
        to find the value.

        Args:
            dotted_key: The dotted path to the configuration key (e.g., 'kafka.brokers').
            default: The default value to return if the key is not found.

        Returns:
            The configuration value, the environment override value, or the default value.
        """
        env_key = ENV_PREFIX + dotted_key.upper().replace(".", "_")
        if env_key in os.environ:
            logger.debug(
                "Config key overridden by env var",
                extra={"dotted_key": dotted_key, "env_key": env_key},
            )
            return os.environ[env_key]

        node: Any = self._data
        for part in dotted_key.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def get_required(self, dotted_key: str) -> Any:
        """Retrieves a configuration value by its dotted path and raises an error if missing.

        Args:
            dotted_key: The dotted path to the configuration key.

        Returns:
            The resolved configuration value.

        Raises:
            KeyError: If the key path does not resolve to any value.
        """
        value = self.get(dotted_key)
        if value is None:
            logger.error("Missing required config key", extra={"dotted_key": dotted_key})
            raise KeyError(f"Missing required config key: {dotted_key}")
        return value
