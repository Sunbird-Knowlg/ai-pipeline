import argparse
from abc import ABC, abstractmethod

from pyflink.common.restart_strategy import RestartStrategies
from pyflink.datastream import StreamExecutionEnvironment

from sunbird_ai_core.base.base_job_config import BaseJobConfig


class BaseFlinkJob(ABC):
    """Sets up StreamExecutionEnvironment, parallelism, and checkpointing.
    Subclasses wire Kafka sources/sinks and process functions in
    build_pipeline().
    """

    def __init__(self, config_path: str):
        self.config = BaseJobConfig(config_path)
        self.env = StreamExecutionEnvironment.get_execution_environment()
        self.env.set_parallelism(self.config.parallelism)

        # Without checkpointing, KafkaSource never commits offsets back to
        # Kafka (offset commit happens on checkpoint completion) - every job
        # restart then falls back to whatever was last committed, however
        # far in the past that is, replaying the entire backlog. Checkpoint
        # storage is left at Flink's default (JobManager heap) rather than a
        # distributed backend - these jobs are stateless (pure routing/side
        # outputs), so checkpoint content is trivial and the only thing that
        # actually matters here is the Kafka offset commit, which fires
        # regardless of where the checkpoint snapshot itself is stored.
        self.env.enable_checkpointing(self.config.checkpointing_interval_ms)
        self.env.get_checkpoint_config().set_checkpoint_timeout(self.config.checkpointing_timeout_ms)
        self.env.set_restart_strategy(
            RestartStrategies.fixed_delay_restart(self.config.restart_attempts, self.config.restart_delay_ms)
        )

    @abstractmethod
    def build_pipeline(self) -> None:
        """Wire sources, process functions, and sinks onto self.env."""
        raise NotImplementedError

    def run(self) -> None:
        self.build_pipeline()
        self.env.execute(self.config.job_name)

    @classmethod
    def main(cls) -> None:
        parser = argparse.ArgumentParser()
        parser.add_argument("--config", required=True, help="Path to job config.yaml")
        args = parser.parse_args()
        cls(args.config).run()
