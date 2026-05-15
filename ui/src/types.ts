export type DistributionType =
  | "normal"
  | "exponential"
  | "uniform"
  | "deterministic"
  | "poisson"
  | "erlang"
  | "hyperexponential"
  | "intervals"
  | "intensity";
export type NodeType = "service" | "generator" | "exit";

export interface DistributionConfig {
  distribution_type: DistributionType;
  mean?: number;
  std?: number;
  scale?: number;
  rate?: number;
  shape?: number;
  rate1?: number;
  rate2?: number;
  mix_probability?: number;
  intervals?: number[];
  intensity?: number;
  low?: number;
  high?: number;
  value?: number;
  min_value?: number;
}

export interface RouteConfig {
  target_node_id: string | null;
  edge_id: string | null;
  probability: number;
}

export interface NodeScheduleInterval {
  open_time: number;
  close_time: number | null;
}

export interface NodeConfig {
  node_id: string;
  name: string;
  node_type: NodeType;
  open_time: number;
  close_time: number | null;
  schedule?: NodeScheduleInterval[];
  channels: number;
  service_distribution: DistributionConfig | null;
  routes: RouteConfig[];
}

export interface EdgeConfig {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  travel_distribution: DistributionConfig;
}

export interface GeneratorConfig {
  target_node_id: string;
  interarrival_distribution: DistributionConfig;
  start_time: number;
  stop_time: number | null;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface SimulationConfig {
  simulation_duration: number;
  random_seed: number | null;
  max_requests: number | null;
  generator?: GeneratorConfig | null;
  generators?: GeneratorConfig[];
  nodes: NodeConfig[];
  edges: EdgeConfig[];
}

export interface SimulationRunRequest {
  model_name: string;
  config: SimulationConfig;
  node_positions?: Record<string, NodePosition>;
}

export interface StartTaskResponse {
  task_id: string;
  status: string;
}

export interface TaskStatusResponse {
  task_id: string;
  status: "queued" | "running" | "completed" | "failed";
  model_name: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  run_id: string | null;
  summary: Record<string, unknown> | null;
}

export interface SavedRun {
  run_id: string;
  model_name: string;
  created_at?: string;
  summary: Record<string, unknown>;
}

export interface ImportRunResponse {
  status: "imported";
  run_id: string;
  model_name: string;
  summary: Record<string, unknown>;
  files: Record<string, string>;
}

export interface RunData {
  run_id: string;
  model: {
    model_name: string;
    config: SimulationConfig;
    node_positions?: Record<string, NodePosition>;
  };
  summary: Record<string, unknown>;
  events: Array<Record<string, string | number | null>>;
  metrics: Array<Record<string, string | number | null>>;
}
