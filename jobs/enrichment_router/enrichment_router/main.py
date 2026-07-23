from pyflink.common.serialization import SimpleStringSchema
from pyflink.common.watermark_strategy import WatermarkStrategy
from pyflink.datastream.connectors.kafka import (
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


class EnrichmentRouterJob(BaseFlinkJob):
    def build_pipeline(self) -> None:
        source = (
            KafkaSource.builder()
            .set_bootstrap_servers(self.config.kafka_brokers)
            .set_topics(self.config.kafka_topic("input"))
            .set_group_id(self.config.kafka_group_id)
            .set_starting_offsets(KafkaOffsetsInitializer.committed_offsets())
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
    EnrichmentRouterJob.main()
