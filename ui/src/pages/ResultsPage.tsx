import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import { GetRunById } from "../api/client";
import { DismissibleError } from "../components/DismissibleError";
import type { NodeConfig, RunData } from "../types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
);

type GlobalChartType =
  | "utilization"
  | "min_queue"
  | "average_queue"
  | "max_queue"
  | "average_service_time";

interface PlaybackEvent {
  original_index: number;
  event_time: number;
  event_type: string;
  request_id: string | null;
  node_id: string | null;
  from_node_id: string | null;
  to_node_id: string | null;
  queue_length: number;
  busy_channels: number;
}

interface NodePosition {
  x: number;
  y: number;
}

interface RequestSnapshot {
  request_id: string;
  node_id: string | null;
  state: "queued" | "serving" | "idle" | "exited";
}

interface PlaybackSnapshot {
  request_states: Record<string, RequestSnapshot>;
  queue_by_node: Record<string, string[]>;
  queue_lengths_by_node: Record<string, number>;
  busy_by_node: Record<string, number>;
  current_time: number;
}

interface MovementAnimation {
  request_id: string;
  from_node_id: string;
  to_node_id: string;
  started_at: number;
  finished_at: number;
}

interface QueueStats {
  min_queue: number;
  average_queue: number;
  max_queue: number;
}

type ViewInteractionState =
  | { interaction_type: "none" }
  | {
      interaction_type: "panning";
      start_client_x: number;
      start_client_y: number;
      start_pan_x: number;
      start_pan_y: number;
    }
  | {
      interaction_type: "dragging_node";
      node_id: string;
      start_client_x: number;
      start_client_y: number;
      start_node_x: number;
      start_node_y: number;
    };

const model_world_width = 1640;
const model_world_height = 960;
const model_node_width = 220;
const model_node_height = 130;
const min_model_zoom = 0.45;
const max_model_zoom = 2.4;

const global_chart_options: Array<{
  value: GlobalChartType;
  label: string;
  color: string;
}> = [
  { value: "utilization", label: "Загруженность узлов (%)", color: "#e9a227" },
  { value: "min_queue", label: "Минимальная очередь по узлам", color: "#0a9396" },
  { value: "average_queue", label: "Средняя очередь по узлам", color: "#2f4b7c" },
  { value: "max_queue", label: "Максимальная очередь по узлам", color: "#d1495b" },
  { value: "average_service_time", label: "Время обработки заявок", color: "#5e548e" },
];

const metric_label_by_key: Record<string, string> = {
  created_at: "Создано",
  model_name: "Название модели",
  simulation_duration: "Длительность моделирования",
  requests_created: "Создано заявок",
  requests_exited: "Завершено заявок",
  requests_in_system: "Заявок в системе",
  average_time_in_system: "Среднее время в системе",
  throughput: "Пропускная способность",
  events_count: "Количество событий",
  node_id: "Идентификатор узла",
  node_name: "Название узла",
  arrivals: "Поступило заявок",
  started: "Начато обработок",
  completed: "Завершено обработок",
  average_queue_length: "Средний размер очереди",
  max_queue_length: "Максимальный размер очереди",
  average_waiting_time: "Среднее время ожидания",
  average_service_time: "Среднее время обработки",
  utilization: "Загруженность",
};

function ParseNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function ParseNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function FormatMetricDisplayValue(value: unknown): string {
  const FormatNumber = (number_value: number): string => {
    if (!Number.isFinite(number_value)) {
      return "—";
    }
    if (Number.isInteger(number_value)) {
      return String(number_value);
    }
    return number_value.toFixed(3);
  };

  if (typeof value === "number") {
    return FormatNumber(value);
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return value;
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return FormatNumber(parsed);
    }
    return value;
  }

  if (value === null || value === undefined) {
    return "—";
  }

  return String(value);
}

function GetMetricLabel(metric_key: string): string {
  const normalized_key = metric_key.trim();
  const known_label = metric_label_by_key[normalized_key];
  if (known_label) {
    return known_label;
  }

  const readable_label = normalized_key.replace(/_+/g, " ").trim();
  if (!readable_label) {
    return "Метрика";
  }
  if (/[A-Za-z]/.test(readable_label)) {
    return "Дополнительная метрика";
  }
  return readable_label;
}

function FormatCreatedAt(value: unknown): { time_label: string; date_label: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed_date = new Date(value);
  if (Number.isNaN(parsed_date.getTime())) {
    return null;
  }

  return {
    time_label: new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(parsed_date),
    date_label: new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(parsed_date),
  };
}

function ClampModelZoom(value: number): number {
  return Math.max(min_model_zoom, Math.min(max_model_zoom, value));
}

function BuildPlaybackEvents(raw_events: Array<Record<string, string | number | null>>): PlaybackEvent[] {
  return raw_events
    .map((raw_event, index) => ({
      original_index: index,
      event_time: ParseNumber(raw_event.event_time, 0),
      event_type: String(raw_event.event_type ?? ""),
      request_id: ParseNullableString(raw_event.request_id),
      node_id: ParseNullableString(raw_event.node_id),
      from_node_id: ParseNullableString(raw_event.from_node_id),
      to_node_id: ParseNullableString(raw_event.to_node_id),
      queue_length: ParseNumber(raw_event.queue_length, 0),
      busy_channels: ParseNumber(raw_event.busy_channels, 0),
    }))
    .sort((first, second) => {
      if (first.event_time === second.event_time) {
        return first.original_index - second.original_index;
      }
      return first.event_time - second.event_time;
    });
}

