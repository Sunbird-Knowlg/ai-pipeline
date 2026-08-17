
import pytest
from sunbird_ai_core.config.job_config import JobConfig


@pytest.fixture
def config_file(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(
        "job:\n"
        "  name: test-job\n"
        "kafka:\n"
        "  brokers: localhost:9092\n"
    )
    return str(path)


def test_reads_yaml_value(config_file):
    config = JobConfig(config_file)
    assert config.get("job.name") == "test-job"
    assert config.get("kafka.brokers") == "localhost:9092"


def test_missing_key_returns_default(config_file):
    config = JobConfig(config_file)
    assert config.get("does.not.exist") is None
    assert config.get("does.not.exist", "fallback") == "fallback"


def test_env_var_overrides_yaml(config_file, monkeypatch):
    monkeypatch.setenv("SUNBIRD_AI_KAFKA_BROKERS", "prod-broker:9092")
    config = JobConfig(config_file)
    assert config.get("kafka.brokers") == "prod-broker:9092"


def test_get_required_raises_on_missing(config_file):
    config = JobConfig(config_file)
    with pytest.raises(KeyError):
        config.get_required("does.not.exist")
