from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .distributions import SampleFromDistribution
from .schemas import (
    DistributionConfig,
    EdgeConfig,
    GeneratorConfig,
    NodeConfig,
    RouteConfig,
    SimulationConfig,
)


EVENT_REQUEST_GENERATED = "request_generated"
EVENT_REQUEST_ARRIVED = "request_arrived"
EVENT_SERVICE_STARTED = "service_started"
EVENT_SERVICE_COMPLETED = "service_completed"
EVENT_REQUEST_EXITED = "request_exited"
EVENT_NODE_RECHECK = "node_recheck"


@dataclass(order=True)
class CalendarEvent:
    event_time: float
    sequence: int
    event_type: str = field(compare=False)
    request_id: str | None = field(default=None, compare=False)
    node_id: str | None = field(default=None, compare=False)
    from_node_id: str | None = field(default=None, compare=False)
    to_node_id: str | None = field(default=None, compare=False)
    details: str = field(default="", compare=False)


@dataclass
class RequestRuntime:
    request_id: str
    created_time: float
    exited_time: float | None = None


@dataclass
class NodeRuntime:
    node_id: str
    name: str
    schedule_windows: list[tuple[float, float | None]]
    channels: int
    queue: list[str] = field(default_factory=list)
    queue_arrival_times: dict[str, float] = field(default_factory=dict)
    active_service_start: dict[str, float] = field(default_factory=dict)
    planned_recheck_times: set[float] = field(default_factory=set)
    busy_channels: int = 0
    queue_area: float = 0.0
    busy_area: float = 0.0
    last_queue_time: float = 0.0
    last_busy_time: float = 0.0
    last_queue_value: int = 0
    last_busy_value: int = 0
    max_queue_value: int = 0
    arrivals: int = 0
    started: int = 0
    completed: int = 0
    waiting_times: list[float] = field(default_factory=list)
    service_times: list[float] = field(default_factory=list)

    def UpdateQueueState(self, at_time: float) -> None:
        delta = max(0.0, at_time - self.last_queue_time)
        self.queue_area += self.last_queue_value * delta
        self.last_queue_time = at_time
        self.last_queue_value = len(self.queue)
        self.max_queue_value = max(self.max_queue_value, self.last_queue_value)

    def UpdateBusyState(self, at_time: float) -> None:
        delta = max(0.0, at_time - self.last_busy_time)
        self.busy_area += self.last_busy_value * delta
        self.last_busy_time = at_time
        self.last_busy_value = self.busy_channels

    def FinalizeAccumulators(self, at_time: float) -> None:
        self.UpdateQueueState(at_time)
        self.UpdateBusyState(at_time)


def NormalizeDelay(value: float) -> float:
    if value <= 0:
        return 1e-6
    return value


def SampleGeneratorInterarrivalDelay(
    distribution: DistributionConfig,
    rng: np.random.Generator,
    interval_index_ref: list[int],
) -> float:
    if distribution.distribution_type != "intervals":
        return NormalizeDelay(SampleFromDistribution(distribution, rng))

    intervals = distribution.intervals
    if not intervals and distribution.value is not None:
        intervals = [distribution.value]

    valid_intervals = [item for item in (intervals or []) if item > 0]
    if not valid_intervals:
        valid_intervals = [1.0]

    index = interval_index_ref[0] % len(valid_intervals)
    interval_index_ref[0] += 1
    return NormalizeDelay(float(valid_intervals[index]))


def SelectRoute(routes: list[RouteConfig], rng: np.random.Generator) -> RouteConfig:
    total = sum(route.probability for route in routes)
    threshold = float(rng.uniform(0.0, total))
    cumulative = 0.0
    for route in routes:
        cumulative += route.probability
        if threshold <= cumulative:
            return route
    return routes[-1]


def FindEdge(edge_lookup: dict[str, EdgeConfig], edge_id: str) -> EdgeConfig:
    if edge_id not in edge_lookup:
        raise ValueError(f"Unknown edge_id '{edge_id}' in route")
    return edge_lookup[edge_id]


def BuildScheduleWindows(node_config: NodeConfig) -> list[tuple[float, float | None]]:
    if node_config.schedule:
        return [
            (max(0.0, interval.open_time), interval.close_time)
            for interval in node_config.schedule
        ]
    return [(max(0.0, node_config.open_time), node_config.close_time)]


