from unittest.mock import MagicMock

import pytest
from gremlin_python.process.traversal import Cardinality
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil, UNIQUE_ID_KEY, OBJECT_TYPE_KEY


def _util_with_mock_g(exists: bool = True):
    """A JanusGraphUtil with open() skipped and a chain-mock traversal source.

    Every fluent call (V, has, property, ...) returns the same mock, so a
    test just configures the terminal step's return value (to_list/next)
    and asserts on the intermediate calls it cares about. node_exists()
    (used internally as a precondition check by several methods) is wired
    to `exists` by default via count().next().
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
    g.count.return_value = g
    g.next.return_value = 1 if exists else 0
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
    util, g = _util_with_mock_g(exists=True)

    assert util.node_exists("do_123") is True


def test_node_exists_false_when_count_zero():
    util, g = _util_with_mock_g(exists=False)

    assert util.node_exists("do_123") is False


def test_find_by_property_returns_flattened_match():
    util, g = _util_with_mock_g()
    g.to_list.return_value = [{"languageCode": ["en"]}]

    result = util.find_by_property("Transcript", "languageCode", "en")

    assert result == {"languageCode": "en"}
    g.has.assert_any_call(OBJECT_TYPE_KEY, "Transcript")
    g.has.assert_any_call("languageCode", "en")


def test_find_by_property_returns_none_when_missing():
    util, g = _util_with_mock_g()
    g.to_list.return_value = []

    assert util.find_by_property("Transcript", "languageCode", "fr") is None


def test_get_related_nodes_out_direction():
    util, g = _util_with_mock_g()
    g.to_list.return_value = [{"name": ["A"]}]

    results = util.get_related_nodes("do_1", "associatedTo", direction="out")

    assert results == [{"name": "A"}]


def test_get_related_nodes_rejects_invalid_direction():
    util, g = _util_with_mock_g()

    with pytest.raises(ValueError):
        util.get_related_nodes("do_1", "associatedTo", direction="sideways")


def test_get_nodes_by_object_type_flattens_all_results():
    util, g = _util_with_mock_g()
    g.to_list.return_value = [{"name": ["A"]}, {"name": ["B"]}]

    results = util.get_nodes_by_object_type("Transcript", limit=50)

    assert results == [{"name": "A"}, {"name": "B"}]
    g.has.assert_any_call(OBJECT_TYPE_KEY, "Transcript")
    g.limit.assert_called_once_with(50)


def test_update_node_raises_when_node_missing():
    util, g = _util_with_mock_g(exists=False)

    with pytest.raises(ValueError):
        util.update_node("do_missing", {"status": "Live"})


def test_update_node_sets_properties_when_node_exists():
    util, g = _util_with_mock_g(exists=True)

    util.update_node("do_123", {"status": "Live", "segments": [{"id": 1}]})

    g.property.assert_any_call(Cardinality.single, "status", "Live")
    g.property.assert_any_call(Cardinality.single, "segments", '[{"id": 1}]')
    g.iterate.assert_called_once()


def test_create_node_raises_when_identifier_already_exists():
    util, g = _util_with_mock_g(exists=True)

    with pytest.raises(ValueError):
        util.create_node("Transcript", "do_123")

    g.addV.assert_not_called()


def test_create_node_sets_unique_id_and_object_type():
    util, g = _util_with_mock_g(exists=False)

    util.create_node("Transcript", "do_123", {"languageCode": "en"})

    g.addV.assert_called_once()
    g.property.assert_any_call(Cardinality.single, UNIQUE_ID_KEY, "do_123")
    g.property.assert_any_call(Cardinality.single, OBJECT_TYPE_KEY, "Transcript")
    g.property.assert_any_call(Cardinality.single, "languageCode", "en")
    g.iterate.assert_called_once()


def test_create_node_sets_graph_id_for_scala_read_compatibility():
    # knowledge-platform's own node lookups filter on IL_UNIQUE_ID AND
    # graphId (SearchAsyncOperations.getVertexByUniqueId, Java) — a vertex
    # missing this property is invisible to every Scala-side read even
    # though it matches on IL_UNIQUE_ID alone.
    util, g = _util_with_mock_g(exists=False)

    util.create_node("Transcript", "do_123")

    g.property.assert_any_call(Cardinality.single, "graphId", "domain")
    g.property.assert_any_call(Cardinality.single, "IL_SYS_NODE_TYPE", "DATA_NODE")


def test_upsert_node_creates_when_missing():
    util, g = _util_with_mock_g(exists=False)

    util.upsert_node("Transcript", "do_123", {"languageCode": "en"})

    g.addV.assert_called_once()


def test_upsert_node_updates_when_present():
    util, g = _util_with_mock_g(exists=True)

    util.upsert_node("Transcript", "do_123", {"languageCode": "en"})

    g.addV.assert_not_called()
    g.property.assert_any_call(Cardinality.single, "languageCode", "en")


def test_upsert_node_no_op_when_present_and_no_props():
    util, g = _util_with_mock_g(exists=True)

    util.upsert_node("Transcript", "do_123")

    g.addV.assert_not_called()
    g.iterate.assert_not_called()


def test_delete_node_returns_false_when_not_found():
    util, g = _util_with_mock_g(exists=False)

    assert util.delete_node("do_missing") is False
    g.drop.assert_not_called()


def test_delete_node_drops_when_found():
    util, g = _util_with_mock_g(exists=True)

    assert util.delete_node("do_123") is True
    g.drop.assert_called_once()


def test_create_relation_raises_when_source_missing():
    util, g = _util_with_mock_g(exists=False)

    with pytest.raises(ValueError):
        util.create_relation("do_1", "do_2", "associatedTo")

    g.addE.assert_not_called()


def test_create_relation_chains_from_source_to_target():
    util, g = _util_with_mock_g(exists=True)

    util.create_relation("do_1", "do_2", "associatedTo")

    g.has.assert_any_call(UNIQUE_ID_KEY, "do_1")
    g.has.assert_any_call(UNIQUE_ID_KEY, "do_2")
    g.as_.assert_called_once_with("from")
    g.addE.assert_called_once_with("associatedTo")
    g.from_.assert_called_once_with("from")
    g.iterate.assert_called_once()


def test_remove_relation_returns_false_when_edge_missing():
    util, g = _util_with_mock_g()
    g.next.return_value = 0

    assert util.remove_relation("do_1", "do_2", "associatedTo") is False
    g.drop.assert_not_called()


def test_remove_relation_drops_when_edge_present():
    util, g = _util_with_mock_g()
    g.next.return_value = 1

    assert util.remove_relation("do_1", "do_2", "associatedTo") is True
    g.has.assert_any_call(UNIQUE_ID_KEY, "do_1")
    g.outE.assert_called_with("associatedTo")
    g.drop.assert_called_once()
    g.iterate.assert_called_once()


def test_require_g_raises_before_open():
    util = JanusGraphUtil(host="localhost", port=8182, schema_base_path="https://blob.example.com/schemas")
    with pytest.raises(RuntimeError):
        util.get_node("do_123")


def test_open_closes_existing_connection_before_reopening(monkeypatch):
    util = JanusGraphUtil(host="localhost", port=8182, schema_base_path="https://blob.example.com/schemas")
    fake_connection = MagicMock()
    monkeypatch.setattr(
        "sunbird_ai_core.graph.janusgraph_util.DriverRemoteConnection",
        lambda *a, **kw: fake_connection,
    )
    monkeypatch.setattr(
        "sunbird_ai_core.graph.janusgraph_util.traversal",
        lambda: MagicMock(with_remote=lambda conn: MagicMock()),
    )

    util.open()
    first_connection = util._connection
    util.open()

    first_connection.close.assert_called_once()
