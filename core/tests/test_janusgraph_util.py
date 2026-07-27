from unittest.mock import MagicMock

import pytest
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil, UNIQUE_ID_KEY, OBJECT_TYPE_KEY


def _util_with_mock_g():
    """A JanusGraphUtil with open() skipped and a chain-mock traversal source.

    Every fluent call (V, has, property, ...) returns the same mock, so a
    test just configures the terminal step's return value (to_list/next)
    and asserts on the intermediate calls it cares about.
    """
    util = JanusGraphUtil(host="localhost", port=8182, schema_base_path="https://blob.example.com/schemas")
    g = MagicMock()
    g.V.return_value = g
    g.has.return_value = g
    g.value_map.return_value = g
    g.property.return_value = g
    g.addV.return_value = g
    g.addE.return_value = g
    g.as_.return_value = g
    g.from_.return_value = g
    g.outE.return_value = g
    g.where.return_value = g
    g.drop.return_value = g
    g.limit.return_value = g
    g.flatMap.return_value = g
    util._g = g
    return util, g


def test_get_node_returns_flattened_properties():
    util, g = _util_with_mock_g()
    g.to_list.return_value = [{"name": ["English"], "status": ["Live"]}]

    result = util.get_node("do_123")

    assert result == {"name": "English", "status": "Live"}
    g.has.assert_any_call(UNIQUE_ID_KEY, "do_123")


def test_get_node_returns_none_when_missing():
    util, g = _util_with_mock_g()
    g.to_list.return_value = []

    assert util.get_node("do_missing") is None


def test_node_exists_true_when_count_positive():
    util, g = _util_with_mock_g()
    g.count.return_value = g
    g.next.return_value = 1

    assert util.node_exists("do_123") is True


def test_node_exists_false_when_count_zero():
    util, g = _util_with_mock_g()
    g.count.return_value = g
    g.next.return_value = 0

    assert util.node_exists("do_123") is False


def test_get_nodes_by_object_type_flattens_all_results():
    util, g = _util_with_mock_g()
    g.to_list.return_value = [{"name": ["A"]}, {"name": ["B"]}]

    results = util.get_nodes_by_object_type("Transcript", limit=50)

    assert results == [{"name": "A"}, {"name": "B"}]
    g.has.assert_any_call(OBJECT_TYPE_KEY, "Transcript")
    g.limit.assert_called_once_with(50)


def test_create_node_sets_unique_id_and_object_type():
    util, g = _util_with_mock_g()

    util.create_node("Transcript", "do_123", {"languageCode": "en"})

    g.addV.assert_called_once()
    g.property.assert_any_call(UNIQUE_ID_KEY, "do_123")
    g.property.assert_any_call(OBJECT_TYPE_KEY, "Transcript")
    g.property.assert_any_call("languageCode", "en")
    g.iterate.assert_called_once()


def test_create_node_serializes_complex_props():
    util, g = _util_with_mock_g()

    util.create_node("Enrichment", "do_456", {"segments": [{"id": 1}]})

    g.property.assert_any_call("segments", '[{"id": 1}]')


def test_delete_node_returns_false_when_not_found():
    util, g = _util_with_mock_g()
    g.count.return_value = g
    g.next.return_value = 0

    assert util.delete_node("do_missing") is False
    g.drop.assert_not_called()


def test_delete_node_drops_when_found():
    util, g = _util_with_mock_g()
    g.count.return_value = g
    g.next.return_value = 1

    assert util.delete_node("do_123") is True
    g.drop.assert_called_once()


def test_create_relation_chains_from_source_to_target():
    util, g = _util_with_mock_g()

    util.create_relation("do_1", "do_2", "associatedTo")

    g.has.assert_any_call(UNIQUE_ID_KEY, "do_1")
    g.has.assert_any_call(UNIQUE_ID_KEY, "do_2")
    g.as_.assert_called_once_with("from")
    g.addE.assert_called_once_with("associatedTo")
    g.from_.assert_called_once_with("from")
    g.iterate.assert_called_once()


def test_remove_relation_filters_by_target_and_drops():
    util, g = _util_with_mock_g()

    util.remove_relation("do_1", "do_2", "associatedTo")

    g.has.assert_any_call(UNIQUE_ID_KEY, "do_1")
    g.outE.assert_called_once_with("associatedTo")
    g.drop.assert_called_once()
    g.iterate.assert_called_once()


def test_require_g_raises_before_open():
    util = JanusGraphUtil(host="localhost", port=8182, schema_base_path="https://blob.example.com/schemas")
    with pytest.raises(AssertionError):
        util.get_node("do_123")
