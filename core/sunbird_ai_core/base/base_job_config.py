from sunbird_ai_core.config.job_config import JobConfig


class BaseJobConfig:
    """Typed configuration reader and facade for Sunbird AI Flink jobs.

    This class wraps a raw `JobConfig` instance, providing clean, type-hinted 
    properties and helper methods to retrieve standard configurations used by 
    most Flink stream processing jobs (such as Kafka, JanusGraph, Knowlg APIs, 
    and Cloud Storage settings).
    """

    def __init__(self, config_path: str):
        """Initializes the configuration reader with a YAML config file.

        Args:
            config_path: The filesystem path to the YAML configuration file.
        """
        self._config = JobConfig(config_path)

    @property
    def job_name(self) -> str:
        """str: The configured unique name identifier of the Flink job."""
        return self._config.get_required("job.name")

    @property
    def parallelism(self) -> int:
        """int: The parallelism slot count for Flink operators (defaults to 1)."""
        return int(self._config.get("job.parallelism", 1))

    @property
    def checkpointing_interval_ms(self) -> int:
        """int: The interval in milliseconds between checkpoints (defaults to 60000)."""
        return int(self._config.get("job.checkpointing_interval_ms", 60000))

    @property
    def checkpointing_timeout_ms(self) -> int:
        """int: The maximum time in milliseconds a checkpoint is allowed to take (defaults to 60000)."""
        return int(self._config.get("job.checkpointing_timeout_ms", 60000))

    @property
    def restart_attempts(self) -> int:
        """int: The maximum number of restart attempts before job failure (defaults to 3)."""
        return int(self._config.get("job.restart_attempts", 3))

    @property
    def restart_delay_ms(self) -> int:
        """int: The delay duration in milliseconds between restart attempts (defaults to 10000)."""
        return int(self._config.get("job.restart_delay_ms", 10000))

    @property
    def kafka_brokers(self) -> str:
        """str: Comma-separated list of Kafka bootstrap brokers."""
        return self._config.get_required("kafka.brokers")

    @property
    def kafka_group_id(self) -> str:
        """str: The consumer group ID for Kafka consumer sources."""
        return self._config.get_required("kafka.group_id")

    def kafka_topic(self, topic_key: str) -> str:
        """Resolves the physical Kafka topic name associated with a logical key.

        Args:
            topic_key: The logical key reference in configuration for the topic.

        Returns:
            The resolved Kafka topic name.
        """
        return self._config.get_required(f"kafka.topics.{topic_key}")

    @property
    def janusgraph_host(self) -> str:
        """str: The hostname or IP address of the JanusGraph instance."""
        return self._config.get_required("janusgraph.host")

    @property
    def janusgraph_port(self) -> int:
        """int: The connection port for the JanusGraph server (defaults to 8182)."""
        return int(self._config.get("janusgraph.port", 8182))

    @property
    def schema_base_path(self) -> str:
        """str: The base directory path containing schema definition files."""
        return self._config.get_required("schema.base_path")

    @property
    def knowlg_content_service_url(self) -> str:
        """str: The API endpoint URL for the Knowlg Content Service."""
        return self._config.get_required("knowlg.content_service_url")

    @property
    def knowlg_api_key(self) -> str:
        """str: The authorization API key for Knowlg APIs (defaults to empty)."""
        # Optional — internal calls to the knowlg platform require no auth.
        return self._config.get("knowlg.api_key", "")

    @property
    def knowlg_apis(self) -> dict[str, str]:
        """dict[str, str]: A dictionary mapping Knowlg action names to their URI paths."""
        return self._config.get("knowlg.apis", {})

    @property
    def cloud_storage_type(self) -> str:
        """str: The cloud storage provider type (e.g., 'azure', 'aws', 'gcp')."""
        return self._config.get_required("cloud_storage_type")

    @property
    def cloud_storage_auth_type(self) -> str:
        """str: The authentication mechanism for cloud storage access."""
        return self._config.get_required("cloud_storage_auth_type")

    @property
    def cloud_storage_container(self) -> str:
        """str: The storage container or bucket name for operations."""
        return self._config.get_required("cloud_storage_container")

    def raw(self, dotted_key: str, default=None):
        """Retrieves an arbitrary configuration value using a dotted key path.

        Args:
            dotted_key: The hierarchical key path (e.g., 'cloud_storage_auth.key').
            default: The default value to return if the key path does not exist.

        Returns:
            The raw configuration value or the default value.
        """
        return self._config.get(dotted_key, default)
