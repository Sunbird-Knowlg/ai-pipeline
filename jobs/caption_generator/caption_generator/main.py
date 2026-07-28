import logging

from pyflink.common.serialization import SimpleStringSchema
from pyflink.common.watermark_strategy import WatermarkStrategy
from pyflink.datastream.connectors.kafka import (
    KafkaOffsetResetStrategy,
    KafkaOffsetsInitializer,
    KafkaRecordSerializationSchema,
    KafkaSink,
    KafkaSource,
)
from sunbird_ai_core.base.base_flink_job import BaseFlinkJob

from caption_generator.functions.event_router import (
    MULTILINGUAL_REQUEST_TAG,
    TRANSCRIPTION_REQUEST_TAG,
    EventRouter,
)
from caption_generator.functions.multilingual_function import MULTILINGUAL_DLQ_TAG, MultilingualFunction
from caption_generator.functions.transcription_function import (
    ENRICHED_METADATA_TAG,
    TRANSCRIPTION_DLQ_TAG,
    TranscriptionFunction,
)

logger = logging.getLogger(__name__)


class CaptionGeneratorJob(BaseFlinkJob):
    def build_pipeline(self) -> None:
        logger.info(
            "Building caption-generator pipeline",
            extra={
                "transcription_in_topic": self.config.kafka_topic("transcription_in"),
                "multilingual_in_topic": self.config.kafka_topic("multilingual_in"),
            },
        )
        transcription_source = self._build_source(
            self.config.kafka_topic("transcription_in"), "transcription-in"
        )
        multilingual_source = self._build_source(
            self.config.kafka_topic("multilingual_in"), "multilingual-in"
        )

        merged = transcription_source.union(multilingual_source)
        routed = merged.process(EventRouter())

        transcription_stream = routed.get_side_output(TRANSCRIPTION_REQUEST_TAG)
        multilingual_stream = routed.get_side_output(MULTILINGUAL_REQUEST_TAG)

        transcription_result = transcription_stream.process(TranscriptionFunction(self.config))
        multilingual_result = multilingual_stream.process(MultilingualFunction(self.config))

        transcription_result.get_side_output(TRANSCRIPTION_DLQ_TAG).sink_to(
            self._build_sink(self.config.kafka_topic("transcription_dlq"))
        )
        transcription_result.get_side_output(ENRICHED_METADATA_TAG).sink_to(
            self._build_sink(self.config.kafka_topic("enriched_metadata_out"))
        )
        multilingual_result.get_side_output(MULTILINGUAL_DLQ_TAG).sink_to(
            self._build_sink(self.config.kafka_topic("multilingual_dlq"))
        )

    def _build_source(self, topic: str, source_name: str) -> KafkaSource:
        logger.debug("Building Kafka source", extra={"topic": topic, "source_name": source_name})
        source = (
            KafkaSource.builder()
            .set_bootstrap_servers(self.config.kafka_brokers)
            .set_topics(topic)
            .set_group_id(self.config.kafka_group_id)
            .set_starting_offsets(
                KafkaOffsetsInitializer.committed_offsets(KafkaOffsetResetStrategy.LATEST)
            )
            .set_value_only_deserializer(SimpleStringSchema())
            .build()
        )
        return self.env.from_source(
            source, watermark_strategy=WatermarkStrategy.no_watermarks(), source_name=source_name
        )

    def _build_sink(self, topic: str) -> KafkaSink:
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
            .build()
        )


if __name__ == "__main__":
    CaptionGeneratorJob.main()