function BuildNodePositions(nodes: NodeConfig[]): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  if (nodes.length === 0) {
    return positions;
  }

  const columns = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.ceil(nodes.length / columns);
  const horizontal_step = Math.max(230, (model_world_width - 160) / columns);
  const vertical_step = Math.max(160, (model_world_height - 140) / rows);

  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions[node.node_id] = {
      x: 60 + column * horizontal_step,
      y: 70 + row * vertical_step,
    };
  });

  return positions;
}

function BuildSnapshot(
  events: PlaybackEvent[],
  node_ids: string[],
  current_event_index: number,
): PlaybackSnapshot {
  const queue_by_node: Record<string, string[]> = {};
  const queue_lengths_by_node: Record<string, number> = {};
  const busy_by_node: Record<string, number> = {};
  for (const node_id of node_ids) {
    queue_by_node[node_id] = [];
    queue_lengths_by_node[node_id] = 0;
    busy_by_node[node_id] = 0;
  }

  const request_states: Record<string, RequestSnapshot> = {};
  let current_time = 0;
  if (current_event_index < 0) {
    return {
      request_states,
      queue_by_node,
      queue_lengths_by_node,
      busy_by_node,
      current_time,
    };
  }

  for (let index = 0; index <= current_event_index; index += 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    current_time = event.event_time;
    const node_id = event.node_id;
    const request_id = event.request_id;

    if (node_id && queue_lengths_by_node[node_id] !== undefined) {
      queue_lengths_by_node[node_id] = Math.max(0, event.queue_length);
      busy_by_node[node_id] = Math.max(0, event.busy_channels);
    }

    if (event.event_type === "request_arrived" && request_id && node_id) {
      const queue = queue_by_node[node_id];
      if (queue && !queue.includes(request_id)) {
        queue.push(request_id);
      }
      request_states[request_id] = {
        request_id,
        node_id,
        state: "queued",
      };
      continue;
    }

    if (event.event_type === "service_started" && request_id && node_id) {
      queue_by_node[node_id] = queue_by_node[node_id].filter((item) => item !== request_id);
      request_states[request_id] = {
        request_id,
        node_id,
        state: "serving",
      };
      continue;
    }

    if (event.event_type === "service_completed" && request_id && node_id) {
      request_states[request_id] = {
        request_id,
        node_id,
        state: "idle",
      };
      continue;
    }

    if (event.event_type === "request_exited" && request_id) {
      const previous_state = request_states[request_id];
      if (previous_state?.node_id) {
        queue_by_node[previous_state.node_id] = queue_by_node[previous_state.node_id].filter(
          (item) => item !== request_id,
        );
      }
      request_states[request_id] = {
        request_id,
        node_id: null,
        state: "exited",
      };
    }
  }

  return {
    request_states,
    queue_by_node,
    queue_lengths_by_node,
    busy_by_node,
    current_time,
  };
}

function DownsampleEvents(events: PlaybackEvent[], max_points = 350): PlaybackEvent[] {
  if (events.length <= max_points) {
    return events;
  }
  const step = Math.ceil(events.length / max_points);
  const result: PlaybackEvent[] = [];
  for (let index = 0; index < events.length; index += step) {
    result.push(events[index]);
  }
  if (result[result.length - 1] !== events[events.length - 1]) {
    result.push(events[events.length - 1]);
  }
  return result;
}

function GetNodeDisplayName(node: NodeConfig): string {
  return `${node.name} (${node.node_id})`;
}

function BuildQueueStatsByNode(events: PlaybackEvent[], node_ids: string[]): Record<string, QueueStats> {
  const accumulators: Record<
    string,
    {
      min_queue: number;
      max_queue: number;
      sum_queue: number;
      count: number;
    }
  > = {};

  for (const node_id of node_ids) {
    accumulators[node_id] = {
      min_queue: Number.POSITIVE_INFINITY,
      max_queue: 0,
      sum_queue: 0,
      count: 0,
    };
  }

  for (const event of events) {
    if (!event.node_id || !accumulators[event.node_id]) {
      continue;
    }
    const value = Math.max(0, event.queue_length);
    const accumulator = accumulators[event.node_id];
    accumulator.min_queue = Math.min(accumulator.min_queue, value);
    accumulator.max_queue = Math.max(accumulator.max_queue, value);
    accumulator.sum_queue += value;
    accumulator.count += 1;
  }

  const result: Record<string, QueueStats> = {};
  for (const node_id of node_ids) {
    const accumulator = accumulators[node_id];
    if (!accumulator || accumulator.count === 0) {
      result[node_id] = {
        min_queue: 0,
        average_queue: 0,
        max_queue: 0,
      };
      continue;
    }
    result[node_id] = {
      min_queue: accumulator.min_queue === Number.POSITIVE_INFINITY ? 0 : accumulator.min_queue,
      average_queue: accumulator.sum_queue / accumulator.count,
      max_queue: accumulator.max_queue,
    };
  }

  return result;
}

