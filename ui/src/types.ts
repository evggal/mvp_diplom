export type DistributionType = "normal" | "exponential" | "uniform" | "deterministic";

export interface DistributionConfig {
  distribution_type: DistributionType;
  mean?: number;
  std?: number;
  scale?: number;
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

export interface NodeConfig {
  node_id: string;
  name: string;
  open_time: number;
  close_time: number | null;
  channels: number;
  service_distribution: DistributionConfig;
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

export interface SimulationConfig {
  simulation_duration: number;
  random_seed: number | null;
  max_requests: number | null;
  generator: GeneratorConfig;
  nodes: NodeConfig[];
  edges: EdgeConfig[];
}

export interface SimulationRunRequest {
  model_name: string;
  config: SimulationConfig;
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

export interface RunData {
  run_id: string;
  model: {
    model_name: string;
    config: SimulationConfig;
  };
  summary: Record<string, unknown>;
  events: Array<Record<string, string | number | null>>;
  metrics: Array<Record<string, string | number | null>>;
}
