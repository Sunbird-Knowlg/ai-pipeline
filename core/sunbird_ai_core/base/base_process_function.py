import logging

from pyflink.datastream import ProcessFunction

from sunbird_ai_core.base.base_job_config import BaseJobConfig
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient
from sunbird_ai_core.storage.blob_util import BlobStorageUtil


class BaseProcessFunction(ProcessFunction):
    """Abstract base process function managing the lifecycle of external services.

    This class provides automatic initialization and teardown of connections to 
    JanusGraph, Cloud Blob Storage, and Knowlg API clients per Flink TaskManager subtask. 
    Subclasses are expected to override PyFlink's standard `process_element` 
    method to implement their stream transformation logic.

    Attributes:
        graph (JanusGraphUtil | None): Connection utility for interacting with JanusGraph.
        storage (BlobStorageUtil | None): Client utility for reading/writing cloud storage.
        knowlg (KnowlgClient | None): API client for communicating with the Knowlg service.
        logger (logging.Logger | None): Subtask-specific logger instance.
    """

    def __init__(self, config: BaseJobConfig):
        """Initializes the base process function with job configuration.

        Args:
            config: Loaded job configuration settings.
        """
        self._config = config
        self.graph: JanusGraphUtil | None = None
        self.storage: BlobStorageUtil | None = None
        self.knowlg: KnowlgClient | None = None
        self.logger: logging.Logger | None = None

    def open(self, runtime_context) -> None:
        """Initializes external service connections when the subtask starts.

        This method is called by Flink before any stream processing begins on 
        the task manager slot. It establishes connections to JanusGraph, cloud 
        storage, and the Knowlg client.

        Args:
            runtime_context: Flink runtime context for the running subtask.
        """
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
            public_endpoint=self._config.raw("cloud_storage_public_endpoint", ""),
        )

        self.knowlg = KnowlgClient(
            content_service_url=self._config.knowlg_content_service_url,
            api_key=self._config.knowlg_api_key,
            apis=self._config.knowlg_apis,
        )

    def close(self) -> None:
        """Cleans up and closes active connections when the subtask stops.

        This method is called by Flink when the operator's execution finishes.
        """
        if self.graph is not None:
            self.graph.close()

    def emit_to_dlq(self, event, error: Exception, ctx, output_tag):
        """Wraps a failed stream event with metadata and sends it to a Dead Letter Queue (DLQ).

        Due to PyFlink 1.20's `ProcessFunction.Context` lacking a direct `.output()` 
        method, side outputs must be yielded. Consequently, callers of this method 
        must use the `yield from` syntax (e.g., `yield from self.emit_to_dlq(...)`).

        Args:
            event: The original input record/event that failed processing.
            error: The Exception that caused the failure.
            ctx: The PyFlink processing context.
            output_tag: The Flink OutputTag used to route records to the DLQ stream.

        Yields:
            tuple[OutputTag, str]: A tuple containing the OutputTag and the JSON-serialized
            DlqEnvelope containing the original event and error information.
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