def GetActiveScheduleWindow(
    schedule_windows: list[tuple[float, float | None]],
    current_time: float,
) -> tuple[float, float | None] | None:
    for open_time, close_time in schedule_windows:
        if current_time < open_time:
            return None
        if close_time is None:
            return (open_time, close_time)
        if open_time <= current_time < close_time:
            return (open_time, close_time)
    return None


def GetNextScheduleOpenTime(
    schedule_windows: list[tuple[float, float | None]],
    current_time: float,
) -> float | None:
    for open_time, _close_time in schedule_windows:
        if open_time > current_time:
            return open_time
    return None


def ComputeOpenDuration(
    schedule_windows: list[tuple[float, float | None]],
    simulation_duration: float,
) -> float:
    total_open_duration = 0.0
    for open_time, close_time in schedule_windows:
        if open_time >= simulation_duration:
            break
        effective_open = max(0.0, open_time)
        effective_close = simulation_duration if close_time is None else min(close_time, simulation_duration)
        if effective_close > effective_open:
            total_open_duration += effective_close - effective_open
    return total_open_duration


def AppendEvent(
    event_rows: list[dict[str, Any]],
    event_time: float,
    event_type: str,
    request_id: str | None,
    node: NodeRuntime | None,
    from_node_id: str | None,
    to_node_id: str | None,
    details: str = "",
) -> None:
    event_rows.append(
        {
            "event_time": round(event_time, 6),
            "event_type": event_type,
            "request_id": request_id,
            "node_id": node.node_id if node else None,
            "from_node_id": from_node_id,
            "to_node_id": to_node_id,
            "queue_length": len(node.queue) if node else 0,
            "busy_channels": node.busy_channels if node else 0,
            "details": details,
        }
    )


def ScheduleRequestByRoute(
    route: RouteConfig,
    request_id: str,
    current_time: float,
    from_node_id: str,
    simulation_duration: float,
    edge_lookup: dict[str, EdgeConfig],
    rng: np.random.Generator,
    calendar: list[CalendarEvent],
    sequence_ref: list[int],
) -> None:
    if route.target_node_id is None:
        sequence_ref[0] += 1
        heapq.heappush(
            calendar,
            CalendarEvent(
                event_time=current_time,
                sequence=sequence_ref[0],
                event_type=EVENT_REQUEST_EXITED,
                request_id=request_id,
                node_id=from_node_id,
                from_node_id=from_node_id,
            ),
        )
        return

    edge = FindEdge(edge_lookup, route.edge_id or "")
    travel_delay = NormalizeDelay(SampleFromDistribution(edge.travel_distribution, rng))
    arrival_time = current_time + travel_delay

    if arrival_time <= simulation_duration:
        sequence_ref[0] += 1
        heapq.heappush(
            calendar,
            CalendarEvent(
                event_time=arrival_time,
                sequence=sequence_ref[0],
                event_type=EVENT_REQUEST_ARRIVED,
                request_id=request_id,
                node_id=route.target_node_id,
                from_node_id=from_node_id,
                to_node_id=route.target_node_id,
                details=f"edge={edge.edge_id}",
            ),
        )
        return

    sequence_ref[0] += 1
    heapq.heappush(
        calendar,
        CalendarEvent(
            event_time=simulation_duration,
            sequence=sequence_ref[0],
            event_type=EVENT_REQUEST_EXITED,
            request_id=request_id,
            node_id=from_node_id,
            from_node_id=from_node_id,
            details="exit_on_timeout",
        ),
    )


