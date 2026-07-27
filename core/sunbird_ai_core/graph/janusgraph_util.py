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
        """Establishes the WebSocket connection and initializes graph traversal.

        Safe to call on an already-open instance — the existing connection is
        closed first so a repeat open() can't leak the old websocket.
        """
        if self._connection is not None:
            logger.debug("open() called on already-open connection, reopening")
            self.close()
        logger.info("Opening JanusGraph connection", extra={"url": self._url})
        self._connection = DriverRemoteConnection(self._url, self._graph_name)
        self._g = traversal().with_remote(self._connection)
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
            RuntimeError: If open() was not called before invoking this helper.
        """
        if self._g is None:
            raise RuntimeError("JanusGraphUtil.open() must be called before use")
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

        Raises:
            ValueError: If direction is not 'out' or 'in'.
        """
        if direction not in ("out", "in"):
            raise ValueError(f"direction must be 'out' or 'in', got {direction!r}")
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

        Raises:
            ValueError: If no vertex with the given identifier exists — Gremlin's
                .property() step silently no-ops on an empty traversal, so this
                check is what turns a "wrote nothing" bug into a visible failure.
        """
        if not self.node_exists(identifier):
            logger.error("update_node: node not found", extra={"identifier": identifier})
            raise ValueError(f"Cannot update_node: no node found with identifier {identifier!r}")
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

    def get_nodes_by_object_type(self, object_type: str, limit: int = 100) -> list[dict[str, Any]]:
        """Retrieves properties of vertices matching a functional object type.

        Args:
            object_type: The functional object type identifier (IL_FUNC_OBJECT_TYPE).
            limit: The maximum number of vertices to return.

        Returns:
            A list of flattened property dictionaries, one per matching vertex.
        """
        g = self._require_g()
        results = g.V().has(OBJECT_TYPE_KEY, object_type).limit(limit).value_map().to_list()
        logger.debug("get_nodes_by_object_type", extra={"object_type": object_type, "count": len(results)})
        return [self._flatten(r) for r in results]

    def create_node(self, object_type: str, identifier: str, props: dict[str, Any] | None = None) -> None:
        """Creates a new vertex with a unique identifier and functional object type.

        Complex Python structures (lists, dicts) are automatically serialized
        to JSON strings before writing, same as update_node. Rejects an
        identifier that's already in use rather than silently creating a
        duplicate vertex — callers that need retry-safe (at-least-once)
        creation should use upsert_node instead.

        Args:
            object_type: The functional object type identifier (IL_FUNC_OBJECT_TYPE).
            identifier: The unique identifier (IL_UNIQUE_ID) to assign the new node.
            props: Optional dictionary of additional key-value properties to set.

        Raises:
            ValueError: If a vertex with this identifier already exists.
        """
        if self.node_exists(identifier):
            raise ValueError(f"Cannot create_node: identifier {identifier!r} already exists")
        g = self._require_g()
        logger.info("create_node", extra={"object_type": object_type, "identifier": identifier})
        traversal_step = (
            g.addV()
            .property(UNIQUE_ID_KEY, identifier)
            .property(OBJECT_TYPE_KEY, object_type)
        )
        for key, value in (props or {}).items():
            serialized = json.dumps(value) if isinstance(value, _COMPLEX_TYPES) else value
            traversal_step = traversal_step.property(key, serialized)
        try:
            traversal_step.iterate()
        except Exception:
            logger.exception("create_node failed", extra={"object_type": object_type, "identifier": identifier})
            raise

    def upsert_node(self, object_type: str, identifier: str, props: dict[str, Any] | None = None) -> None:
        """Creates a vertex if missing, otherwise updates its properties.

        Retry-safe under Flink's at-least-once delivery + checkpoint restarts,
        unlike create_node (which rejects a duplicate identifier outright).

        Args:
            object_type: The functional object type identifier (IL_FUNC_OBJECT_TYPE).
            identifier: The unique identifier (IL_UNIQUE_ID) of the node.
            props: Optional dictionary of additional key-value properties to set.
        """
        if self.node_exists(identifier):
            if props:
                self.update_node(identifier, props)
            return
        self.create_node(object_type, identifier, props)

    def delete_node(self, identifier: str) -> bool:
        """Deletes a vertex identified by its unique ID, if it exists.

        Args:
            identifier: The unique identifier (IL_UNIQUE_ID) of the node to delete.

        Returns:
            True if a matching vertex was found and deleted, False otherwise.
        """
        g = self._require_g()
        if not self.node_exists(identifier):
            logger.debug("delete_node: not found", extra={"identifier": identifier})
            return False
        logger.info("delete_node", extra={"identifier": identifier})
        g.V().has(UNIQUE_ID_KEY, identifier).drop().iterate()
        return True

    def create_relation(self, from_identifier: str, to_identifier: str, relation_label: str) -> None:
        """Creates a directed edge between two existing vertices.

        Args:
            from_identifier: The unique identifier (IL_UNIQUE_ID) of the source node.
            to_identifier: The unique identifier (IL_UNIQUE_ID) of the target node.
            relation_label: The edge label to create between the two nodes.

        Raises:
            ValueError: If either endpoint identifier does not exist — Gremlin's
                addE() step silently no-ops on an empty traversal, so this check
                is what turns a "wrote nothing" bug into a visible failure.
        """
        if not self.node_exists(from_identifier):
            raise ValueError(f"Cannot create_relation: no node found with identifier {from_identifier!r}")
        if not self.node_exists(to_identifier):
            raise ValueError(f"Cannot create_relation: no node found with identifier {to_identifier!r}")
        g = self._require_g()
        logger.info(
            "create_relation",
            extra={"from_identifier": from_identifier, "to_identifier": to_identifier, "relation_label": relation_label},
        )
        (
            g.V()
            .has(UNIQUE_ID_KEY, from_identifier)
            .as_("from")
            .V()
            .has(UNIQUE_ID_KEY, to_identifier)
            .addE(relation_label)
            .from_("from")
            .iterate()
        )

    def remove_relation(self, from_identifier: str, to_identifier: str, relation_label: str) -> bool:
        """Removes a directed edge between two vertices, if it exists.

        Args:
            from_identifier: The unique identifier (IL_UNIQUE_ID) of the source node.
            to_identifier: The unique identifier (IL_UNIQUE_ID) of the target node.
            relation_label: The edge label to remove between the two nodes.

        Returns:
            True if a matching edge was found and removed, False otherwise.
        """
        g = self._require_g()
        edge_exists = (
            g.V()
            .has(UNIQUE_ID_KEY, from_identifier)
            .outE(relation_label)
            .where(__.in_v().has(UNIQUE_ID_KEY, to_identifier))
            .count()
            .next()
            > 0
        )
        if not edge_exists:
            logger.debug(
                "remove_relation: not found",
                extra={"from_identifier": from_identifier, "to_identifier": to_identifier, "relation_label": relation_label},
            )
            return False
        logger.info(
            "remove_relation",
            extra={"from_identifier": from_identifier, "to_identifier": to_identifier, "relation_label": relation_label},
        )
        (
            g.V()
            .has(UNIQUE_ID_KEY, from_identifier)
            .outE(relation_label)
            .where(__.in_v().has(UNIQUE_ID_KEY, to_identifier))
            .drop()
            .iterate()
        )
        return True