function IsNodeOpen(node: NodeConfig, current_time: number): boolean {
  return current_time >= node.open_time && (node.close_time === null || current_time < node.close_time);
}

export function ResultsPage() {
  const { run_id } = useParams<{ run_id: string }>();

  const [run_data, setRunData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [current_event_index, setCurrentEventIndex] = useState(-1);
  const [is_playing, setIsPlaying] = useState(false);
  const [playback_speed, setPlaybackSpeed] = useState(4);
  const [selected_node_id, setSelectedNodeId] = useState<string | null>(null);
  const [selected_global_chart, setSelectedGlobalChart] = useState<GlobalChartType>("utilization");

  const [active_movements, setActiveMovements] = useState<MovementAnimation[]>([]);
  const [animation_now, setAnimationNow] = useState(0);
  const [node_positions, setNodePositions] = useState<Record<string, NodePosition>>({});

  const [model_zoom, setModelZoom] = useState(1);
  const [model_pan_x, setModelPanX] = useState(0);
  const [model_pan_y, setModelPanY] = useState(0);
  const [view_interaction, setViewInteraction] = useState<ViewInteractionState>({
    interaction_type: "none",
  });

  const previous_event_index_ref = useRef(-1);

  useEffect(() => {
    if (typeof run_id !== "string") {
      setError("Не передан run_id");
      setLoading(false);
      return;
    }

    const current_run_id = run_id;
    let disposed = false;

    async function LoadRunData() {
      setLoading(true);
      setError(null);
      try {
        const data = await GetRunById(current_run_id);
        if (!disposed) {
          setRunData(data);
        }
      } catch {
        if (!disposed) {
          setError("Не удалось загрузить результаты моделирования");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void LoadRunData();

    return () => {
      disposed = true;
    };
  }, [run_id]);

  const simulation_nodes = useMemo(() => run_data?.model.config.nodes ?? [], [run_data]);
  const simulation_edges = useMemo(() => run_data?.model.config.edges ?? [], [run_data]);
  const node_ids = useMemo(() => simulation_nodes.map((node) => node.node_id), [simulation_nodes]);
  const playback_events = useMemo(
    () => BuildPlaybackEvents(run_data?.events ?? []),
    [run_data?.events],
  );
  const max_event_index = playback_events.length - 1;

  useEffect(() => {
    if (simulation_nodes.length === 0) {
      setSelectedNodeId(null);
      return;
    }

    setSelectedNodeId((current) => {
      if (current && simulation_nodes.some((node) => node.node_id === current)) {
        return current;
      }
      return simulation_nodes[0].node_id;
    });
  }, [simulation_nodes]);

  useEffect(() => {
    setNodePositions((current_positions) => {
      const default_positions = BuildNodePositions(simulation_nodes);
      const next_positions: Record<string, NodePosition> = {};
      for (const node of simulation_nodes) {
        next_positions[node.node_id] =
          current_positions[node.node_id] ?? default_positions[node.node_id] ?? { x: 0, y: 0 };
      }
      return next_positions;
    });
  }, [simulation_nodes]);

  useEffect(() => {
    setCurrentEventIndex(-1);
    setIsPlaying(false);
    setActiveMovements([]);
    previous_event_index_ref.current = -1;
    setModelZoom(1);
    setModelPanX(0);
    setModelPanY(0);
  }, [run_data?.run_id]);

  useEffect(() => {
    if (!is_playing || max_event_index < 0) {
      return;
    }

    const timeout_ms = Math.max(16, Math.round(1000 / playback_speed));
    const timer = window.setInterval(() => {
      setCurrentEventIndex((current) => {
        if (current >= max_event_index) {
          return max_event_index;
        }
        return current + 1;
      });
    }, timeout_ms);

    return () => {
      window.clearInterval(timer);
    };
  }, [is_playing, max_event_index, playback_speed]);

  useEffect(() => {
    if (is_playing && current_event_index >= max_event_index && max_event_index >= 0) {
      setIsPlaying(false);
    }
  }, [current_event_index, is_playing, max_event_index]);

  useEffect(() => {
    const previous_index = previous_event_index_ref.current;
    if (current_event_index < previous_index) {
      setActiveMovements([]);
    }

    if (current_event_index > previous_index) {
      const now = performance.now();
      const movement_duration = Math.max(220, Math.min(1000, 950 / playback_speed));
      const next_movements: MovementAnimation[] = [];

      for (let index = previous_index + 1; index <= current_event_index; index += 1) {
        const event = playback_events[index];
        if (
          event &&
          event.event_type === "request_arrived" &&
          event.request_id &&
          event.from_node_id &&
          event.to_node_id &&
          event.from_node_id !== event.to_node_id
        ) {
          const offset = (index - (previous_index + 1)) * 22;
          next_movements.push({
            request_id: event.request_id,
            from_node_id: event.from_node_id,
            to_node_id: event.to_node_id,
            started_at: now + offset,
            finished_at: now + offset + movement_duration,
          });
        }
      }

      if (next_movements.length > 0) {
        setActiveMovements((current) => [...current, ...next_movements]);
      }
    }

    previous_event_index_ref.current = current_event_index;
  }, [current_event_index, playback_events, playback_speed]);

  useEffect(() => {
    if (active_movements.length === 0) {
      return;
    }

    let frame_id = 0;
    function Tick() {
      const now = performance.now();
      setAnimationNow(now);
      setActiveMovements((current) => current.filter((movement) => movement.finished_at > now));
      frame_id = window.requestAnimationFrame(Tick);
    }
    frame_id = window.requestAnimationFrame(Tick);

    return () => {
      window.cancelAnimationFrame(frame_id);
    };
  }, [active_movements.length]);

  useEffect(() => {
    if (view_interaction.interaction_type === "none") {
      return;
    }

    const interaction = view_interaction;
    function HandleMouseMove(event: MouseEvent) {
      if (interaction.interaction_type === "panning") {
        const delta_x = event.clientX - interaction.start_client_x;
        const delta_y = event.clientY - interaction.start_client_y;
        setModelPanX(interaction.start_pan_x + delta_x);
        setModelPanY(interaction.start_pan_y + delta_y);
        return;
      }

      const delta_x = (event.clientX - interaction.start_client_x) / model_zoom;
      const delta_y = (event.clientY - interaction.start_client_y) / model_zoom;
      const next_x = Math.max(
        0,
        Math.min(model_world_width - model_node_width, interaction.start_node_x + delta_x),
      );
      const next_y = Math.max(
        0,
        Math.min(model_world_height - model_node_height, interaction.start_node_y + delta_y),
      );

      setNodePositions((current) => ({
        ...current,
        [interaction.node_id]: { x: next_x, y: next_y },
      }));
    }

    function HandleMouseUp() {
      setViewInteraction({ interaction_type: "none" });
    }

    window.addEventListener("mousemove", HandleMouseMove);
    window.addEventListener("mouseup", HandleMouseUp);

    return () => {
      window.removeEventListener("mousemove", HandleMouseMove);
      window.removeEventListener("mouseup", HandleMouseUp);
    };
  }, [model_zoom, view_interaction]);

  const playback_snapshot = useMemo(
    () => BuildSnapshot(playback_events, node_ids, current_event_index),
    [current_event_index, node_ids, playback_events],
  );

  const total_request_ids_by_node = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const node_id of node_ids) {
      result[node_id] = [];
    }
    for (const request_state of Object.values(playback_snapshot.request_states)) {
      if (request_state.state === "exited" || !request_state.node_id) {
        continue;
      }
      result[request_state.node_id] = result[request_state.node_id] ?? [];
      result[request_state.node_id].push(request_state.request_id);
    }
    return result;
  }, [node_ids, playback_snapshot.request_states]);

  const serving_request_ids_by_node = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const node_id of node_ids) {
      result[node_id] = [];
    }
    for (const request_state of Object.values(playback_snapshot.request_states)) {
      if (request_state.state !== "serving" || !request_state.node_id) {
        continue;
      }
      result[request_state.node_id] = result[request_state.node_id] ?? [];
      result[request_state.node_id].push(request_state.request_id);
    }
    return result;
  }, [node_ids, playback_snapshot.request_states]);

  const edge_visuals = useMemo(() => {
    return simulation_edges
      .map((edge) => {
        const source = node_positions[edge.source_node_id];
        const target = node_positions[edge.target_node_id];
        if (!source || !target) {
          return null;
        }
        const x1 = source.x + model_node_width;
        const y1 = source.y + model_node_height * 0.5;
        const x2 = target.x;
        const y2 = target.y + model_node_height * 0.5;
        return {
          edge,
          x1,
          y1,
          x2,
          y2,
          mid_x: (x1 + x2) * 0.5,
          mid_y: (y1 + y2) * 0.5,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
  }, [node_positions, simulation_edges]);

  const moving_tokens = useMemo(() => {
    return active_movements
      .map((movement) => {
        const source = node_positions[movement.from_node_id];
        const target = node_positions[movement.to_node_id];
        if (!source || !target) {
          return null;
        }
        const progress = Math.min(
          1,
          Math.max(0, (animation_now - movement.started_at) / (movement.finished_at - movement.started_at)),
        );
        const source_x = source.x + model_node_width * 0.88;
        const source_y = source.y + model_node_height * 0.5;
        const target_x = target.x + model_node_width * 0.12;
        const target_y = target.y + model_node_height * 0.5;
        return {
          request_id: movement.request_id,
          x: source_x + (target_x - source_x) * progress,
          y: source_y + (target_y - source_y) * progress,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
  }, [active_movements, animation_now, node_positions]);

  const sampled_events = useMemo(() => DownsampleEvents(playback_events), [playback_events]);

  const metric_row_by_node_id = useMemo(() => {
    const lookup = new Map<string, Record<string, string | number | null>>();
    if (!run_data) {
      return lookup;
    }
    for (const row of run_data.metrics) {
      const node_id = ParseNullableString(row.node_id);
      if (node_id) {
        lookup.set(node_id, row);
      }
    }
    return lookup;
  }, [run_data]);

  const queue_stats_by_node = useMemo(
    () => BuildQueueStatsByNode(playback_events, node_ids),
    [node_ids, playback_events],
  );

  const selected_node = simulation_nodes.find((node) => node.node_id === selected_node_id) ?? null;
  const current_event = current_event_index >= 0 ? playback_events[current_event_index] : null;

  const selected_node_events = useMemo(() => {
    if (!selected_node_id) {
      return [];
    }
    return sampled_events.filter((event) => event.node_id === selected_node_id);
  }, [sampled_events, selected_node_id]);

  const selected_node_metric_row = useMemo(() => {
    if (!selected_node_id) {
      return null;
    }
    return metric_row_by_node_id.get(selected_node_id) ?? null;
  }, [metric_row_by_node_id, selected_node_id]);

  const summary_entries = useMemo(
    () => Object.entries(run_data?.summary ?? {}).filter(([key]) => key !== "task_id"),
    [run_data?.summary],
  );

  const metrics_column_names = useMemo(
    () => Object.keys(run_data?.metrics[0] ?? {}).filter((column_name) => column_name !== "task_id"),
    [run_data?.metrics],
  );

  const global_chart_data = useMemo(() => {
    const option = global_chart_options.find((item) => item.value === selected_global_chart) ?? global_chart_options[0];
    const labels = simulation_nodes.map((node) => GetNodeDisplayName(node));
    const data = simulation_nodes.map((node) => {
      const metrics_row = metric_row_by_node_id.get(node.node_id);
      const queue_stats = queue_stats_by_node[node.node_id] ?? {
        min_queue: 0,
        average_queue: 0,
        max_queue: 0,
      };

      if (option.value === "utilization") {
        return ParseNumber(metrics_row?.utilization, 0) * 100;
      }
      if (option.value === "min_queue") {
        return queue_stats.min_queue;
      }
      if (option.value === "average_queue") {
        const value = ParseNumber(metrics_row?.average_queue_length, Number.NaN);
        return Number.isFinite(value) ? value : queue_stats.average_queue;
      }
      if (option.value === "max_queue") {
        const value = ParseNumber(metrics_row?.max_queue_length, Number.NaN);
        return Number.isFinite(value) ? value : queue_stats.max_queue;
      }
      return ParseNumber(metrics_row?.average_service_time, 0);
    });

    return {
      labels,
      datasets: [
        {
          label: option.label,
          data,
          backgroundColor: option.color,
        },
      ],
    };
  }, [metric_row_by_node_id, queue_stats_by_node, selected_global_chart, simulation_nodes]);

  const selected_node_queue_chart_data = useMemo(() => {
    return {
      labels: selected_node_events.map((event) => event.event_time.toFixed(2)),
      datasets: [
        {
          label: "Размер очереди",
          data: selected_node_events.map((event) => event.queue_length),
          borderColor: "#0a9396",
          backgroundColor: "rgba(10, 147, 150, 0.2)",
        },
      ],
    };
  }, [selected_node_events]);

  const selected_node_utilization_chart_data = useMemo(() => {
    const channels = Math.max(1, selected_node?.channels ?? 1);
    return {
      labels: selected_node_events.map((event) => event.event_time.toFixed(2)),
      datasets: [
        {
          label: "Загруженность (%)",
          data: selected_node_events.map((event) => (event.busy_channels / channels) * 100),
          borderColor: "#d1495b",
          backgroundColor: "rgba(209, 73, 91, 0.2)",
        },
      ],
    };
  }, [selected_node?.channels, selected_node_events]);

  const global_bar_chart_options = useMemo(
    () => ({
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: 12, usePointStyle: true, pointStyle: "rectRounded" as const },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0, minRotation: 0 },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(56, 78, 95, 0.12)" },
        },
      },
    }),
    [],
  );

  const node_line_chart_options = useMemo(
    () => ({
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: 12, usePointStyle: true, pointStyle: "circle" as const },
        },
      },
      interaction: {
        mode: "index" as const,
        intersect: false,
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8 },
          grid: { color: "rgba(56, 78, 95, 0.08)" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(56, 78, 95, 0.12)" },
        },
      },
      elements: {
        line: {
          tension: 0.28,
          borderWidth: 2.2,
        },
        point: {
          radius: 0,
          hoverRadius: 3,
        },
      },
    }),
    [],
  );

  function HandleStartPlayback() {
    if (max_event_index < 0) {
      return;
    }
    if (current_event_index >= max_event_index) {
      setCurrentEventIndex(-1);
      previous_event_index_ref.current = -1;
      setActiveMovements([]);
    }
    setIsPlaying(true);
  }

  function HandlePausePlayback() {
    setIsPlaying(false);
  }

  function HandleStepForward() {
    setIsPlaying(false);
    setCurrentEventIndex((current) => Math.min(max_event_index, current + 1));
  }

  function HandleStepBackward() {
    setIsPlaying(false);
    setCurrentEventIndex((current) => Math.max(-1, current - 1));
    setActiveMovements([]);
  }

  function HandleJumpToIndex(next_index: number) {
    setIsPlaying(false);
    setCurrentEventIndex(Math.max(-1, Math.min(max_event_index, next_index)));
    setActiveMovements([]);
  }

  function HandleSelectNextNode(direction: "prev" | "next") {
    if (!selected_node_id) {
      return;
    }
    const current_index = node_ids.indexOf(selected_node_id);
    if (current_index === -1) {
      return;
    }
    if (direction === "prev" && current_index > 0) {
      setSelectedNodeId(node_ids[current_index - 1]);
    }
    if (direction === "next" && current_index < node_ids.length - 1) {
      setSelectedNodeId(node_ids[current_index + 1]);
    }
  }

  function HandleSetModelZoom(next_zoom: number) {
    setModelZoom(ClampModelZoom(next_zoom));
  }

  function HandleViewportMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("[data-result-node-card]")) {
      return;
    }

    setViewInteraction({
      interaction_type: "panning",
      start_client_x: event.clientX,
      start_client_y: event.clientY,
      start_pan_x: model_pan_x,
      start_pan_y: model_pan_y,
    });
    event.preventDefault();
  }

  function HandleNodeMouseDown(event: ReactMouseEvent<HTMLElement>, node_id: string) {
    if (event.button !== 0) {
      return;
    }

    const node_position = node_positions[node_id];
    if (!node_position) {
      return;
    }

    setViewInteraction({
      interaction_type: "dragging_node",
      node_id,
      start_client_x: event.clientX,
      start_client_y: event.clientY,
      start_node_x: node_position.x,
      start_node_y: node_position.y,
    });

    event.stopPropagation();
    event.preventDefault();
  }

  if (loading) {
    return (
      <section className="page-panel">
        <h2>Результаты моделирования</h2>
        <div>Загрузка...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="page-panel">
        <h2>Результаты моделирования</h2>
        <DismissibleError message={error} on_dismiss={() => setError(null)} />
      </section>
    );
  }

  if (!run_data) {
    return (
      <section className="page-panel">
        <h2>Результаты моделирования</h2>
        <div className="muted-text">Нет данных</div>
      </section>
    );
  }

  const selected_node_is_open =
    selected_node !== null ? IsNodeOpen(selected_node, playback_snapshot.current_time) : false;
  const selected_node_busy =
    selected_node !== null ? playback_snapshot.busy_by_node[selected_node.node_id] ?? 0 : 0;
  const selected_node_total =
    selected_node !== null ? total_request_ids_by_node[selected_node.node_id]?.length ?? 0 : 0;
  const selected_node_serving =
    selected_node !== null ? serving_request_ids_by_node[selected_node.node_id]?.length ?? 0 : 0;
  const selected_node_queue =
    selected_node !== null ? playback_snapshot.queue_lengths_by_node[selected_node.node_id] ?? 0 : 0;
  const selected_node_is_service = selected_node !== null && selected_node.node_type === "service";

  return (
    <section className="page-panel results-page-shell">
      <h2>Результаты: {run_data.model.model_name}</h2>

      <div className="results-main-grid">
        <section className="results-visual-column">
          <div className="summary-grid">
            {summary_entries.map(([key, value]) => {
              const formatted_created_at = key === "created_at" ? FormatCreatedAt(value) : null;
              return (
                <div key={key} className="summary-item">
                  <strong>{GetMetricLabel(key)}</strong>
                  {formatted_created_at ? (
                    <span className="summary-datetime">
                      <span className="summary-datetime-time">{formatted_created_at.time_label}</span>
                      <span className="summary-datetime-date">{formatted_created_at.date_label}</span>
                    </span>
                  ) : (
                    <span>{FormatMetricDisplayValue(value)}</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="result-player-panel">
            <div className="result-player-controls">
              <button type="button" onClick={HandleStartPlayback} disabled={playback_events.length === 0}>
                Старт
              </button>
              <button type="button" className="secondary" onClick={HandlePausePlayback}>
                Стоп
              </button>
              <button type="button" className="secondary" onClick={HandleStepBackward}>
                Шаг назад
              </button>
              <button type="button" className="secondary" onClick={HandleStepForward}>
                Шаг вперед
              </button>

              <div className="result-zoom-controls">
                <span>Масштаб: {Math.round(model_zoom * 100)}%</span>
                <button type="button" className="secondary" onClick={() => HandleSetModelZoom(model_zoom - 0.1)}>
                  -
                </button>
                <input
                  type="range"
                  min={min_model_zoom}
                  max={max_model_zoom}
                  step={0.05}
                  value={model_zoom}
                  onChange={(event) => HandleSetModelZoom(ParseNumber(event.target.value, 1))}
                />
                <button type="button" className="secondary" onClick={() => HandleSetModelZoom(model_zoom + 0.1)}>
                  +
                </button>
                <button type="button" className="secondary" onClick={() => HandleSetModelZoom(1)}>
                  100%
                </button>
              </div>

              <label className="speed-control">
                Скорость: {playback_speed} соб./с
                <input
                  type="range"
                  min={1}
                  max={60}
                  step={1}
                  value={playback_speed}
                  onChange={(event) => setPlaybackSpeed(ParseNumber(event.target.value, 4))}
                />
              </label>
            </div>

            <div className="result-player-info">
              <span>
                Событие: {Math.max(0, current_event_index + 1)} / {playback_events.length}
              </span>
              <span>Время модели: {playback_snapshot.current_time.toFixed(3)}</span>
              {current_event ? (
                <span>
                  Текущее событие: <strong>{current_event.event_type}</strong>
                </span>
              ) : (
                <span>Текущее событие: запуск не начат</span>
              )}
            </div>

            <input
              type="range"
              min={-1}
              max={Math.max(-1, max_event_index)}
              value={current_event_index}
              onChange={(event) => HandleJumpToIndex(ParseNumber(event.target.value, -1))}
            />

            <div
              className={`result-model-viewport ${
                view_interaction.interaction_type === "panning" ? "is-panning" : ""
              }`}
              onMouseDown={HandleViewportMouseDown}
            >
              <div
                className="result-model-world-shell"
                style={{
                  width: `${model_world_width}px`,
                  height: `${model_world_height}px`,
                  transform: `translate(${model_pan_x}px, ${model_pan_y}px) scale(${model_zoom})`,
                }}
              >
                <svg className="result-model-edge-layer" viewBox={`0 0 ${model_world_width} ${model_world_height}`}>
                  <defs>
                    <marker id="resultArrowHead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                      <polygon points="0,0 10,4 0,8" fill="#5f7383" />
                    </marker>
                  </defs>
                  {edge_visuals.map((visual) => (
                    <g key={visual.edge.edge_id}>
                      <line
                        x1={visual.x1}
                        y1={visual.y1}
                        x2={visual.x2}
                        y2={visual.y2}
                        markerEnd="url(#resultArrowHead)"
                        className="result-edge-line"
                      />
                      <rect
                        x={visual.mid_x - 44}
                        y={visual.mid_y - 11}
                        width={88}
                        height={22}
                        rx={8}
                        className="result-edge-label-bg"
                      />
                      <text x={visual.mid_x} y={visual.mid_y + 4} textAnchor="middle" className="result-edge-label">
                        {visual.edge.edge_id}
                      </text>
                    </g>
                  ))}
                </svg>

                {simulation_nodes.map((node) => {
                  const position = node_positions[node.node_id];
                  if (!position) {
                    return null;
                  }

                  const is_service_node = node.node_type === "service";
                  const is_node_open = IsNodeOpen(node, playback_snapshot.current_time);
                  const queue_length = playback_snapshot.queue_lengths_by_node[node.node_id] ?? 0;
                  const busy_channels = playback_snapshot.busy_by_node[node.node_id] ?? 0;
                  const queue_items = playback_snapshot.queue_by_node[node.node_id] ?? [];
                  const visible_queue_items = queue_items.slice(0, Math.min(8, queue_length));
                  const queue_overflow = Math.max(0, queue_length - visible_queue_items.length);

                  const total_requests = total_request_ids_by_node[node.node_id]?.length ?? 0;
                  const serving_request_ids = serving_request_ids_by_node[node.node_id] ?? [];
                  const visible_serving_request_ids = serving_request_ids.slice(0, 8);
                  const serving_overflow = Math.max(0, serving_request_ids.length - visible_serving_request_ids.length);

                  return (
                    <article
                      key={node.node_id}
                      data-result-node-card="true"
                      className={`result-node-card ${is_node_open ? "" : "is-closed"}`}
                      style={{
                        left: `${position.x}px`,
                        top: `${position.y}px`,
                        width: `${model_node_width}px`,
                        minHeight: `${model_node_height}px`,
                      }}
                      onMouseDown={(event) => HandleNodeMouseDown(event, node.node_id)}
                      onClick={() => setSelectedNodeId(node.node_id)}
                    >
                      <h4>{node.name}</h4>
                      <div className="result-node-meta">id: {node.node_id}</div>
                      <div className="result-node-meta">Статус: {is_node_open ? "открыт" : "закрыт"}</div>
                      {is_service_node ? (
                        <>
                          <div className="result-node-meta">
                            Каналы: {busy_channels}/{node.channels}
                          </div>
                          <div className="result-node-meta">Всего в узле: {total_requests}</div>
                          <div className="result-node-meta">Обрабатываются: {serving_request_ids.length}</div>

                          {visible_serving_request_ids.length > 0 ? (
                            <div className="result-request-strip">
                              {visible_serving_request_ids.map((request_id) => (
                                <span
                                  key={`${node.node_id}_serving_${request_id}`}
                                  className="request-dot"
                                  title={request_id}
                                />
                              ))}
                              {serving_overflow > 0 ? <span className="request-overflow">+{serving_overflow}</span> : null}
                            </div>
                          ) : null}

                          <div className="result-node-meta">Очередь: {queue_length}</div>
                          {queue_length > 0 ? (
                            <div className="result-queue-strip">
                              {visible_queue_items.map((request_id, index) => (
                                <span
                                  key={`${node.node_id}_queue_${request_id}_${index}`}
                                  className="queue-dot"
                                  title={request_id}
                                />
                              ))}
                              {queue_overflow > 0 ? <span className="request-overflow">+{queue_overflow}</span> : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </article>
                  );
                })}

                {moving_tokens.map((token) => (
                  <div
                    key={`${token.request_id}_${token.x}_${token.y}`}
                    className="moving-request-token"
                    style={{
                      left: `${token.x}px`,
                      top: `${token.y}px`,
                    }}
                  >
                    {token.request_id}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="chart-card compact">
            <h3>Общие графики по узлам системы</h3>
            <label className="global-chart-selector">
              Показатель
              <select
                value={selected_global_chart}
                onChange={(event) => setSelectedGlobalChart(event.target.value as GlobalChartType)}
              >
                {global_chart_options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="chart-box">
              <Bar data={global_chart_data} options={global_bar_chart_options} />
            </div>
          </div>

          <div className="chart-card compact metrics-table-card">
            <h3>Общие метрики по узлам</h3>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    {metrics_column_names.map((column_name) => (
                      <th key={column_name}>{GetMetricLabel(column_name)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run_data.metrics.map((row, index) => (
                    <tr key={`${row.node_id ?? "node"}_${index}`}>
                      {metrics_column_names.map((column_name) => (
                        <td key={column_name}>{FormatMetricDisplayValue(row[column_name])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <aside className="results-node-column">
          <div className="chart-card compact">
            <h3>Выбор вершины</h3>
            <div className="node-navigation">
              <button
                type="button"
                className="secondary"
                onClick={() => HandleSelectNextNode("prev")}
                disabled={!selected_node_id || node_ids.indexOf(selected_node_id) <= 0}
              >
                ← Предыдущая
              </button>
              <select
                value={selected_node_id ?? ""}
                onChange={(event) => setSelectedNodeId(event.target.value || null)}
              >
                {simulation_nodes.map((node) => (
                  <option key={node.node_id} value={node.node_id}>
                    {GetNodeDisplayName(node)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary"
                onClick={() => HandleSelectNextNode("next")}
                disabled={!selected_node_id || node_ids.indexOf(selected_node_id) >= node_ids.length - 1}
              >
                Следующая →
              </button>
            </div>
          </div>

          <div className="chart-card compact node-params-card">
            <h3>Параметры выбранной вершины</h3>
            {selected_node ? (
              <div className="summary-grid">
                <div className="summary-item">
                  <strong>ID</strong>
                  <span>{selected_node.node_id}</span>
                </div>
                <div className="summary-item">
                  <strong>Название</strong>
                  <span>{selected_node.name}</span>
                </div>
                <div className="summary-item">
                  <strong>Тип</strong>
                  <span>{selected_node.node_type}</span>
                </div>
                <div className="summary-item">
                  <strong>Статус</strong>
                  <span>{selected_node_is_open ? "открыт" : "закрыт"}</span>
                </div>
                {selected_node_is_service ? (
                  <>
                    <div className="summary-item">
                      <strong>Каналы</strong>
                      <span>
                        {selected_node_busy}/{selected_node.channels}
                      </span>
                    </div>
                    <div className="summary-item">
                      <strong>Всего в узле</strong>
                      <span>{selected_node_total}</span>
                    </div>
                    <div className="summary-item">
                      <strong>Обрабатываются</strong>
                      <span>{selected_node_serving}</span>
                    </div>
                    <div className="summary-item">
                      <strong>Очередь</strong>
                      <span>{selected_node_queue}</span>
                    </div>
                  </>
                ) : null}
                <div className="summary-item">
                  <strong>Открытие / закрытие</strong>
                  <span>
                    {selected_node.open_time} / {selected_node.close_time ?? "не закрывается"}
                  </span>
                </div>
                <div className="summary-item">
                  <strong>Исходящих маршрутов</strong>
                  <span>{selected_node.routes.length}</span>
                </div>
              </div>
            ) : (
              <div className="muted-text">Выберите вершину, чтобы увидеть её параметры.</div>
            )}
          </div>

          <div className="chart-card compact">
            <h3>
              Загруженность по времени
              {selected_node ? `: ${selected_node.name}` : ""}
            </h3>
            <div className="chart-box">
              <Line data={selected_node_utilization_chart_data} options={node_line_chart_options} />
            </div>
          </div>

          <div className="chart-card compact">
            <h3>
              Размер очереди по времени
              {selected_node ? `: ${selected_node.name}` : ""}
            </h3>
            <div className="chart-box">
              <Line data={selected_node_queue_chart_data} options={node_line_chart_options} />
            </div>
          </div>

          <div className="chart-card compact node-metrics-card">
            <h3>Метрики выбранной вершины</h3>
            {selected_node_metric_row ? (
              <div className="summary-grid">
                {Object.entries(selected_node_metric_row)
                  .filter(([key]) => key !== "task_id")
                  .map(([key, value]) => (
                  <div key={key} className="summary-item">
                    <strong>{GetMetricLabel(key)}</strong>
                    <span>{FormatMetricDisplayValue(value)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted-text">Нет данных по выбранной вершине.</div>
            )}
          </div>
        </aside>
      </div>

    </section>
  );
}

