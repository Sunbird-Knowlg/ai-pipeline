import argparse
from abc import ABC, abstractmethod

from pyflink.datastream import StreamExecutionEnvironment

from sunbird_ai_core.base.base_job_config import BaseJobConfig


class BaseFlinkJob(ABC):
    """Sets up StreamExecutionEnvironment and parallelism. Subclasses wire
    Kafka sources/sinks and process functions in build_pipeline().
    """

    def __init__(self, config_path: str):
        self.config = BaseJobConfig(config_path)
        self.env = StreamExecutionEnvironment.get_execution_environment()
        self.env.set_parallelism(self.config.parallelism)

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
