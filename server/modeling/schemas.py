from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


DistributionType = Literal[
    "normal",
    "exponential",
    "uniform",
    "deterministic",
    "poisson",
    "erlang",
    "hyperexponential",
    "intervals",
    "intensity",
]
NodeType = Literal["service", "generator", "exit"]

GENERATOR_DISTRIBUTIONS = {
    "poisson",
    "exponential",
    "deterministic",
    "erlang",
    "intervals",
    "intensity",
}

SERVICE_DISTRIBUTIONS = {
    "normal",
    "uniform",
    "exponential",
    "hyperexponential",
    "deterministic",
    "erlang",
}


class DistributionConfig(BaseModel):
    distribution_type: DistributionType = "normal"
    mean: float | None = None
    std: float | None = None
    scale: float | None = None
    rate: float | None = None
    shape: int | None = None
    rate1: float | None = None
    rate2: float | None = None
    mix_probability: float | None = None
    intervals: list[float] | None = None
    intensity: float | None = None
    low: float | None = None
    high: float | None = None
    value: float | None = None
    min_value: float = 0.0


class RouteConfig(BaseModel):
    target_node_id: str | None = None
    edge_id: str | None = None
    probability: float = Field(default=1.0, gt=0.0)


class NodeConfig(BaseModel):
    node_id: str
    name: str
    node_type: NodeType = "service"
    open_time: float = 0.0
    close_time: float | None = None
    channels: int = Field(default=1, ge=1)
    service_distribution: DistributionConfig | None = None
    routes: list[RouteConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def ValidateSchedule(self) -> "NodeConfig":
        if self.close_time is not None and self.close_time <= self.open_time:
            raise ValueError("close_time must be greater than open_time")
        if self.node_type == "service" and self.service_distribution is None:
            raise ValueError("service node must define service_distribution")
        if (
            self.node_type == "service"
            and self.service_distribution
            and self.service_distribution.distribution_type not in SERVICE_DISTRIBUTIONS
        ):
            raise ValueError("service node has unsupported service_distribution type")
        if self.node_type == "exit" and self.routes:
            raise ValueError("exit node must not define outgoing routes")
        return self


class EdgeConfig(BaseModel):
    edge_id: str
    source_node_id: str
    target_node_id: str
    travel_distribution: DistributionConfig


class GeneratorConfig(BaseModel):
    target_node_id: str
    interarrival_distribution: DistributionConfig
    start_time: float = 0.0
    stop_time: float | None = None


class SimulationConfig(BaseModel):
    simulation_duration: float = Field(default=100.0, gt=0)
    random_seed: int | None = None
    max_requests: int | None = Field(default=5000, gt=0)
    generator: GeneratorConfig
    nodes: list[NodeConfig]
    edges: list[EdgeConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def ValidateGraph(self) -> "SimulationConfig":
        node_ids = {node.node_id for node in self.nodes}
        if len(node_ids) != len(self.nodes):
            raise ValueError("node_id values must be unique")

        edge_ids = {edge.edge_id for edge in self.edges}
        if len(edge_ids) != len(self.edges):
            raise ValueError("edge_id values must be unique")

        if self.generator.target_node_id not in node_ids:
            raise ValueError("generator.target_node_id must reference existing node")
        if self.generator.interarrival_distribution.distribution_type not in GENERATOR_DISTRIBUTIONS:
            raise ValueError(
                "generator.interarrival_distribution has unsupported distribution type"
            )

        generator_nodes = [node.node_id for node in self.nodes if node.node_type == "generator"]
        if len(generator_nodes) != 1:
            raise ValueError("Model must contain exactly one generator node")
        if generator_nodes[0] != self.generator.target_node_id:
            raise ValueError("generator.target_node_id must reference generator node")

        exit_nodes = [node.node_id for node in self.nodes if node.node_type == "exit"]
        if len(exit_nodes) == 0:
            raise ValueError("Model must contain at least one exit node")

        edge_lookup = {edge.edge_id: edge for edge in self.edges}
        for edge in self.edges:
            if edge.source_node_id not in node_ids or edge.target_node_id not in node_ids:
                raise ValueError("All edges must reference existing nodes")

        for node in self.nodes:
            if node.node_type == "exit":
                continue
            if not node.routes:
                raise ValueError(f"Node '{node.node_id}' must define at least one route")

            probability_sum = sum(route.probability for route in node.routes)
            if abs(probability_sum - 1.0) > 1e-6:
                raise ValueError(
                    f"Node '{node.node_id}' must have total route probability exactly 1.0 "
                    f"(received {probability_sum:.6f})"
                )

            for route in node.routes:
                if route.target_node_id is None:
                    continue
                if route.target_node_id not in node_ids:
                    raise ValueError(
                        f"Node '{node.node_id}' route references unknown target_node_id"
                    )
                if route.edge_id is None or route.edge_id.strip() == "":
                    raise ValueError(
                        f"Node '{node.node_id}' route to '{route.target_node_id}' requires edge_id"
                    )
                if route.edge_id not in edge_lookup:
                    raise ValueError(
                        f"Node '{node.node_id}' route references unknown edge_id '{route.edge_id}'"
                    )
                edge = edge_lookup[route.edge_id]
                if edge.source_node_id != node.node_id or edge.target_node_id != route.target_node_id:
                    raise ValueError(
                        f"Route edge '{route.edge_id}' does not match route direction "
                        f"{node.node_id} -> {route.target_node_id}"
                    )

        return self


class SimulationRunRequest(BaseModel):
    model_name: str = Field(min_length=1, max_length=100)
    config: SimulationConfig
