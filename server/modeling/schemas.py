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


class NodeScheduleInterval(BaseModel):
    open_time: float = Field(default=0.0, ge=0.0)
    close_time: float | None = None

    @model_validator(mode="after")
    def ValidateWindow(self) -> "NodeScheduleInterval":
        if self.close_time is not None and self.close_time <= self.open_time:
            raise ValueError("schedule close_time must be greater than open_time")
        return self


class NodeConfig(BaseModel):
    node_id: str
    name: str
    node_type: NodeType = "service"
    open_time: float = 0.0
    close_time: float | None = None
    schedule: list[NodeScheduleInterval] = Field(default_factory=list)
    channels: int = Field(default=1, ge=1)
    service_distribution: DistributionConfig | None = None
    routes: list[RouteConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def ValidateSchedule(self) -> "NodeConfig":
        schedule_windows = self.schedule
        if len(schedule_windows) == 0:
            schedule_windows = [
                NodeScheduleInterval(open_time=max(0.0, self.open_time), close_time=self.close_time),
            ]

        normalized_schedule = sorted(schedule_windows, key=lambda interval: interval.open_time)
        previous_close_time: float | None = None
        has_open_ended_window = False
        for interval in normalized_schedule:
            if has_open_ended_window:
                raise ValueError(
                    "schedule must not contain windows after a window without close_time",
                )
            if previous_close_time is not None and interval.open_time < previous_close_time:
                raise ValueError("schedule windows must not overlap")
            if interval.close_time is None:
                has_open_ended_window = True
            else:
                previous_close_time = interval.close_time

        self.schedule = normalized_schedule
        self.open_time = normalized_schedule[0].open_time
        self.close_time = normalized_schedule[0].close_time

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
    generator: GeneratorConfig | None = None
    generators: list[GeneratorConfig] = Field(default_factory=list)
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

        generator_nodes = [node.node_id for node in self.nodes if node.node_type == "generator"]
        if len(generator_nodes) == 0:
            raise ValueError("Model must contain at least one generator node")

        if not self.generators and self.generator is not None:
            self.generators = [self.generator]
        if self.generators and self.generator is None:
            self.generator = self.generators[0]

        if len(self.generators) == 0:
            raise ValueError("Model must define generator settings")

        generator_node_id_set = set(generator_nodes)
        configured_targets: set[str] = set()
        for generator_config in self.generators:
            if generator_config.target_node_id not in node_ids:
                raise ValueError("generator.target_node_id must reference existing node")
            if generator_config.target_node_id not in generator_node_id_set:
                raise ValueError("generator.target_node_id must reference generator node")
            if generator_config.target_node_id in configured_targets:
                raise ValueError("generator.target_node_id values must be unique")
            configured_targets.add(generator_config.target_node_id)
            if (
                generator_config.interarrival_distribution.distribution_type
                not in GENERATOR_DISTRIBUTIONS
            ):
                raise ValueError(
                    "generator.interarrival_distribution has unsupported distribution type"
                )

        if configured_targets != generator_node_id_set:
            raise ValueError("Each generator node must have generator settings")

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


class NodePosition(BaseModel):
    x: float
    y: float


class SimulationRunRequest(BaseModel):
    model_name: str = Field(min_length=1, max_length=100)
    config: SimulationConfig
    node_positions: dict[str, NodePosition] = Field(default_factory=dict)
