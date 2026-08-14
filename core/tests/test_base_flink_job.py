from unittest.mock import MagicMock, patch

import pytest
import yaml
from sunbird_ai_core.base.base_flink_job import BaseFlinkJob

MINIMAL_CONFIG = {
    "job": {
        "name": "test-flink-job",
        "parallelism": 2,
        "checkpointing_interval_ms": 5000,
        "checkpointing_timeout_ms": 3000,
        "restart_attempts": 5,
        "restart_delay_ms": 2000,
    }
}


class _ConcreteFlinkJob(BaseFlinkJob):
    def __init__(self, config_path):
        super().__init__(config_path)
        self.build_pipeline_called = False

    def build_pipeline(self) -> None:
        self.build_pipeline_called = True


def _write_config(tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(yaml.safe_dump(MINIMAL_CONFIG))
    return str(config_path)


@patch("sunbird_ai_core.base.base_flink_job.StreamExecutionEnvironment")
def test_init_configures_env_from_config(mock_env_cls, tmp_path):
    mock_env = MagicMock()
    mock_env_cls.get_execution_environment.return_value = mock_env

    job = _ConcreteFlinkJob(_write_config(tmp_path))

    mock_env.set_parallelism.assert_called_once_with(2)
    mock_env.enable_checkpointing.assert_called_once_with(5000)
    mock_env.get_checkpoint_config.return_value.set_checkpoint_timeout.assert_called_once_with(3000)
    assert job.env is mock_env


@patch("sunbird_ai_core.base.base_flink_job.RestartStrategies")
@patch("sunbird_ai_core.base.base_flink_job.StreamExecutionEnvironment")
def test_init_sets_fixed_delay_restart_strategy_when_configured(
    mock_env_cls, mock_restart_strategies, tmp_path
):
    mock_env_cls.get_execution_environment.return_value = MagicMock()
    config = {**MINIMAL_CONFIG, "job": {**MINIMAL_CONFIG["job"], "restart_strategy": "fixed_delay"}}
    config_path = tmp_path / "config.yaml"
    config_path.write_text(yaml.safe_dump(config))

    _ConcreteFlinkJob(str(config_path))

    mock_restart_strategies.fixed_delay_restart.assert_called_once_with(5, 2000)


@patch("sunbird_ai_core.base.base_flink_job.RestartStrategies")
@patch("sunbird_ai_core.base.base_flink_job.StreamExecutionEnvironment")
def test_init_defaults_to_failure_rate_restart_strategy(mock_env_cls, mock_restart_strategies, tmp_path):
    # failure_rate is the default because a fixed lifetime restart counter
    # (fixed_delay) exhausts permanently over weeks/months of otherwise
    # healthy uptime — failure_rate bounds failures per rolling window
    # instead.
    mock_env_cls.get_execution_environment.return_value = MagicMock()

    _ConcreteFlinkJob(_write_config(tmp_path))

    mock_restart_strategies.failure_rate_restart.assert_called_once_with(3, 300000, 2000)
    mock_restart_strategies.fixed_delay_restart.assert_not_called()


@patch("sunbird_ai_core.base.base_flink_job.StreamExecutionEnvironment")
def test_run_builds_pipeline_and_executes(mock_env_cls, tmp_path):
    mock_env = MagicMock()
    mock_env_cls.get_execution_environment.return_value = mock_env

    job = _ConcreteFlinkJob(_write_config(tmp_path))
    job.run()

    assert job.build_pipeline_called is True
    mock_env.execute.assert_called_once_with("test-flink-job")


def test_build_pipeline_is_abstract():
    with pytest.raises(TypeError):
        BaseFlinkJob("irrelevant-path")


@patch("sunbird_ai_core.base.base_flink_job.StreamExecutionEnvironment")
def test_main_instantiates_from_cli_config_arg(mock_env_cls, tmp_path, monkeypatch):
    mock_env_cls.get_execution_environment.return_value = MagicMock()
    config_path = _write_config(tmp_path)
    monkeypatch.setattr("sys.argv", ["job", "--config", config_path])

    _ConcreteFlinkJob.main()
