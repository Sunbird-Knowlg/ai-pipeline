import logging

from pyflink.datastream import ProcessFunction

from sunbird_ai_core.base.base_job_config import BaseJobConfig
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient
from sunbird_ai_core.storage.blob_util import BlobStorageUtil


class BaseProcessFunction(ProcessFunction):
    """Common lifecycle for job process functions: one JanusGraphUtil,
    BlobStorageUtil, KnowlgClient per TaskManager, initialized in open(),
    torn down in close(). Subclasses implement process_element().
    """

    def __init__(self, config: BaseJobConfig):
        self._config = config
        self.graph: JanusGraphUtil | None = None
        self.storage: BlobStorageUtil | None = None
        self.knowlg: KnowlgClient | None = None
        self.logger: logging.Logger | None = None

    def open(self, runtime_context) -> None:
        self.logger = logging.getLogger(self._config.job_name)
        self.logger.info(
            "Opening %s task %s", self._config.job_name, runtime_context.get_index_of_this_subtask()
        )

        self.graph = JanusGraphUtil(
            host=self._config.janusgraph_host,
            port=self._config.janusgraph_port,
            schema_base_path=self._config.schema_base_path,
        )
        self.graph.open()

        self.storage = BlobStorageUtil(
            cloud_storage_type=self._config.cloud_storage_type,
            cloud_storage_auth_type=self._config.cloud_storage_auth_type,
            container=self._config.cloud_storage_container,
            auth_config=self._config.raw("cloud_storage_auth", {}),
        )

        self.knowlg = KnowlgClient(
            content_service_url=self._config.knowlg_content_service_url,
            api_key=self._config.knowlg_api_key,
            apis=self._config.knowlg_apis,
        )

    def close(self) -> None:
        if self.graph is not None:
            self.graph.close()

    def emit_to_dlq(self, event, error: Exception, ctx, output_tag):
        """Wraps the original event with error metadata and emits it to the
        given Flink side-output tag. PyFlink 1.20's ProcessFunction.Context
        has no ctx.output() — side outputs are emitted by yielding
        (output_tag, value), so callers must do `yield from
        self.emit_to_dlq(...)` instead of calling this directly.
        """
        from sunbird_ai_core.kafka.event_schemas import DlqEnvelope

        envelope = DlqEnvelope(
            originalEvent=event.__dict__ if hasattr(event, "__dict__") else event,
            errorMessage=str(error),
            jobName=self._config.job_name,
        )
        assert self.logger is not None, "BaseProcessFunction.open() must be called before use"
        self.logger.error("Emitting to DLQ: %s", envelope.errorMessage)
        yield output_tag, envelope.to_json()
