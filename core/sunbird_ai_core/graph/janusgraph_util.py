import json
from typing import Any

from gremlin_python.driver.driver_remote_connection import DriverRemoteConnection
from gremlin_python.process.anonymous_traversal import traversal
from gremlin_python.process.graph_traversal import __

from sunbird_ai_core.graph.schema_registry import SchemaRegistry

UNIQUE_ID_KEY = "IL_UNIQUE_ID"
OBJECT_TYPE_KEY = "IL_FUNC_OBJECT_TYPE"

_COMPLEX_TYPES = (list, dict)


class JanusGraphUtil:
    """gremlinpython wrapper over Gremlin Server WebSocket — same access
    pattern as the Scala DriverRemoteConnection used in knowledge-platform-jobs,
    just from Python. One connection per TaskManager: open() in job open(),
    close() in job close().
    """

    def __init__(self, host: str, port: int, schema_base_path: str, graph_name: str = "g"):
        self._url = f"ws://{host}:{port}/gremlin"
        self._connection: DriverRemoteConnection | None = None
        self._g = None
        self._graph_name = graph_name
        self.schema_registry = SchemaRegistry(schema_base_path)

    def open(self) -> None:
        self._connection = DriverRemoteConnection(self._url, self._graph_name)
        self._g = traversal().with_(self._connection)

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None
            self._g = None

    def _require_g(self):
        assert self._g is not None, "JanusGraphUtil.open() must be called before use"
        return self._g

    def _flatten(self, value_map: dict) -> dict[str, Any]:
        return {
            k: (v[0] if isinstance(v, list) and len(v) == 1 else v)
            for k, v in value_map.items()
        }

    def get_node(self, identifier: str) -> dict[str, Any] | None:
        g = self._require_g()
        results = g.V().has(UNIQUE_ID_KEY, identifier).value_map().to_list()
        if not results:
            return None
        return self._flatten(results[0])

    def node_exists(self, identifier: str) -> bool:
        g = self._require_g()
        return g.V().has(UNIQUE_ID_KEY, identifier).count().next() > 0

    def find_by_property(self, object_type: str, key: str, value: Any) -> dict[str, Any] | None:
        g = self._require_g()
        results = (
            g.V()
            .has(OBJECT_TYPE_KEY, object_type)
            .has(key, value)
            .value_map()
            .to_list()
        )
        if not results:
            return None
        return self._flatten(results[0])

    def get_related_nodes(
        self, identifier: str, relation_label: str, direction: str = "out"
    ) -> list[dict[str, Any]]:
        g = self._require_g()
        traversal_step = __.out(relation_label) if direction == "out" else __.in_(relation_label)
        results = (
            g.V()
            .has(UNIQUE_ID_KEY, identifier)
            .flatMap(traversal_step)
            .value_map()
            .to_list()
        )
        return [self._flatten(r) for r in results]

    def update_node(self, identifier: str, props: dict[str, Any]) -> None:
        g = self._require_g()
        traversal_step = g.V().has(UNIQUE_ID_KEY, identifier)
        for key, value in props.items():
            serialized = json.dumps(value) if isinstance(value, _COMPLEX_TYPES) else value
            traversal_step = traversal_step.property(key, serialized)
        # .next() tries to deserialize the mutated Vertex back (including
        # JanusGraph-typed properties/ids), which vanilla gremlinpython can't
        # decode — fails with KeyError: <DataType.custom: 0>. .iterate()
        # executes the mutation without materializing the result, which is
        # all this method needs (return type is None).
        traversal_step.iterate()
