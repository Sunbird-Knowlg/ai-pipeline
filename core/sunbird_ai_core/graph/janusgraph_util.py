import json
import logging
from typing import Any

from gremlin_python.driver.driver_remote_connection import DriverRemoteConnection
from gremlin_python.process.anonymous_traversal import traversal
from gremlin_python.process.graph_traversal import __

from sunbird_ai_core.graph.schema_registry import SchemaRegistry

UNIQUE_ID_KEY = "IL_UNIQUE_ID"
OBJECT_TYPE_KEY = "IL_FUNC_OBJECT_TYPE"

_COMPLEX_TYPES = (list, dict)

logger = logging.getLogger(__name__)


class JanusGraphUtil:
    """Gremlin Server WebSocket wrapper for performing graph operations.

    This utility establishes a websocket connection (`DriverRemoteConnection`) 
    to a Gremlin Server to query and mutate JanusGraph databases. It mirrors 
    the connection and lifecycle pattern used by Scala graph drivers.

    Attributes:
        schema_registry (SchemaRegistry): Registry helper for handling graph schemas.
    """

    def __init__(self, host: str, port: int, schema_base_path: str, graph_name: str = "g"):
        """Initializes the graph utility settings.

        Args:
            host: Hostname or IP address of the Gremlin Server.
            port: WebSocket port of the Gremlin Server.
            schema_base_path: Filesystem path to the directory containing graph schemas.
            graph_name: The traversal source name registered on the server (defaults to "g").
        """
        self._url = f"ws://{host}:{port}/gremlin"
        self._connection: DriverRemoteConnection | None = None
        self._g = None
        self._graph_name = graph_name
        self.schema_registry = SchemaRegistry(schema_base_path)

    def open(self) -> None:
        """Establishes the WebSocket connection and initializes graph traversal."""
        logger.info("Opening JanusGraph connection", extra={"url": self._url})
        self._connection = DriverRemoteConnection(self._url, self._graph_name)
        self._g = traversal().with_(self._connection)
        logger.debug("JanusGraph connection open")

    def close(self) -> None:
        """Closes the WebSocket connection and resets traversal states."""
        if self._connection is not None:
            logger.info("Closing JanusGraph connection")
            self._connection.close()
            self._connection = None
            self._g = None

    def _require_g(self):
        """Ensures that the WebSocket connection is open.

        Returns:
            The active graph traversal source.

        Raises:
            AssertionError: If open() was not called before invoking this helper.
        """
        assert self._g is not None, "JanusGraphUtil.open() must be called before use"
        return self._g

    def _flatten(self, value_map: dict) -> dict[str, Any]:
        """Flattens list-wrapped property values returned by Gremlin.

        Gremlin's `value_map()` returns property values inside list wrappers 
        to support multi-valued attributes. This helper converts single-element 
        lists to standard scalar values.

        Args:
            value_map: Raw dictionary returned from a Gremlin value map.

        Returns:
            A flattened dictionary with scalar values where applicable.
        """
        return {
            k: (v[0] if isinstance(v, list) and len(v) == 1 else v)
            for k, v in value_map.items()
        }

    def get_node(self, identifier: str) -> dict[str, Any] | None:
        """Retrieves a vertex's properties by its system unique identifier.

        Args:
            identifier: The unique identifier of the node (IL_UNIQUE_ID).

        Returns:
            A flattened dictionary of vertex properties, or None if not found.
        """
        g = self._require_g()
        logger.debug("get_node", extra={"identifier": identifier})
        results = g.V().has(UNIQUE_ID_KEY, identifier).value_map().to_list()
        if not results:
            logger.debug("get_node: not found", extra={"identifier": identifier})
            return None
        return self._flatten(results[0])

    def node_exists(self, identifier: str) -> bool:
        """Checks if a vertex with the given identifier exists.

        Args:
            identifier: The unique identifier of the node (IL_UNIQUE_ID).

        Returns:
            True if the vertex exists, False otherwise.
        """
        g = self._require_g()
        return g.V().has(UNIQUE_ID_KEY, identifier).count().next() > 0

    def find_by_property(self, object_type: str, key: str, value: Any) -> dict[str, Any] | None:
        """Finds a vertex of a given object type matching a key-value property pair.

        Args:
            object_type: The functional object type identifier (IL_FUNC_OBJECT_TYPE).
            key: The property key to filter by.
            value: The target value of the property.

        Returns:
            A flattened dictionary of the matching vertex's properties, or None.
        """
        g = self._require_g()
        logger.debug("find_by_property", extra={"object_type": object_type, "key": key, "value": value})
        results = (
            g.V()
            .has(OBJECT_TYPE_KEY, object_type)
            .has(key, value)
            .value_map()
            .to_list()
        )
        if not results:
            logger.debug("find_by_property: not found", extra={"object_type": object_type, "key": key, "value": value})
            return None
        return self._flatten(results[0])

    def get_related_nodes(
        self, identifier: str, relation_label: str, direction: str = "out"
    ) -> list[dict[str, Any]]:
        """Retrieves properties of vertices connected to a node via a specific relation.

        Args:
            identifier: The unique identifier (IL_UNIQUE_ID) of the origin node.
            relation_label: The edge label representing the relationship.
            direction: The direction of the edge relation traversal ('out' or 'in').

        Returns:
            A list of flattened property dictionaries for all connected vertices.
        """
        g = self._require_g()
        traversal_step = __.out(relation_label) if direction == "out" else __.in_(relation_label)
        results = (
            g.V()
            .has(UNIQUE_ID_KEY, identifier)
            .flatMap(traversal_step)
            .value_map()
            .to_list()
        )
        logger.debug(
            "get_related_nodes",
            extra={"identifier": identifier, "relation_label": relation_label, "direction": direction, "count": len(results)},
        )
        return [self._flatten(r) for r in results]

    def update_node(self, identifier: str, props: dict[str, Any]) -> None:
        """Updates properties on a vertex identified by its unique ID.

        Complex Python structures (lists, dicts) are automatically serialized 
        to JSON strings before writing.

        Args:
            identifier: The unique identifier (IL_UNIQUE_ID) of the node to update.
            props: A dictionary of key-value property mutations to apply.
        """
        g = self._require_g()
        logger.info("update_node", extra={"identifier": identifier, "props": list(props.keys())})
        traversal_step = g.V().has(UNIQUE_ID_KEY, identifier)
        for key, value in props.items():
            serialized = json.dumps(value) if isinstance(value, _COMPLEX_TYPES) else value
            traversal_step = traversal_step.property(key, serialized)
        try:
            traversal_step.iterate()
        except Exception:
            logger.exception("update_node failed", extra={"identifier": identifier})
            raise
