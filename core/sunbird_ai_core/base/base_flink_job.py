import argparse
import logging
from abc import ABC, abstractmethod

from pyflink.common.restart_strategy import RestartStrategies
from pyflink.datastream import StreamExecutionEnvironment

from sunbird_ai_core.base.base_job_config import BaseJobConfig
from sunbird_ai_core.logging_setup import configure_logging

logger = logging.getLogger(__name__)


class BaseFlinkJob(ABC):
    """Abstract base class for establishing a PyFlink streaming job.

    This class coordinates the initialization of the PyFlink execution 
    environment, sets job parallelism, defines error recovery restart strategies, 
    and configures checkpointing behavior. Subclasses must implement 
    `build_pipeline` to define sources, transformations, and sinks.

    Attributes:
        config (BaseJobConfig): Loaded configuration settings for the Flink job.
        env (StreamExecutionEnvironment): The active PyFlink execution context.
    """

    def __init__(self, config_path: str):
        """Initializes the Flink execution environment and applies configurations.

        Args:
            config_path: The filesystem path to the job's configuration YAML file.
        """
        self.config = BaseJobConfig(config_path)
        configure_logging(self.config.job_name, self.config.log_level)
        logger.info(
            "Initializing Flink job",
            extra={"job_name": self.config.job_name, "parallelism": self.config.parallelism},
        )
        self.env = StreamExecutionEnvironment.get_execution_environment()
        self.env.set_parallelism(self.config.parallelism)

        self.env.enable_checkpointing(self.config.checkpointing_interval_ms)
        self.env.get_checkpoint_config().set_checkpoint_timeout(self.config.checkpointing_timeout_ms)
        self.env.set_restart_strategy(
            RestartStrategies.fixed_delay_restart(self.config.restart_attempts, self.config.restart_delay_ms)
        )
        logger.debug(
            "Checkpointing configured",
            extra={
                "interval_ms": self.config.checkpointing_interval_ms,
                "timeout_ms": self.config.checkpointing_timeout_ms,
                "restart_attempts": self.config.restart_attempts,
                "restart_delay_ms": self.config.restart_delay_ms,
            },
        )

    @abstractmethod
    def build_pipeline(self) -> None:
        """Constructs the stream processing graph.

        Subclasses must override this method to register data sources,
        operators, stream transformations, and data sinks on `self.env`.

        Raises:
            NotImplementedError: If the subclass does not override this method.
        """
        raise NotImplementedError

    def run(self) -> None:
        """Builds the stream pipeline and submits it to Flink for execution."""
        logger.info("Building pipeline", extra={"job_name": self.config.job_name})
        self.build_pipeline()
        logger.info("Submitting job for execution", extra={"job_name": self.config.job_name})
        self.env.execute(self.config.job_name)

    @classmethod
    def main(cls) -> None:
        """Command-line entry point to instantiate and execute the job.

        Parses command-line arguments to find the configuration path,
        creates an instance of the class, and starts execution.
        """
        parser = argparse.ArgumentParser()
        parser.add_argument("--config", required=True, help="Path to job config.yaml")
        args = parser.parse_args()
        cls(args.config).run()
