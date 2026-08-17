import logging

from pyflink.common.serialization import SimpleStringSchema
from pyflink.common.watermark_strategy import WatermarkStrategy
from pyflink.datastream.connectors.kafka import (
    DeliveryGuarantee,
    KafkaOffsetResetStrategy,
    KafkaOffsetsInitializer,
    KafkaRecordSerializationSchema,
    KafkaSink,
    KafkaSource,
)
from sunbird_ai_core.base.base_flink_job import BaseFlinkJob

from enrichment_router.functions.router_function import (
    MULTILINGUAL_OUT_TAG,
    TRANSCRIPTION_OUT_TAG,
    RouterFunction,
)

logger = logging.getLogger(__name__)


class EnrichmentRouterJob(BaseFlinkJob):
    """Flink job that reads enriched.metadata and routes it into transcription
    and multilingual job-request streams via RouterFunction's side outputs.
    """

    def build_pipeline(self) -> None:
        """Wires the enriched.metadata source, RouterFunction, and the
        transcription/multilingual Kafka sinks into a single pipeline.
        """
        logger.info(
            "Building enrichment-router pipeline",
            extra={
                "input_topic": self.config.kafka_topic("input"),
                "transcription_out_topic": self.config.kafka_topic("transcription_out"),
                "multilingual_out_topic": self.config.kafka_topic("multilingual_out"),
            },
        )
        source = (
            KafkaSource.builder()
            .set_bootstrap_servers(self.config.kafka_brokers)
            .set_topics(self.config.kafka_topic("input"))
            .set_group_id(self.config.kafka_group_id)
            .set_starting_offsets(
                KafkaOffsetsInitializer.committed_offsets(KafkaOffsetResetStrategy.LATEST)
            )
            .set_value_only_deserializer(SimpleStringSchema())
            .build()
        )

        main_stream = self.env.from_source(
            source, watermark_strategy=WatermarkStrategy.no_watermarks(), source_name="enriched-metadata"
        )
        routed = main_stream.process(RouterFunction(self.config))

        transcription_stream = routed.get_side_output(TRANSCRIPTION_OUT_TAG)
        multilingual_stream = routed.get_side_output(MULTILINGUAL_OUT_TAG)

        transcription_sink = self._build_sink(self.config.kafka_topic("transcription_out"))
        multilingual_sink = self._build_sink(self.config.kafka_topic("multilingual_out"))

        transcription_stream.sink_to(transcription_sink)
        multilingual_stream.sink_to(multilingual_sink)

    def _build_sink(self, topic: str) -> KafkaSink:
        """Builds a KafkaSink that writes plain string values to `topic`.

        Args:
            topic: The destination Kafka topic name.

        Returns:
            A configured KafkaSink instance.
        """
        logger.debug("Building Kafka sink", extra={"topic": topic})
        return (
            KafkaSink.builder()
            .set_bootstrap_servers(self.config.kafka_brokers)
            .set_record_serializer(
                KafkaRecordSerializationSchema.builder()
                .set_topic(topic)
                .set_value_serialization_schema(SimpleStringSchema())
                .build()
            )
            # Default is NONE - a JobManager restart mid-processing (or any
            # at-least-once redelivery of the source event) could otherwise
            # re-emit the same MediaTranscriptionRequest/MediaMultilingualRequest
            # a second time before downstream state (Transcript status) has
            # moved off Draft, since there's no other producer-side backstop.
            # AT_LEAST_ONCE ties emission to Flink's own checkpoint boundary
            # instead of firing on every raw processing attempt.
            .set_delivery_guarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build()
        )


if __name__ == "__main__":
    EnrichmentRouterJob.main()