def StartServiceIfPossible(
    node: NodeRuntime,
    node_routes: list[RouteConfig],
    node_config_lookup: dict[str, NodeConfig],
    current_time: float,
    simulation_duration: float,
    calendar: list[CalendarEvent],
    sequence_ref: list[int],
    rng: np.random.Generator,
    event_rows: list[dict[str, Any]],
) -> None:
    node_config = node_config_lookup[node.node_id]
    if node_config.node_type != "service":
        return

    if GetActiveScheduleWindow(node.schedule_windows, current_time) is None:
        next_open_time = GetNextScheduleOpenTime(node.schedule_windows, current_time)
        if (
            next_open_time is not None
            and next_open_time <= simulation_duration
            and next_open_time not in node.planned_recheck_times
        ):
            node.planned_recheck_times.add(next_open_time)
            sequence_ref[0] += 1
            heapq.heappush(
                calendar,
                CalendarEvent(
                    event_time=next_open_time,
                    sequence=sequence_ref[0],
                    event_type=EVENT_NODE_RECHECK,
                    node_id=node.node_id,
                ),
            )
        return

    while node.busy_channels < node.channels and node.queue:
        request_id = node.queue.pop(0)
        arrival_time = node.queue_arrival_times.pop(request_id)
        node.UpdateQueueState(current_time)

        wait_time = max(0.0, current_time - arrival_time)
        node.waiting_times.append(wait_time)
        node.started += 1

        node.busy_channels += 1
        node.UpdateBusyState(current_time)
        node.active_service_start[request_id] = current_time

        AppendEvent(
            event_rows=event_rows,
            event_time=current_time,
            event_type=EVENT_SERVICE_STARTED,
            request_id=request_id,
            node=node,
            from_node_id=node.node_id,
            to_node_id=node.node_id,
        )

        service_distribution = node_config.service_distribution
        if service_distribution is None:
            continue
        service_delay = NormalizeDelay(SampleFromDistribution(service_distribution, rng))
        finish_time = current_time + service_delay

        if finish_time <= simulation_duration:
            sequence_ref[0] += 1
            heapq.heappush(
                calendar,
                CalendarEvent(
                    event_time=finish_time,
                    sequence=sequence_ref[0],
                    event_type=EVENT_SERVICE_COMPLETED,
                    request_id=request_id,
                    node_id=node.node_id,
                    details=f"routes={len(node_routes)}",
                ),
            )


