from sunbird_ai_core.config.job_config import JobConfig


class BaseJobConfig:
    """Typed accessors over JobConfig for the fields every job needs."""

    def __init__(self, config_path: str):
        self._config = JobConfig(config_path)

    @property
    def job_name(self) -> str:
        return self._config.get_required("job.name")

    @property
    def parallelism(self) -> int:
        return int(self._config.get("job.parallelism", 1))

    @property
    def kafka_brokers(self) -> str:
        return self._config.get_required("kafka.brokers")

    @property
    def kafka_group_id(self) -> str:
        return self._config.get_required("kafka.group_id")

    def kafka_topic(self, topic_key: str) -> str:
        return self._config.get_required(f"kafka.topics.{topic_key}")

    @property
    def janusgraph_host(self) -> str:
        return self._config.get_required("janusgraph.host")

    @property
    def janusgraph_port(self) -> int:
        return int(self._config.get("janusgraph.port", 8182))

    @property
    def schema_base_path(self) -> str:
        return self._config.get_required("schema.base_path")

    @property
    def knowlg_content_service_url(self) -> str:
        return self._config.get_required("knowlg.content_service_url")

    @property
    def knowlg_api_key(self) -> str:
        # Optional — internal calls to the knowlg platform require no auth.
        return self._config.get("knowlg.api_key", "")

    @property
    def knowlg_apis(self) -> dict[str, str]:
        return self._config.get("knowlg.apis", {})

    @property
    def cloud_storage_type(self) -> str:
        return self._config.get_required("cloud_storage_type")

    @property
    def cloud_storage_auth_type(self) -> str:
        return self._config.get_required("cloud_storage_auth_type")

    @property
    def cloud_storage_container(self) -> str:
        return self._config.get_required("cloud_storage_container")

    def raw(self, dotted_key: str, default=None):
        return self._config.get(dotted_key, default)