def RunSimulation(config: SimulationConfig) -> dict[str, Any]:
    rng = np.random.default_rng(config.random_seed)
    simulation_duration = config.simulation_duration

    node_lookup: dict[str, NodeRuntime] = {}
    node_config_lookup: dict[str, NodeConfig] = {}
    node_routes_lookup: dict[str, list[RouteConfig]] = {}
    for node_config in config.nodes:
        node_config_lookup[node_config.node_id] = node_config
        node_lookup[node_config.node_id] = NodeRuntime(
            node_id=node_config.node_id,
            name=node_config.name,
            schedule_windows=BuildScheduleWindows(node_config),
            channels=node_config.channels,
        )
        node_routes_lookup[node_config.node_id] = node_config.routes

    edge_lookup: dict[str, EdgeConfig] = {edge.edge_id: edge for edge in config.edges}
    request_lookup: dict[str, RequestRuntime] = {}

    calendar: list[CalendarEvent] = []
    sequence_ref = [0]
    generator_interval_index_refs: dict[str, list[int]] = {}
    event_rows: list[dict[str, Any]] = []

    effective_generators: list[GeneratorConfig] = (
        config.generators if config.generators else ([config.generator] if config.generator else [])
    )
    generator_config_lookup = {
        generator_config.target_node_id: generator_config
        for generator_config in effective_generators
    }
    generator_stop_time_lookup: dict[str, float] = {}

    for generator_config in effective_generators:
        target_node_id = generator_config.target_node_id
        stop_generation_time = (
            min(generator_config.stop_time, simulation_duration)
            if generator_config.stop_time is not None
            else simulation_duration
        )
        start_generation_time = max(0.0, generator_config.start_time)
        if start_generation_time > stop_generation_time:
            continue

        generator_interval_index_refs[target_node_id] = [0]
        generator_stop_time_lookup[target_node_id] = stop_generation_time

        sequence_ref[0] += 1
        heapq.heappush(
            calendar,
            CalendarEvent(
                event_time=start_generation_time,
                sequence=sequence_ref[0],
                event_type=EVENT_REQUEST_GENERATED,
                node_id=target_node_id,
            ),
        )

    created_requests = 0
    exited_requests = 0

    while calendar:
        event = heapq.heappop(calendar)
        current_time = event.event_time

        if current_time > simulation_duration:
            break

        if event.event_type == EVENT_REQUEST_GENERATED:
            if config.max_requests is not None and created_requests >= config.max_requests:
                continue
            target_node_id = event.node_id
            if target_node_id is None:
                continue

            if target_node_id not in generator_config_lookup:
                continue

            if target_node_id not in generator_stop_time_lookup:
                continue

            stop_generation_time = generator_stop_time_lookup[target_node_id]
            if current_time > stop_generation_time:
                continue

            created_requests += 1
            request_id = f"request_{created_requests}"
            request_lookup[request_id] = RequestRuntime(
                request_id=request_id,
                created_time=current_time,
            )

            target_node = node_lookup[target_node_id]

            AppendEvent(
                event_rows=event_rows,
                event_time=current_time,
                event_type=EVENT_REQUEST_GENERATED,
                request_id=request_id,
                node=target_node,
                from_node_id=None,
                to_node_id=target_node_id,
            )

            sequence_ref[0] += 1
            heapq.heappush(
                calendar,
                CalendarEvent(
                    event_time=current_time,
                    sequence=sequence_ref[0],
                    event_type=EVENT_REQUEST_ARRIVED,
                    request_id=request_id,
                    node_id=target_node_id,
                    to_node_id=target_node_id,
                ),
            )

            interarrival_delay = SampleGeneratorInterarrivalDelay(
                generator_config_lookup[target_node_id].interarrival_distribution,
                rng,
                generator_interval_index_refs[target_node_id],
            )
            next_generation_time = current_time + interarrival_delay
            if next_generation_time <= stop_generation_time:
                sequence_ref[0] += 1
                heapq.heappush(
                    calendar,
                    CalendarEvent(
                        event_time=next_generation_time,
                        sequence=sequence_ref[0],
                        event_type=EVENT_REQUEST_GENERATED,
                        node_id=target_node_id,
                    ),
                )
            continue

        if event.event_type == EVENT_REQUEST_ARRIVED and event.node_id and event.request_id:
            node = node_lookup[event.node_id]
            node_config = node_config_lookup[event.node_id]
            node.arrivals += 1

            if node_config.node_type == "exit":
                AppendEvent(
                    event_rows=event_rows,
                    event_time=current_time,
                    event_type=EVENT_REQUEST_ARRIVED,
                    request_id=event.request_id,
                    node=node,
                    from_node_id=event.from_node_id,
                    to_node_id=node.node_id,
                )
                sequence_ref[0] += 1
                heapq.heappush(
                    calendar,
                    CalendarEvent(
                        event_time=current_time,
                        sequence=sequence_ref[0],
                        event_type=EVENT_REQUEST_EXITED,
                        request_id=event.request_id,
                        node_id=node.node_id,
                        from_node_id=event.from_node_id or node.node_id,
                    ),
                )
                continue

            if node_config.node_type == "generator":
                AppendEvent(
                    event_rows=event_rows,
                    event_time=current_time,
                    event_type=EVENT_REQUEST_ARRIVED,
                    request_id=event.request_id,
                    node=node,
                    from_node_id=event.from_node_id,
                    to_node_id=node.node_id,
                )
                route = SelectRoute(node_routes_lookup[node.node_id], rng)
                ScheduleRequestByRoute(
                    route=route,
                    request_id=event.request_id,
                    current_time=current_time,
                    from_node_id=node.node_id,
                    simulation_duration=simulation_duration,
                    edge_lookup=edge_lookup,
                    rng=rng,
                    calendar=calendar,
                    sequence_ref=sequence_ref,
                )
                continue

            node.queue.append(event.request_id)
            node.queue_arrival_times[event.request_id] = current_time
            node.UpdateQueueState(current_time)

            AppendEvent(
                event_rows=event_rows,
                event_time=current_time,
                event_type=EVENT_REQUEST_ARRIVED,
                request_id=event.request_id,
                node=node,
                from_node_id=event.from_node_id,
                to_node_id=node.node_id,
            )

            StartServiceIfPossible(
                node=node,
                node_routes=node_routes_lookup[node.node_id],
                node_config_lookup=node_config_lookup,
                current_time=current_time,
                simulation_duration=simulation_duration,
                calendar=calendar,
                sequence_ref=sequence_ref,
                rng=rng,
                event_rows=event_rows,
            )
            continue

        if event.event_type == EVENT_NODE_RECHECK and event.node_id:
            node = node_lookup[event.node_id]
            node.planned_recheck_times.discard(current_time)
            StartServiceIfPossible(
                node=node,
                node_routes=node_routes_lookup[node.node_id],
                node_config_lookup=node_config_lookup,
                current_time=current_time,
                simulation_duration=simulation_duration,
                calendar=calendar,
                sequence_ref=sequence_ref,
                rng=rng,
                event_rows=event_rows,
            )
            continue

        if event.event_type == EVENT_SERVICE_COMPLETED and event.node_id and event.request_id:
            node = node_lookup[event.node_id]
            request_id = event.request_id
            if request_id not in node.active_service_start:
                continue

            service_started_time = node.active_service_start.pop(request_id)
            service_duration = max(0.0, current_time - service_started_time)
            node.service_times.append(service_duration)
            node.completed += 1

            node.busy_channels = max(0, node.busy_channels - 1)
            node.UpdateBusyState(current_time)

            AppendEvent(
                event_rows=event_rows,
                event_time=current_time,
                event_type=EVENT_SERVICE_COMPLETED,
                request_id=request_id,
                node=node,
                from_node_id=node.node_id,
                to_node_id=node.node_id,
            )

            route = SelectRoute(node_routes_lookup[node.node_id], rng)
            ScheduleRequestByRoute(
                route=route,
                request_id=request_id,
                current_time=current_time,
                from_node_id=node.node_id,
                simulation_duration=simulation_duration,
                edge_lookup=edge_lookup,
                rng=rng,
                calendar=calendar,
                sequence_ref=sequence_ref,
            )

            StartServiceIfPossible(
                node=node,
                node_routes=node_routes_lookup[node.node_id],
                node_config_lookup=node_config_lookup,
                current_time=current_time,
                simulation_duration=simulation_duration,
                calendar=calendar,
                sequence_ref=sequence_ref,
                rng=rng,
                event_rows=event_rows,
            )
            continue

        if event.event_type == EVENT_REQUEST_EXITED and event.request_id:
            exited_requests += 1
            request = request_lookup.get(event.request_id)
            if request:
                request.exited_time = current_time

            node = node_lookup.get(event.node_id) if event.node_id else None
            AppendEvent(
                event_rows=event_rows,
                event_time=current_time,
                event_type=EVENT_REQUEST_EXITED,
                request_id=event.request_id,
                node=node,
                from_node_id=event.from_node_id,
                to_node_id=None,
            )
            continue

    for node in node_lookup.values():
        node.FinalizeAccumulators(simulation_duration)

    metrics_rows: list[dict[str, Any]] = []
    for node in node_lookup.values():
        schedule_window = max(1e-9, ComputeOpenDuration(node.schedule_windows, simulation_duration))
        utilization = node.busy_area / (node.channels * schedule_window)

        metrics_rows.append(
            {
                "node_id": node.node_id,
                "node_name": node.name,
                "arrivals": node.arrivals,
                "started": node.started,
                "completed": node.completed,
                "average_queue_length": node.queue_area / simulation_duration,
                "max_queue_length": node.max_queue_value,
                "average_waiting_time": float(np.mean(node.waiting_times))
                if node.waiting_times
                else 0.0,
                "average_service_time": float(np.mean(node.service_times))
                if node.service_times
                else 0.0,
                "utilization": min(1.0, max(0.0, utilization)),
            }
        )

    finished_requests = [
        request.exited_time - request.created_time
        for request in request_lookup.values()
        if request.exited_time is not None
    ]

    summary = {
        "simulation_duration": simulation_duration,
        "requests_created": created_requests,
        "requests_exited": exited_requests,
        "requests_in_system": max(0, created_requests - exited_requests),
        "average_time_in_system": float(np.mean(finished_requests)) if finished_requests else 0.0,
        "throughput": exited_requests / simulation_duration if simulation_duration > 0 else 0.0,
        "events_count": len(event_rows),
    }

    events_df = pd.DataFrame(event_rows)
    metrics_df = pd.DataFrame(metrics_rows)

    return {
        "events": events_df,
        "metrics": metrics_df,
        "summary": summary,
    }
