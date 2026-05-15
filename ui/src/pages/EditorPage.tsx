import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AxiosError } from "axios";
import { useLocation, useNavigate } from "react-router-dom";
import { GetRunById, GetSimulationStatus, StartSimulation } from "../api/client";
import { DismissibleError } from "../components/DismissibleError";
import {
  BuildBaseTemplate,
  requests_options,
  time_step_options,
} from "../model/defaultModel";
import type {
  DistributionConfig,
  DistributionType,
  EdgeConfig,
  GeneratorConfig,
  NodePosition,
  NodeConfig,
  NodeScheduleInterval,
  NodeType,
  RouteConfig,
  SimulationConfig,
  TaskStatusResponse,
} from "../types";

interface EditorPageProps {
  on_run_ready: (run_id: string) => void;
}

interface NormalizedModelData {
  config: SimulationConfig;
  node_positions: Record<string, NodePosition>;
}

type InteractionState =
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

interface DistributionEditorProps {
  title: string;
  distribution: DistributionConfig;
  on_change: (next_distribution: DistributionConfig) => void;
  allowed_types: DistributionType[];
  compact?: boolean;
}

type EditorSettingsTab = "general" | "nodes";

const node_box_width = 168;
const node_box_height = 92;
const world_width = 2400;
const world_height = 1600;
const min_canvas_zoom = 0.45;
const max_canvas_zoom = 2.2;

const generator_distribution_types: DistributionType[] = [
  "poisson",
  "exponential",
  "deterministic",
  "erlang",
  "intervals",
  "intensity",
];

const service_distribution_types: DistributionType[] = [
  "normal",
  "uniform",
  "exponential",
  "hyperexponential",
  "deterministic",
  "erlang",
];

const edge_distribution_types: DistributionType[] = [
  "uniform",
  "exponential",
  "deterministic",
  "normal",
  "erlang",
];

function CloneConfig(config: SimulationConfig): SimulationConfig {
  return JSON.parse(JSON.stringify(config)) as SimulationConfig;
}

function CreateServiceNodeName(index: number): string {
  return `РЈР·РµР» РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ ${index}`;
}

function CreateDistributionByType(
  distribution_type: DistributionType,
  min_value: number = 0.01,
): DistributionConfig {
  const safe_min_value = Math.max(0.000001, min_value);
  if (distribution_type === "normal") {
    return { distribution_type, mean: 1.5, std: 0.4, min_value: safe_min_value };
  }
  if (distribution_type === "uniform") {
    return { distribution_type, low: 0.1, high: 0.5, min_value: safe_min_value };
  }
  if (distribution_type === "exponential") {
    return { distribution_type, scale: 1, min_value: safe_min_value };
  }
  if (distribution_type === "deterministic") {
    return { distribution_type, value: 1, min_value: safe_min_value };
  }
  if (distribution_type === "poisson") {
    return { distribution_type, rate: 1, min_value: safe_min_value };
  }
  if (distribution_type === "erlang") {
    return { distribution_type, shape: 2, rate: 1, min_value: safe_min_value };
  }
  if (distribution_type === "hyperexponential") {
    return {
      distribution_type,
      rate1: 1.5,
      rate2: 0.6,
      mix_probability: 0.5,
      min_value: safe_min_value,
    };
  }
  if (distribution_type === "intervals") {
    return { distribution_type, intervals: [0.5, 1, 1.5], min_value: safe_min_value };
  }
  return { distribution_type: "intensity", intensity: 1, min_value: safe_min_value };
}

function NormalizeDistributionConfig(
  distribution: DistributionConfig | null | undefined,
  allowed_types: DistributionType[],
  fallback_type: DistributionType,
): DistributionConfig {
  const min_value = Math.max(0.000001, distribution?.min_value ?? 0.01);
  const requested_type = distribution?.distribution_type;
  const next_type = requested_type && allowed_types.includes(requested_type) ? requested_type : fallback_type;
  const normalized = {
    ...CreateDistributionByType(next_type, min_value),
    ...(distribution ?? {}),
    distribution_type: next_type,
    min_value,
  } as DistributionConfig;

  if (next_type === "normal") {
    normalized.mean = normalized.mean && Number.isFinite(normalized.mean) ? normalized.mean : 1.5;
    normalized.std = normalized.std && normalized.std > 0 ? normalized.std : 0.4;
  }
  if (next_type === "uniform") {
    const low = normalized.low && Number.isFinite(normalized.low) ? normalized.low : 0.1;
    const high = normalized.high && Number.isFinite(normalized.high) ? normalized.high : 0.5;
    normalized.low = low;
    normalized.high = high > low ? high : low + 0.1;
  }
  if (next_type === "exponential") {
    normalized.scale = normalized.scale && normalized.scale > 0 ? normalized.scale : 1;
  }
  if (next_type === "deterministic") {
    normalized.value = normalized.value && normalized.value > 0 ? normalized.value : 1;
  }
  if (next_type === "poisson") {
    const rate = normalized.rate ?? normalized.intensity ?? normalized.value ?? 1;
    normalized.rate = rate > 0 ? rate : 1;
  }
  if (next_type === "erlang") {
    const shape = normalized.shape ?? 2;
    normalized.shape = Math.max(1, Math.round(shape));
    const rate = normalized.rate ?? normalized.intensity ?? 1;
    normalized.rate = rate > 0 ? rate : 1;
  }
  if (next_type === "hyperexponential") {
    normalized.rate1 = normalized.rate1 && normalized.rate1 > 0 ? normalized.rate1 : 1.5;
    normalized.rate2 = normalized.rate2 && normalized.rate2 > 0 ? normalized.rate2 : 0.6;
    const mix_probability = normalized.mix_probability ?? 0.5;
    normalized.mix_probability = Math.max(0, Math.min(1, mix_probability));
  }
  if (next_type === "intervals") {
    const valid_intervals = (normalized.intervals ?? []).filter(
      (item) => Number.isFinite(item) && item > 0,
    );
    if (valid_intervals.length > 0) {
      normalized.intervals = valid_intervals;
    } else if (normalized.value && normalized.value > 0) {
      normalized.intervals = [normalized.value];
    } else {
      normalized.intervals = [0.5, 1, 1.5];
    }
  }
  if (next_type === "intensity") {
    const intensity = normalized.intensity ?? normalized.rate ?? normalized.value ?? 1;
    normalized.intensity = intensity > 0 ? intensity : 1;
  }

  return normalized;
}

function CreateServiceDistribution(): DistributionConfig {
  return CreateDistributionByType("normal");
}

function CreateTravelDistribution(): DistributionConfig {
  return CreateDistributionByType("uniform");
}

function CreateInterarrivalDistribution(): DistributionConfig {
  return {
    ...CreateDistributionByType("poisson"),
    rate: 0.9,
  };
}

function EnsureGeneratorConfig(config: SimulationConfig): GeneratorConfig {
  if (!config.generator) {
    const generator_node = config.nodes.find((node) => node.node_type === "generator") ?? config.nodes[0];
    config.generator = {
      target_node_id: generator_node?.node_id ?? "node_1",
      start_time: 0,
      stop_time: Math.max(5, config.simulation_duration - 10),
      interarrival_distribution: CreateInterarrivalDistribution(),
    };
  }
  return config.generator;
}

function CreateNodeId(config: SimulationConfig): string {
  const existing_ids = new Set(config.nodes.map((node) => node.node_id));
  let index = 1;
  while (existing_ids.has(`node_${index}`)) {
    index += 1;
  }
  return `node_${index}`;
}

function CreateDefaultSchedule(): NodeScheduleInterval[] {
  return [{ open_time: 0, close_time: null }];
}

function NormalizeNodeSchedule(
  schedule: NodeScheduleInterval[] | null | undefined,
  fallback_open_time: number,
  fallback_close_time: number | null,
): NodeScheduleInterval[] {
  const fallback_interval: NodeScheduleInterval = {
    open_time: Math.max(0, fallback_open_time),
    close_time:
      fallback_close_time !== null && fallback_close_time > fallback_open_time
        ? fallback_close_time
        : null,
  };
  const source = schedule && schedule.length > 0 ? schedule : [fallback_interval];
  const sorted = source
    .map((interval) => {
      const open_time = Number.isFinite(interval.open_time) ? Math.max(0, interval.open_time) : 0;
      const close_time =
        interval.close_time !== null && Number.isFinite(interval.close_time)
          ? Math.max(0, interval.close_time)
          : null;
      return { open_time, close_time };
    })
    .sort((first, second) => first.open_time - second.open_time);

  const normalized: NodeScheduleInterval[] = [];
  for (const interval of sorted) {
    const next_interval = { ...interval };
    const previous_interval = normalized[normalized.length - 1];
    if (previous_interval) {
      if (previous_interval.close_time === null) {
        break;
      }
      if (next_interval.open_time < previous_interval.close_time) {
        next_interval.open_time = previous_interval.close_time;
      }
    }

    if (next_interval.close_time !== null && next_interval.close_time <= next_interval.open_time) {
      next_interval.close_time = next_interval.open_time + 0.1;
    }

    normalized.push(next_interval);
    if (next_interval.close_time === null) {
      break;
    }
  }

  return normalized.length > 0 ? normalized : [fallback_interval];
}

function SyncLegacyScheduleFields(node: NodeConfig): void {
  const first_interval = node.schedule?.[0] ?? { open_time: 0, close_time: null };
  node.open_time = first_interval.open_time;
  node.close_time = first_interval.close_time;
}

function CreateDefaultNode(
  node_id: string,
  node_name: string,
  node_type: NodeType = "service",
): NodeConfig {
  if (node_type === "exit") {
    return {
      node_id,
      name: node_name || "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹",
      node_type: "exit",
      open_time: 0,
      close_time: null,
      schedule: CreateDefaultSchedule(),
      channels: 1,
      service_distribution: null,
      routes: [],
    };
  }

  if (node_type === "generator") {
    return {
      node_id,
      name: node_name || "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє",
      node_type: "generator",
      open_time: 0,
      close_time: null,
      schedule: CreateDefaultSchedule(),
      channels: 1,
      service_distribution: {
        distribution_type: "deterministic",
        value: 0.01,
        min_value: 0.01,
      },
      routes: [
        {
          target_node_id: null,
          edge_id: null,
          probability: 1,
        },
      ],
    };
  }

  return {
    node_id,
    name: node_name,
    node_type: "service",
    open_time: 0,
    close_time: null,
    schedule: CreateDefaultSchedule(),
    channels: 1,
    service_distribution: CreateServiceDistribution(),
    routes: [
      {
        target_node_id: null,
        edge_id: null,
        probability: 1,
      },
    ],
  };
}

function CreateDefaultEdge(
  edge_id: string,
  source_node_id: string,
  target_node_id: string,
): EdgeConfig {
  return {
    edge_id,
    source_node_id,
    target_node_id,
    travel_distribution: CreateTravelDistribution(),
  };
}

function NormalizeRouteEdgeId(edge_id: string | null): string | null {
  if (edge_id === null) {
    return null;
  }
  const trimmed = edge_id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function RebuildEdgesFromRoutes(
  config: SimulationConfig,
  previous_edges: EdgeConfig[],
): EdgeConfig[] {
  const previous_edges_lookup = new Map(previous_edges.map((edge) => [edge.edge_id, edge]));
  const next_edges: EdgeConfig[] = [];
  const added_edge_ids = new Set<string>();

  for (const node of config.nodes) {
    if (node.node_type === "exit") {
      continue;
    }

    for (const route of node.routes) {
      if (route.target_node_id === null) {
        route.edge_id = null;
        continue;
      }

      route.edge_id = NormalizeRouteEdgeId(route.edge_id);
      if (route.edge_id === null) {
        continue;
      }
      if (added_edge_ids.has(route.edge_id)) {
        continue;
      }

      added_edge_ids.add(route.edge_id);
      const previous_edge = previous_edges_lookup.get(route.edge_id);
      const keep_previous_distribution =
        previous_edge &&
        previous_edge.source_node_id === node.node_id &&
        previous_edge.target_node_id === route.target_node_id;

      next_edges.push({
        edge_id: route.edge_id,
        source_node_id: node.node_id,
        target_node_id: route.target_node_id,
        travel_distribution: keep_previous_distribution
          ? NormalizeDistributionConfig(
              previous_edge.travel_distribution,
              edge_distribution_types,
              "uniform",
            )
          : CreateTravelDistribution(),
      });
    }
  }

  return next_edges;
}

function BuildTimeOptions(simulation_duration: number): number[] {
  const options = new Set<number>();
  options.add(0);
  for (const option of time_step_options) {
    if (option <= simulation_duration) {
      options.add(option);
    }
  }
  options.add(simulation_duration);
  return [...options].sort((first, second) => first - second);
}

function NormalizeConfigAndLayout(
  original_config: SimulationConfig,
  original_positions: Record<string, NodePosition>,
): NormalizedModelData {
  const config = CloneConfig(original_config);
  const node_positions = { ...original_positions };

  if (config.nodes.length === 0) {
    config.nodes.push(CreateDefaultNode("node_1", "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє", "generator"));
    config.nodes.push(CreateDefaultNode("node_2", CreateServiceNodeName(1), "service"));
    config.nodes.push(CreateDefaultNode("node_3", "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹", "exit"));
    config.edges.push(CreateDefaultEdge("edge_1", "node_1", "node_2"));
    config.edges.push(CreateDefaultEdge("edge_2", "node_2", "node_3"));
    config.nodes[0].routes = [{ target_node_id: "node_2", edge_id: "edge_1", probability: 1 }];
    config.nodes[1].routes = [{ target_node_id: "node_3", edge_id: "edge_2", probability: 1 }];
    node_positions.node_1 = { x: 140, y: 180 };
    node_positions.node_2 = { x: 430, y: 180 };
    node_positions.node_3 = { x: 720, y: 180 };
    config.generator = {
      target_node_id: "node_1",
      start_time: 0,
      stop_time: Math.max(5, config.simulation_duration - 10),
      interarrival_distribution: CreateInterarrivalDistribution(),
    };
  }

  for (const node of config.nodes) {
    if (node.node_type !== "service" && node.node_type !== "generator" && node.node_type !== "exit") {
      node.node_type = "service";
    }
  }

  const generator_nodes = config.nodes.filter((node) => node.node_type === "generator");
  if (generator_nodes.length === 0) {
    const candidate = config.nodes.find((node) => node.node_type === "service") ?? config.nodes[0];
    candidate.node_type = "generator";
    candidate.channels = 1;
    if (!candidate.name || candidate.name.trim().length === 0) {
      candidate.name = "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє";
    }
  }

  const normalized_generator_nodes = config.nodes.filter((node) => node.node_type === "generator");
  if (normalized_generator_nodes.length > 1) {
    normalized_generator_nodes.slice(1).forEach((node, index) => {
      node.node_type = "service";
      if (!node.name || node.name === "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє") {
        node.name = CreateServiceNodeName(index + 1);
      }
      if (!node.service_distribution) {
        node.service_distribution = CreateServiceDistribution();
      }
      if (node.routes.length === 0) {
        node.routes = [{ target_node_id: null, edge_id: null, probability: 1 }];
      }
    });
  }

  if (!config.nodes.some((node) => node.node_type === "exit")) {
    const next_exit_id = CreateNodeId(config);
    config.nodes.push(CreateDefaultNode(next_exit_id, "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹", "exit"));
    node_positions[next_exit_id] = {
      x: 180 + (config.nodes.length % 4) * 240,
      y: 220 + Math.floor(config.nodes.length / 4) * 170,
    };
  }

  const node_id_set = new Set(config.nodes.map((node) => node.node_id));
  const previous_edges = config.edges.map((edge) => ({
    ...edge,
    travel_distribution: { ...edge.travel_distribution },
  }));

  for (const node of config.nodes) {
    if (!node_positions[node.node_id]) {
      const index = config.nodes.findIndex((candidate) => candidate.node_id === node.node_id);
      node_positions[node.node_id] = {
        x: 160 + (index % 4) * 260,
        y: 160 + Math.floor(index / 4) * 200,
      };
    }
    node.channels = Math.max(1, Math.round(node.channels));
    node.schedule = NormalizeNodeSchedule(node.schedule, node.open_time, node.close_time);
    SyncLegacyScheduleFields(node);

    if (node.node_type === "exit") {
      node.channels = 1;
      node.service_distribution = null;
      node.routes = [];
      continue;
    }

    if (node.node_type === "generator") {
      node.channels = 1;
      node.service_distribution = NormalizeDistributionConfig(
        node.service_distribution,
        ["deterministic"],
        "deterministic",
      );
    }

    if (node.node_type === "service") {
      node.service_distribution = NormalizeDistributionConfig(
        node.service_distribution,
        service_distribution_types,
        "normal",
      );
    }

    if (node.routes.length === 0) {
      node.routes.push({
        target_node_id: null,
        edge_id: null,
        probability: 1,
      });
    }

    node.routes = node.routes.map((route) => {
      const normalized_target = route.target_node_id;
      const is_valid_target =
        normalized_target !== null &&
        node_id_set.has(normalized_target) &&
        normalized_target !== node.node_id &&
        config.nodes.some(
          (candidate) =>
            candidate.node_id === normalized_target && candidate.node_type !== "generator",
        );
      const normalized_route: RouteConfig = {
        target_node_id: is_valid_target ? normalized_target : null,
        edge_id: NormalizeRouteEdgeId(route.edge_id),
        probability: Number.isFinite(route.probability) ? Math.max(0, route.probability) : 0,
      };

      if (normalized_route.target_node_id === null) {
        normalized_route.edge_id = null;
        return normalized_route;
      }

      return normalized_route;
    });
  }

  config.edges = RebuildEdgesFromRoutes(config, previous_edges);

  for (const existing_id of Object.keys(node_positions)) {
    if (!node_id_set.has(existing_id)) {
      delete node_positions[existing_id];
    }
  }

  const generator_node = config.nodes.find((node) => node.node_type === "generator") ?? config.nodes[0];
  const generator_config =
    config.generator ??
    {
      target_node_id: generator_node.node_id,
      start_time: 0,
      stop_time: Math.max(5, config.simulation_duration - 10),
      interarrival_distribution: CreateInterarrivalDistribution(),
    };
  config.generator = generator_config;
  generator_config.target_node_id = generator_node.node_id;
  if (generator_config.start_time < 0) {
    generator_config.start_time = 0;
  }
  if (
    generator_config.stop_time !== null &&
    generator_config.stop_time <= generator_config.start_time
  ) {
    generator_config.stop_time = null;
  }
  if (
    generator_config.stop_time !== null &&
    generator_config.stop_time > config.simulation_duration
  ) {
    generator_config.stop_time = config.simulation_duration;
  }

  generator_config.interarrival_distribution = NormalizeDistributionConfig(
    generator_config.interarrival_distribution,
    generator_distribution_types,
    "poisson",
  );

  return {
    config,
    node_positions,
  };
}

function ToSelectValue(value: number | null): string {
  if (value === null) {
    return "none";
  }
  return String(value);
}

function ParseSelectNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function ParseOptionalNumber(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function ParseDistributionValue(raw_value: string, fallback: number): number {
  const parsed = Number(raw_value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function ParseIntervals(raw_value: string): number[] {
  return raw_value
    .split(/[,\s;]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function ParseProbabilityPercent(raw_value: string): number {
  const parsed = Number(raw_value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, parsed / 100);
}

function ClampZoom(value: number): number {
  return Math.max(min_canvas_zoom, Math.min(max_canvas_zoom, value));
}

function IsProbabilitySumValid(sum: number): boolean {
  return Math.abs(sum - 1) <= 1e-6;
}

function ValidateProbabilitySums(config: SimulationConfig): string | null {
  for (const node of config.nodes) {
    if (node.node_type === "exit") {
      continue;
    }
    const sum = node.routes.reduce((accumulator, route) => accumulator + route.probability, 0);
    if (!IsProbabilitySumValid(sum)) {
      return `РћС€РёР±РєР° РІ РІРµСЂС€РёРЅРµ "${node.name}" (${node.node_id}): СЃСѓРјРјР° РІРµСЂРѕСЏС‚РЅРѕСЃС‚РµР№ РїРµСЂРµС…РѕРґР° РґРѕР»Р¶РЅР° Р±С‹С‚СЊ 100%. РЎРµР№С‡Р°СЃ: ${(sum * 100).toFixed(2)}%.`;
    }
  }
  return null;
}

function GetDistributionLabel(distribution_type: DistributionType): string {
  if (distribution_type === "normal") {
    return "РќРѕСЂРјР°Р»СЊРЅС‹Р№";
  }
  if (distribution_type === "uniform") {
    return "Р Р°РІРЅРѕРјРµСЂРЅС‹Р№";
  }
  if (distribution_type === "exponential") {
    return "Р­РєСЃРїРѕРЅРµРЅС†РёР°Р»СЊРЅС‹Р№";
  }
  if (distribution_type === "deterministic") {
    return "Р”РµС‚РµСЂРјРёРЅРёСЂРѕРІР°РЅРЅС‹Р№";
  }
  if (distribution_type === "poisson") {
    return "РџСѓР°СЃСЃРѕРЅРѕРІСЃРєРёР№";
  }
  if (distribution_type === "erlang") {
    return "РџРѕС‚РѕРє Р­СЂР»Р°РЅРіР°";
  }
  if (distribution_type === "hyperexponential") {
    return "Р“РёРїРµСЂСЌРєСЃРїРѕРЅРµРЅС†РёР°Р»СЊРЅС‹Р№";
  }
  if (distribution_type === "intervals") {
    return "Р§РµСЂРµР· РёРЅС‚РµСЂРІР°Р»С‹";
  }
  return "РџРѕ РёРЅС‚РµРЅСЃРёРІРЅРѕСЃС‚Рё";
}

function DistributionEditor({
  title,
  distribution,
  on_change,
  allowed_types,
  compact = false,
}: DistributionEditorProps) {
  function HandleDistributionTypeChange(next_type: DistributionType) {
    on_change(
      NormalizeDistributionConfig(
        CreateDistributionByType(next_type, distribution.min_value ?? 0.01),
        allowed_types,
        allowed_types[0],
      ),
    );
  }

  function HandleParamChange(key: keyof DistributionConfig, fallback: number, raw_value: string) {
    const next_distribution: DistributionConfig = {
      ...distribution,
      [key]: ParseDistributionValue(raw_value, fallback),
    };
    on_change(NormalizeDistributionConfig(next_distribution, allowed_types, allowed_types[0]));
  }

  function HandleIntervalsChange(raw_value: string) {
    const parsed_intervals = ParseIntervals(raw_value);
    const fallback_intervals = distribution.intervals ?? [1];
    const next_distribution: DistributionConfig = {
      ...distribution,
      intervals: parsed_intervals.length > 0 ? parsed_intervals : fallback_intervals,
    };
    on_change(NormalizeDistributionConfig(next_distribution, allowed_types, allowed_types[0]));
  }

  return (
    <section className={`distribution-card ${compact ? "compact" : ""}`}>
      <h4>{title}</h4>
      <div className="editor-grid">
        <label>
          Р—Р°РєРѕРЅ СЂР°СЃРїСЂРµРґРµР»РµРЅРёСЏ
          <select
            value={distribution.distribution_type}
            onChange={(event) => HandleDistributionTypeChange(event.target.value as DistributionType)}
          >
            {allowed_types.map((distribution_type) => (
              <option key={distribution_type} value={distribution_type}>
                {GetDistributionLabel(distribution_type)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {distribution.distribution_type === "normal" ? (
        <div className="editor-grid">
          <label>
            mean
            <input
              type="number"
              value={distribution.mean ?? 1.5}
              step={0.01}
              onChange={(event) => HandleParamChange("mean", distribution.mean ?? 1.5, event.target.value)}
            />
          </label>
          <label>
            std
            <input
              type="number"
              value={distribution.std ?? 0.4}
              step={0.01}
              onChange={(event) => HandleParamChange("std", distribution.std ?? 0.4, event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "exponential" ? (
        <div className="editor-grid">
          <label>
            scale
            <input
              type="number"
              value={distribution.scale ?? 1}
              step={0.01}
              onChange={(event) =>
                HandleParamChange("scale", distribution.scale ?? 1, event.target.value)
              }
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "uniform" ? (
        <div className="editor-grid">
          <label>
            low
            <input
              type="number"
              value={distribution.low ?? 0.1}
              step={0.01}
              onChange={(event) => HandleParamChange("low", distribution.low ?? 0.1, event.target.value)}
            />
          </label>
          <label>
            high
            <input
              type="number"
              value={distribution.high ?? 0.5}
              step={0.01}
              onChange={(event) =>
                HandleParamChange("high", distribution.high ?? 0.5, event.target.value)
              }
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "deterministic" ? (
        <div className="editor-grid">
          <label>
            value
            <input
              type="number"
              value={distribution.value ?? 1}
              step={0.01}
              onChange={(event) =>
                HandleParamChange("value", distribution.value ?? 1, event.target.value)
              }
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "poisson" ? (
        <div className="editor-grid">
          <label>
            rate (lambda)
            <input
              type="number"
              value={distribution.rate ?? 1}
              step={0.01}
              min={0.01}
              onChange={(event) => HandleParamChange("rate", distribution.rate ?? 1, event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "erlang" ? (
        <div className="editor-grid">
          <label>
            shape (k)
            <input
              type="number"
              value={distribution.shape ?? 2}
              step={1}
              min={1}
              onChange={(event) => HandleParamChange("shape", distribution.shape ?? 2, event.target.value)}
            />
          </label>
          <label>
            rate (lambda)
            <input
              type="number"
              value={distribution.rate ?? 1}
              step={0.01}
              min={0.01}
              onChange={(event) => HandleParamChange("rate", distribution.rate ?? 1, event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "hyperexponential" ? (
        <div className="editor-grid">
          <label>
            rate_1
            <input
              type="number"
              value={distribution.rate1 ?? 1.5}
              step={0.01}
              min={0.01}
              onChange={(event) => HandleParamChange("rate1", distribution.rate1 ?? 1.5, event.target.value)}
            />
          </label>
          <label>
            rate_2
            <input
              type="number"
              value={distribution.rate2 ?? 0.6}
              step={0.01}
              min={0.01}
              onChange={(event) => HandleParamChange("rate2", distribution.rate2 ?? 0.6, event.target.value)}
            />
          </label>
          <label>
            mix_probability
            <input
              type="number"
              value={distribution.mix_probability ?? 0.5}
              step={0.01}
              min={0}
              max={1}
              onChange={(event) =>
                HandleParamChange("mix_probability", distribution.mix_probability ?? 0.5, event.target.value)
              }
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "intervals" ? (
        <div className="editor-grid">
          <label>
            intervals
            <input
              type="text"
              value={(distribution.intervals ?? [1]).join(", ")}
              onChange={(event) => HandleIntervalsChange(event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {distribution.distribution_type === "intensity" ? (
        <div className="editor-grid">
          <label>
            intensity
            <input
              type="number"
              value={distribution.intensity ?? 1}
              step={0.01}
              min={0.01}
              onChange={(event) =>
                HandleParamChange("intensity", distribution.intensity ?? 1, event.target.value)
              }
            />
          </label>
        </div>
      ) : null}

      <div className="editor-grid">
        <label>
          min_value
          <input
            type="number"
            value={distribution.min_value ?? 0.01}
            step={0.01}
            onChange={(event) =>
              HandleParamChange("min_value", distribution.min_value ?? 0.01, event.target.value)
            }
          />
        </label>
      </div>
    </section>
  );
}
export function EditorPage({ on_run_ready }: EditorPageProps) {
  const initial_template = useMemo(() => BuildBaseTemplate(), []);
  const navigate = useNavigate();
  const location = useLocation();
  const canvas_panel_ref = useRef<HTMLDivElement | null>(null);

  const [model_name, setModelName] = useState(initial_template.model_name);
  const [config, setConfig] = useState<SimulationConfig>(initial_template.config);
  const [node_positions, setNodePositions] = useState<Record<string, NodePosition>>(
    initial_template.node_positions,
  );
  const [selected_node_id, setSelectedNodeId] = useState<string | null>(
    initial_template.config.nodes[0]?.node_id ?? null,
  );

  const [canvas_pan_x, setCanvasPanX] = useState(130);
  const [canvas_pan_y, setCanvasPanY] = useState(90);
  const [canvas_zoom, setCanvasZoom] = useState(1);
  const [interaction_state, setInteractionState] = useState<InteractionState>({
    interaction_type: "none",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task_status, setTaskStatus] = useState<TaskStatusResponse | null>(null);
  const [active_settings_tab, setActiveSettingsTab] = useState<EditorSettingsTab>("nodes");
  const [selected_route_for_edge_settings, setSelectedRouteForEdgeSettings] = useState<string>("");
  const [is_canvas_fullscreen, setIsCanvasFullscreen] = useState(false);

  const selected_node = useMemo(
    () => config.nodes.find((node) => node.node_id === selected_node_id) ?? null,
    [config.nodes, selected_node_id],
  );
  const selected_node_schedule = useMemo(() => {
    if (!selected_node) {
      return [] as NodeScheduleInterval[];
    }
    return NormalizeNodeSchedule(
      selected_node.schedule,
      selected_node.open_time,
      selected_node.close_time,
    );
  }, [selected_node]);
  const can_add_schedule_interval = useMemo(() => {
    const last_interval = selected_node_schedule[selected_node_schedule.length - 1];
    return Boolean(last_interval && last_interval.close_time !== null);
  }, [selected_node_schedule]);

  const base_run_id = useMemo(() => {
    const query = new URLSearchParams(location.search);
    const raw_run_id = query.get("from_run");
    if (!raw_run_id) {
      return null;
    }
    const normalized_run_id = raw_run_id.trim();
    return normalized_run_id.length > 0 ? normalized_run_id : null;
  }, [location.search]);

  const routes_with_edges = useMemo(() => {
    if (!selected_node || selected_node.node_type === "exit") {
      return [] as Array<{
        route_index: number;
        edge_id: string;
        target_node_id: string;
      }>;
    }

    return selected_node.routes
      .map((route, route_index) => {
        if (route.target_node_id === null || route.edge_id === null) {
          return null;
        }
        return {
          route_index,
          edge_id: route.edge_id,
          target_node_id: route.target_node_id,
        };
      })
      .filter(
        (item): item is { route_index: number; edge_id: string; target_node_id: string } => item !== null,
      );
  }, [selected_node]);

  const selected_route_index_for_edge_settings = useMemo(() => {
    const parsed = Number(selected_route_for_edge_settings);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }, [selected_route_for_edge_settings]);

  const selected_route_for_edge_distribution = useMemo(() => {
    if (
      !selected_node ||
      selected_node.node_type === "exit" ||
      selected_route_index_for_edge_settings === null
    ) {
      return null;
    }
    const route = selected_node.routes[selected_route_index_for_edge_settings];
    if (!route || route.target_node_id === null || route.edge_id === null) {
      return null;
    }
    return route;
  }, [selected_node, selected_route_index_for_edge_settings]);

  const selected_route_edge = useMemo(() => {
    if (!selected_node || selected_node.node_type === "exit" || !selected_route_for_edge_distribution) {
      return null;
    }
    return (
      config.edges.find(
        (edge) =>
          edge.edge_id === selected_route_for_edge_distribution.edge_id &&
          edge.source_node_id === selected_node.node_id &&
          edge.target_node_id === selected_route_for_edge_distribution.target_node_id,
      ) ?? null
    );
  }, [config.edges, selected_node, selected_route_for_edge_distribution]);

  const selected_node_probability_sum = useMemo(() => {
    if (!selected_node || selected_node.node_type === "exit") {
      return null;
    }
    return selected_node.routes.reduce((accumulator, route) => accumulator + route.probability, 0);
  }, [selected_node]);

  const selected_node_probability_percent = useMemo(() => {
    if (selected_node_probability_sum === null) {
      return null;
    }
    return selected_node_probability_sum * 100;
  }, [selected_node_probability_sum]);

  const selected_node_probability_is_valid = useMemo(() => {
    if (selected_node_probability_sum === null) {
      return true;
    }
    return IsProbabilitySumValid(selected_node_probability_sum);
  }, [selected_node_probability_sum]);

  useEffect(() => {
    if (!base_run_id) {
      return;
    }

    const run_id = base_run_id;
    let disposed = false;

    async function LoadModelFromRun() {
      setError(null);
      try {
        const run_data = await GetRunById(run_id);
        if (disposed) {
          return;
        }

        const normalized = NormalizeConfigAndLayout(run_data.model.config, {});
        setModelName(run_data.model.model_name);
        setConfig(normalized.config);
        setNodePositions(normalized.node_positions);
        setSelectedNodeId(normalized.config.nodes[0]?.node_id ?? null);
        setTaskStatus(null);
        setActiveSettingsTab("nodes");
        setSelectedRouteForEdgeSettings("");
        setCanvasPanX(130);
        setCanvasPanY(90);
        setCanvasZoom(1);
      } catch (request_error) {
        if (disposed) {
          return;
        }
        const error_response = request_error as AxiosError<{ detail?: string }>;
        setError(
          error_response.response?.data?.detail ??
            "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043c\u043e\u0434\u0435\u043b\u044c-\u043e\u0441\u043d\u043e\u0432\u0443. \u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443 \u043c\u043e\u0434\u0435\u043b\u0438 \u0441\u043d\u043e\u0432\u0430.",
        );
      }
    }

    void LoadModelFromRun();

    return () => {
      disposed = true;
    };
  }, [base_run_id]);

  useEffect(() => {
    if (!selected_node || selected_node.node_type === "exit") {
      setSelectedRouteForEdgeSettings("");
      return;
    }

    setSelectedRouteForEdgeSettings((current) => {
      if (selected_node.routes.some((_, route_index) => String(route_index) === current)) {
        return current;
      }
      if (routes_with_edges.length > 0) {
        return String(routes_with_edges[0].route_index);
      }
      return selected_node.routes.length > 0 ? "0" : "";
    });
  }, [routes_with_edges, selected_node]);

  const has_active_task = useMemo(() => {
    if (!task_status) {
      return false;
    }
    return task_status.status === "queued" || task_status.status === "running";
  }, [task_status]);

  const time_options = useMemo(
    () => BuildTimeOptions(config.simulation_duration),
    [config.simulation_duration],
  );

  function CommitModel(next_config: SimulationConfig, next_positions: Record<string, NodePosition>) {
    const normalized = NormalizeConfigAndLayout(next_config, next_positions);
    setConfig(normalized.config);
    setNodePositions(normalized.node_positions);

    setSelectedNodeId((current) => {
      if (current && normalized.config.nodes.some((node) => node.node_id === current)) {
        return current;
      }
      return normalized.config.nodes[0]?.node_id ?? null;
    });
  }

  function UpdateSelectedNode(updater: (node: NodeConfig) => void) {
    if (!selected_node_id) {
      return;
    }
    const next_config = CloneConfig(config);
    const node = next_config.nodes.find((candidate) => candidate.node_id === selected_node_id);
    if (!node) {
      return;
    }
    updater(node);
    CommitModel(next_config, { ...node_positions });
  }

  function UpdateEdgeById(edge_id: string, updater: (edge: EdgeConfig) => void) {
    const next_config = CloneConfig(config);
    const edge = next_config.edges.find((candidate) => candidate.edge_id === edge_id);
    if (!edge) {
      return;
    }
    updater(edge);
    CommitModel(next_config, { ...node_positions });
  }

  function HandleRestoreDefault() {
    const template = BuildBaseTemplate();
    setModelName(template.model_name);
    setTaskStatus(null);
    setError(null);
    setCanvasPanX(130);
    setCanvasPanY(90);
    setCanvasZoom(1);
    const normalized = NormalizeConfigAndLayout(template.config, template.node_positions);
    setConfig(normalized.config);
    setNodePositions(normalized.node_positions);
    setSelectedNodeId(normalized.config.nodes[0]?.node_id ?? null);
  }

  function HandleAddNode() {
    const next_config = CloneConfig(config);
    const next_positions = { ...node_positions };
    const node_id = CreateNodeId(next_config);
    const service_nodes_count = next_config.nodes.filter((node) => node.node_type === "service").length;
    const node_name = CreateServiceNodeName(service_nodes_count + 1);
    next_config.nodes.push(CreateDefaultNode(node_id, node_name, "service"));
    next_positions[node_id] = {
      x: 180 + (next_config.nodes.length % 4) * 240,
      y: 220 + Math.floor(next_config.nodes.length / 4) * 170,
    };

    const generator_config = EnsureGeneratorConfig(next_config);
    if (!generator_config.target_node_id) {
      generator_config.target_node_id = node_id;
    }

    CommitModel(next_config, next_positions);
    setSelectedNodeId(node_id);
  }

  function HandleRemoveSelectedNode() {
    if (!selected_node_id) {
      return;
    }
    const current_node = config.nodes.find((node) => node.node_id === selected_node_id);
    if (!current_node) {
      return;
    }
    if (current_node.node_type === "generator") {
      setError("РќРµР»СЊР·СЏ СѓРґР°Р»РёС‚СЊ РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ СѓР·РµР» С‚РёРїР° В«Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРєВ». РЎРЅР°С‡Р°Р»Р° РЅР°Р·РЅР°С‡СЊС‚Рµ РґСЂСѓРіРѕР№ СѓР·РµР» РіРµРЅРµСЂР°С‚РѕСЂРѕРј.");
      return;
    }
    if (current_node.node_type === "exit" && config.nodes.filter((node) => node.node_type === "exit").length <= 1) {
      setError("Р’ РјРѕРґРµР»Рё РґРѕР»Р¶РµРЅ РѕСЃС‚Р°РІР°С‚СЊСЃСЏ С…РѕС‚СЏ Р±С‹ РѕРґРёРЅ СѓР·РµР» С‚РёРїР° В«Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹В».");
      return;
    }
    const next_config = CloneConfig(config);
    const next_positions = { ...node_positions };

    next_config.nodes = next_config.nodes.filter((node) => node.node_id !== selected_node_id);
    next_config.edges = next_config.edges.filter(
      (edge) =>
        edge.source_node_id !== selected_node_id && edge.target_node_id !== selected_node_id,
    );
    delete next_positions[selected_node_id];

    for (const node of next_config.nodes) {
      node.routes = node.routes.map((route) => {
        if (route.target_node_id === selected_node_id) {
          return {
            target_node_id: null,
            edge_id: null,
            probability: route.probability,
          };
        }
        return route;
      });
    }

    CommitModel(next_config, next_positions);
    setSelectedNodeId(null);
  }

  function HandleSelectedNodeTypeChange(next_type: NodeType) {
    if (!selected_node_id) {
      return;
    }
    const next_config = CloneConfig(config);
    const node = next_config.nodes.find((candidate) => candidate.node_id === selected_node_id);
    if (!node) {
      return;
    }

    node.node_type = next_type;

    if (next_type === "generator") {
      node.channels = 1;
      if (!node.name || node.name.trim().length === 0 || node.name === "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹") {
        node.name = "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє";
      }
      if (!node.service_distribution) {
        node.service_distribution = {
          distribution_type: "deterministic",
          value: 0.01,
          min_value: 0.01,
        };
      }
      if (node.routes.length === 0) {
        node.routes = [{ target_node_id: null, edge_id: null, probability: 1 }];
      }
      EnsureGeneratorConfig(next_config).target_node_id = node.node_id;
    }

    if (next_type === "exit") {
      node.channels = 1;
      node.routes = [];
      node.service_distribution = null;
      if (!node.name || node.name.trim().length === 0 || node.name === "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє") {
        node.name = "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹";
      }
    }

    if (next_type === "service") {
      if (!node.name || node.name === "Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє" || node.name === "Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹") {
        const service_nodes_count = next_config.nodes.filter(
          (candidate) => candidate.node_type === "service",
        ).length;
        node.name = CreateServiceNodeName(Math.max(1, service_nodes_count));
      }
      if (!node.service_distribution) {
        node.service_distribution = CreateServiceDistribution();
      }
      if (node.routes.length === 0) {
        node.routes = [{ target_node_id: null, edge_id: null, probability: 1 }];
      }
    }

    CommitModel(next_config, { ...node_positions });
  }

  function HandleAddScheduleInterval() {
    if (!selected_node_id) {
      return;
    }
    UpdateSelectedNode((node) => {
      const current_schedule = NormalizeNodeSchedule(node.schedule, node.open_time, node.close_time);
      const last_interval = current_schedule[current_schedule.length - 1];
      if (!last_interval || last_interval.close_time === null) {
        return;
      }
      const next_open_time = last_interval.close_time + 1;
      current_schedule.push({
        open_time: next_open_time,
        close_time: next_open_time + 10,
      });
      node.schedule = NormalizeNodeSchedule(current_schedule, node.open_time, node.close_time);
      SyncLegacyScheduleFields(node);
    });
  }

  function HandleRemoveScheduleInterval(interval_index: number) {
    if (!selected_node_id) {
      return;
    }
    UpdateSelectedNode((node) => {
      const current_schedule = NormalizeNodeSchedule(node.schedule, node.open_time, node.close_time);
      if (current_schedule.length <= 1) {
        return;
      }
      node.schedule = NormalizeNodeSchedule(
        current_schedule.filter((_, index) => index !== interval_index),
        node.open_time,
        node.close_time,
      );
      SyncLegacyScheduleFields(node);
    });
  }

  function HandleScheduleIntervalChange(
    interval_index: number,
    field_name: "open_time" | "close_time",
    raw_value: string,
  ) {
    if (!selected_node_id) {
      return;
    }
    UpdateSelectedNode((node) => {
      const current_schedule = NormalizeNodeSchedule(node.schedule, node.open_time, node.close_time);
      const interval = current_schedule[interval_index];
      if (!interval) {
        return;
      }
      if (field_name === "open_time") {
        const parsed = ParseOptionalNumber(raw_value);
        if (parsed === null) {
          return;
        }
        interval.open_time = Math.max(0, parsed);
      } else {
        const parsed = ParseOptionalNumber(raw_value);
        interval.close_time = parsed === null ? null : Math.max(0, parsed);
      }
      node.schedule = NormalizeNodeSchedule(current_schedule, node.open_time, node.close_time);
      SyncLegacyScheduleFields(node);
    });
  }

  function HandleAddRouteForSelectedNode() {
    if (!selected_node_id || selected_node?.node_type === "exit") {
      return;
    }
    UpdateSelectedNode((node) => {
      node.routes.push({
        target_node_id: null,
        edge_id: null,
        probability: 0.2,
      });
    });
  }

  function HandleRemoveRouteForSelectedNode(route_index: number) {
    if (!selected_node_id || selected_node?.node_type === "exit") {
      return;
    }
    UpdateSelectedNode((node) => {
      if (node.routes.length <= 1) {
        return;
      }
      node.routes = node.routes.filter((_, index) => index !== route_index);
    });
  }

  function HandleRouteTargetChange(route_index: number, target_value: string) {
    if (!selected_node_id || selected_node?.node_type === "exit") {
      return;
    }
    UpdateSelectedNode((node) => {
      const route = node.routes[route_index];
      if (!route) {
        return;
      }

      if (target_value === "exit") {
        route.target_node_id = null;
        route.edge_id = null;
        return;
      }

      route.target_node_id = target_value;
      route.edge_id = null;
    });
  }

  function HandleRouteEdgeNameChange(route_index: number, edge_name: string) {
    UpdateSelectedNode((node) => {
      const route = node.routes[route_index];
      if (!route) {
        return;
      }
      route.edge_id = NormalizeRouteEdgeId(edge_name);
    });
  }

  function HandleRouteProbabilityChange(route_index: number, probability_value: string) {
    UpdateSelectedNode((node) => {
      const route = node.routes[route_index];
      if (!route) {
        return;
      }
      route.probability = ParseProbabilityPercent(probability_value);
    });
  }

  function HandleRouteEdgeDistributionChange(
    route_index: number,
    next_distribution: DistributionConfig,
  ) {
    if (!selected_node || selected_node.node_type === "exit") {
      return;
    }
    const route = selected_node.routes[route_index];
    if (!route || route.target_node_id === null || route.edge_id === null) {
      return;
    }

    UpdateEdgeById(route.edge_id, (edge) => {
      edge.travel_distribution = NormalizeDistributionConfig(
        next_distribution,
        edge_distribution_types,
        "uniform",
      );
    });
  }

  function HandleSetZoom(next_zoom: number) {
    setCanvasZoom(ClampZoom(next_zoom));
  }

  async function HandleToggleCanvasFullscreen() {
    const canvas_panel = canvas_panel_ref.current;
    if (!canvas_panel) {
      return;
    }

    try {
      if (document.fullscreenElement === canvas_panel) {
        await document.exitFullscreen();
        return;
      }

      await canvas_panel.requestFullscreen();
    } catch {
      setError("РќРµ СѓРґР°Р»РѕСЃСЊ РїРµСЂРµРєР»СЋС‡РёС‚СЊ РїРѕР»РЅРѕСЌРєСЂР°РЅРЅС‹Р№ СЂРµР¶РёРј СЃС…РµРјС‹.");
    }
  }

  function HandleCanvasMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("[data-node-card]") || target.closest("[data-edge-line]")) {
      return;
    }

    setInteractionState({
      interaction_type: "panning",
      start_client_x: event.clientX,
      start_client_y: event.clientY,
      start_pan_x: canvas_pan_x,
      start_pan_y: canvas_pan_y,
    });
    event.preventDefault();
  }

  function HandleNodeMouseDown(event: ReactMouseEvent<HTMLButtonElement>, node_id: string) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = node_positions[node_id] ?? { x: 0, y: 0 };
    setSelectedNodeId(node_id);
    setInteractionState({
      interaction_type: "dragging_node",
      node_id,
      start_client_x: event.clientX,
      start_client_y: event.clientY,
      start_node_x: position.x,
      start_node_y: position.y,
    });
  }

  useEffect(() => {
    if (interaction_state.interaction_type === "none") {
      return;
    }

    function HandleMouseMove(event: MouseEvent) {
      if (interaction_state.interaction_type === "panning") {
        setCanvasPanX(
          interaction_state.start_pan_x + (event.clientX - interaction_state.start_client_x),
        );
        setCanvasPanY(
          interaction_state.start_pan_y + (event.clientY - interaction_state.start_client_y),
        );
      }

      if (interaction_state.interaction_type === "dragging_node") {
        const delta_x = (event.clientX - interaction_state.start_client_x) / canvas_zoom;
        const delta_y = (event.clientY - interaction_state.start_client_y) / canvas_zoom;
        const next_x = Math.max(-900, Math.min(2100, interaction_state.start_node_x + delta_x));
        const next_y = Math.max(-700, Math.min(1400, interaction_state.start_node_y + delta_y));

        setNodePositions((current) => ({
          ...current,
          [interaction_state.node_id]: {
            x: next_x,
            y: next_y,
          },
        }));
      }
    }

    function HandleMouseUp() {
      setInteractionState({ interaction_type: "none" });
    }

    window.addEventListener("mousemove", HandleMouseMove);
    window.addEventListener("mouseup", HandleMouseUp);
    return () => {
      window.removeEventListener("mousemove", HandleMouseMove);
      window.removeEventListener("mouseup", HandleMouseUp);
    };
  }, [canvas_zoom, interaction_state]);

  useEffect(() => {
    function HandleFullscreenChange() {
      const canvas_panel = canvas_panel_ref.current;
      setIsCanvasFullscreen(Boolean(canvas_panel && document.fullscreenElement === canvas_panel));
    }

    document.addEventListener("fullscreenchange", HandleFullscreenChange);
    HandleFullscreenChange();
    return () => {
      document.removeEventListener("fullscreenchange", HandleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!has_active_task || !task_status?.task_id) {
      return;
    }

    let disposed = false;
    const timer_id = setInterval(async () => {
      try {
        const status_data = await GetSimulationStatus(task_status.task_id);
        if (disposed) {
          return;
        }
        setTaskStatus(status_data);
        if (status_data.status === "completed" && status_data.run_id) {
          on_run_ready(status_data.run_id);
        }
      } catch (poll_error) {
        if (disposed) {
          return;
        }
        const request_error = poll_error as AxiosError<{ detail?: string }>;
        setError(request_error.response?.data?.detail ?? "РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ СЃС‚Р°С‚СѓСЃ Р·Р°РґР°С‡Рё");
      }
    }, 1200);

    return () => {
      disposed = true;
      clearInterval(timer_id);
    };
  }, [has_active_task, on_run_ready, task_status?.task_id]);

  async function HandleStartModeling() {
    setLoading(true);
    setError(null);
    try {
      const trimmed_model_name = model_name.trim();
      if (trimmed_model_name.length === 0) {
        setError("Р’РІРµРґРёС‚Рµ РЅР°Р·РІР°РЅРёРµ РјРѕРґРµР»Рё.");
        return;
      }

      const normalized = NormalizeConfigAndLayout(config, node_positions);
      setConfig(normalized.config);
      setNodePositions(normalized.node_positions);
      setModelName(trimmed_model_name);

      const probability_error = ValidateProbabilitySums(normalized.config);
      if (probability_error) {
        setError(probability_error);
        return;
      }

      const start_data = await StartSimulation({
        model_name: trimmed_model_name,
        config: normalized.config,
      });

      setTaskStatus({
        task_id: start_data.task_id,
        status: "queued",
        model_name: trimmed_model_name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: null,
        run_id: null,
        summary: null,
      });
    } catch (request_error) {
      const error_response = request_error as AxiosError<{ detail?: string }>;
      if (error_response.response?.data?.detail) {
        const detail = error_response.response.data.detail;
        setError(typeof detail === "string" ? detail : JSON.stringify(detail));
      } else {
        setError("РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РїСѓСЃС‚РёС‚СЊ РјРѕРґРµР»РёСЂРѕРІР°РЅРёРµ.");
      }
    } finally {
      setLoading(false);
    }
  }

  const edge_visuals = useMemo(() => {
    return config.edges
      .map((edge) => {
        const source_position = node_positions[edge.source_node_id];
        const target_position = node_positions[edge.target_node_id];
        if (!source_position || !target_position) {
          return null;
        }

        const x1 = source_position.x + node_box_width;
        const y1 = source_position.y + node_box_height * 0.5;
        const x2 = target_position.x;
        const y2 = target_position.y + node_box_height * 0.5;
        const mid_x = (x1 + x2) * 0.5;
        const mid_y = (y1 + y2) * 0.5;

        return {
          edge,
          x1,
          y1,
          x2,
          y2,
          mid_x,
          mid_y,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [config.edges, node_positions]);

  return (
    <section className="page-panel editor-page-shell">
      <div className="editor-header">
        <h2>Р’РёР·СѓР°Р»СЊРЅС‹Р№ СЂРµРґР°РєС‚РѕСЂ РјРѕРґРµР»Рё</h2>
        <p>
          РџРµСЂРµС‚Р°СЃРєРёРІР°Р№С‚Рµ СѓР·Р»С‹ РјС‹С€СЊСЋ. Р”Р»СЏ РїРµСЂРµРјРµС‰РµРЅРёСЏ РІСЃРµР№ СЃС…РµРјС‹ Р·Р°Р¶РјРёС‚Рµ Р»РµРІСѓСЋ РєРЅРѕРїРєСѓ РЅР° РїСѓСЃС‚РѕРј
          РјРµСЃС‚Рµ С…РѕР»СЃС‚Р° Рё С‚СЏРЅРёС‚Рµ.
        </p>
      </div>

      <div className="editor-sticky-actions">
        <div className="editor-sticky-main">
          <button onClick={HandleStartModeling} disabled={loading || has_active_task}>
            {loading ? "Р—Р°РїСѓСЃРє..." : "РњРѕРґРµР»РёСЂРѕРІР°РЅРёРµ"}
          </button>
          {task_status?.run_id ? (
            <button onClick={() => navigate(`/results/${task_status.run_id}`)}>
              Р РµР·СѓР»СЊС‚Р°С‚С‹ РјРѕРґРµР»РёСЂРѕРІР°РЅРёСЏ
            </button>
          ) : null}
        </div>
        <div className="editor-sticky-meta">
          <span>РњР°СЃС€С‚Р°Р±: {Math.round(canvas_zoom * 100)}%</span>
          {task_status ? (
            <span>
              РЎС‚Р°С‚СѓСЃ: <strong>{task_status.status}</strong>
            </span>
          ) : null}
        </div>
        <DismissibleError message={task_status?.error} compact />
      </div>

      <div className="editor-layout">
        <div
          ref={canvas_panel_ref}
          className={`editor-canvas-panel ${is_canvas_fullscreen ? "is-fullscreen" : ""}`}
        >
          <div className="canvas-toolbar">
            <button onClick={HandleRestoreDefault} type="button" className="secondary">
              РЎР±СЂРѕСЃРёС‚СЊ СЃС…РµРјСѓ
            </button>
            <button
              onClick={() => void HandleToggleCanvasFullscreen()}
              type="button"
              className="secondary"
            >
              {is_canvas_fullscreen ? "Свернуть схему" : "Развернуть схему"}
            </button>
            <div className="zoom-controls">
              <button
                type="button"
                className="secondary"
                onClick={() => HandleSetZoom(canvas_zoom - 0.1)}
                aria-label="РЈРјРµРЅСЊС€РёС‚СЊ РјР°СЃС€С‚Р°Р±"
              >
                -
              </button>
              <input
                type="range"
                min={min_canvas_zoom}
                max={max_canvas_zoom}
                step={0.05}
                value={canvas_zoom}
                onChange={(event) => HandleSetZoom(Number(event.target.value))}
              />
              <button
                type="button"
                className="secondary"
                onClick={() => HandleSetZoom(canvas_zoom + 0.1)}
                aria-label="РЈРІРµР»РёС‡РёС‚СЊ РјР°СЃС€С‚Р°Р±"
              >
                +
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => HandleSetZoom(1)}
                aria-label="РЎР±СЂРѕСЃРёС‚СЊ РјР°СЃС€С‚Р°Р±"
              >
                100%
              </button>
            </div>
          </div>

          <div
            className="canvas-viewport"
            onMouseDown={HandleCanvasMouseDown}
          >
            <div
              className="canvas-world"
              style={{
                transform: `translate(${canvas_pan_x}px, ${canvas_pan_y}px) scale(${canvas_zoom})`,
                width: `${world_width}px`,
                height: `${world_height}px`,
              }}
            >
              <svg className="canvas-edge-layer" viewBox={`0 0 ${world_width} ${world_height}`}>
                <defs>
                  <marker
                    id="arrowHead"
                    markerWidth="12"
                    markerHeight="8"
                    refX="11"
                    refY="4"
                    orient="auto"
                  >
                    <polygon points="0,0 12,4 0,8" fill="#5b7284" />
                  </marker>
                </defs>
                {edge_visuals.map((visual) => (
                  <g key={visual.edge.edge_id}>
                    <line
                      data-edge-line="true"
                      className="edge-line"
                      x1={visual.x1}
                      y1={visual.y1}
                      x2={visual.x2}
                      y2={visual.y2}
                      markerEnd="url(#arrowHead)"
                    />
                    <rect
                      x={visual.mid_x - 44}
                      y={visual.mid_y - 12}
                      width={88}
                      height={24}
                      rx={8}
                      className="edge-label-bg"
                    />
                    <text x={visual.mid_x} y={visual.mid_y + 5} textAnchor="middle" className="edge-label">
                      {visual.edge.edge_id}
                    </text>
                  </g>
                ))}
              </svg>

              {config.nodes.map((node) => {
                const position = node_positions[node.node_id] ?? { x: 0, y: 0 };
                const is_selected = selected_node_id === node.node_id;
                return (
                  <button
                    key={node.node_id}
                    type="button"
                    data-node-card="true"
                    className={`node-card ${is_selected ? "selected" : ""}`}
                    style={{
                      left: `${position.x}px`,
                      top: `${position.y}px`,
                      width: `${node_box_width}px`,
                      height: `${node_box_height}px`,
                    }}
                    onMouseDown={(event) => HandleNodeMouseDown(event, node.node_id)}
                    onClick={() => {
                      setSelectedNodeId(node.node_id);
                    }}
                  >
                    <span className="node-card-title">{node.name}</span>
                    <span className="node-card-meta">id: {node.node_id}</span>
                    <span className="node-card-meta">РљР°РЅР°Р»РѕРІ: {node.channels}</span>
                    {node.node_type === "generator" ? (
                      <span className="generator-badge">Р“РµРЅРµСЂР°С‚РѕСЂ</span>
                    ) : null}
                    {node.node_type === "exit" ? <span className="exit-badge">Р’С‹С…РѕРґ</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="editor-side-panel">
          <div className="editor-tabs">
            <button
              type="button"
              className={`secondary ${active_settings_tab === "general" ? "active-tab" : ""}`}
              onClick={() => setActiveSettingsTab("general")}
            >
              РћР±С‰РµРµ РјРѕРґРµР»РёСЂРѕРІР°РЅРёРµ
            </button>
            <button
              type="button"
              className={`secondary ${active_settings_tab === "nodes" ? "active-tab" : ""}`}
              onClick={() => setActiveSettingsTab("nodes")}
            >
              РџР°СЂР°РјРµС‚СЂС‹ РІРµСЂС€РёРЅС‹
            </button>
          </div>

          {active_settings_tab === "general" ? (
            <section className="editor-section">
              <h3>РћР±С‰РёРµ РЅР°СЃС‚СЂРѕР№РєРё РјРѕРґРµР»РёСЂРѕРІР°РЅРёСЏ</h3>
              <div className="editor-grid">
                <label>
                  РќР°Р·РІР°РЅРёРµ РјРѕРґРµР»Рё
                  <input
                    type="text"
                    value={model_name}
                    onChange={(event) => setModelName(event.target.value)}
                    placeholder="Р’РІРµРґРёС‚Рµ РЅР°Р·РІР°РЅРёРµ РјРѕРґРµР»Рё"
                  />
                </label>

                <label>
                  Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ РјРѕРґРµР»РёСЂРѕРІР°РЅРёСЏ (РјРёРЅ)
                  <input
                    type="number"
                    min={1}
                    step={0.1}
                    value={String(config.simulation_duration)}
                    onChange={(event) => {
                      const next_config = CloneConfig(config);
                      const next_value = ParseSelectNumber(event.target.value, config.simulation_duration);
                      next_config.simulation_duration = Math.max(1, next_value);
                      CommitModel(next_config, { ...node_positions });
                    }}
                  />
                </label>

                <label>
                  РЎРёРґ РјРѕРґРµР»РёСЂРѕРІР°РЅРёСЏ
                  <input
                    type="number"
                    step={1}
                    value={config.random_seed === null ? "" : String(config.random_seed)}
                    placeholder="РџСѓСЃС‚Рѕ вЂ” СЃР»СѓС‡Р°Р№РЅС‹Р№"
                    onChange={(event) => {
                      const next_config = CloneConfig(config);
                      const parsed = ParseOptionalNumber(event.target.value);
                      next_config.random_seed = parsed === null ? null : Math.round(parsed);
                      CommitModel(next_config, { ...node_positions });
                    }}
                  />
                </label>

                <label>
                  РњР°РєСЃРёРјСѓРј Р·Р°СЏРІРѕРє
                  <select
                    value={ToSelectValue(config.max_requests)}
                    onChange={(event) => {
                      const next_config = CloneConfig(config);
                      next_config.max_requests =
                        event.target.value === "none"
                          ? null
                          : ParseSelectNumber(event.target.value, config.max_requests ?? 1000);
                      CommitModel(next_config, { ...node_positions });
                    }}
                  >
                    {requests_options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                    <option value="none">Р‘РµР· РѕРіСЂР°РЅРёС‡РµРЅРёСЏ</option>
                  </select>
                </label>
              </div>
            </section>
          ) : null}

          {active_settings_tab === "nodes" ? (
            <section className="editor-section">
              <h3>РЈР·Р»С‹</h3>

              <div className="action-row">
                <button type="button" onClick={HandleAddNode}>
                  Р”РѕР±Р°РІРёС‚СЊ СѓР·РµР» РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={HandleRemoveSelectedNode}
                  disabled={!selected_node_id}
                >
                  РЈРґР°Р»РёС‚СЊ РІС‹Р±СЂР°РЅРЅС‹Р№ СѓР·РµР»
                </button>
              </div>

              <div className="editor-grid">
                <label>
                  РђРєС‚РёРІРЅС‹Р№ СѓР·РµР»
                  <select
                    value={selected_node_id ?? ""}
                    onChange={(event) => setSelectedNodeId(event.target.value || null)}
                  >
                    <option value="">РќРµ РІС‹Р±СЂР°РЅ</option>
                    {config.nodes.map((node) => (
                      <option key={node.node_id} value={node.node_id}>
                        {node.node_id} В· {node.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {selected_node ? (
                <>
                  <div className="editor-grid">
                    <label>
                      РўРёРї СѓР·Р»Р°
                      <select
                        value={selected_node.node_type}
                        onChange={(event) =>
                          HandleSelectedNodeTypeChange(event.target.value as NodeConfig["node_type"])
                        }
                      >
                        <option value="service">РЈР·РµР» РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ</option>
                        <option value="generator">Р“РµРЅРµСЂР°С‚РѕСЂ Р·Р°СЏРІРѕРє</option>
                        <option value="exit">Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹</option>
                      </select>
                    </label>

                    <label>
                      РќР°Р·РІР°РЅРёРµ СѓР·Р»Р°
                      <input
                        type="text"
                        value={selected_node.name}
                        onChange={(event) => {
                          UpdateSelectedNode((node) => {
                            node.name = event.target.value;
                          });
                        }}
                        placeholder="Р’РІРµРґРёС‚Рµ РЅР°Р·РІР°РЅРёРµ СѓР·Р»Р°"
                      />
                    </label>

                    {selected_node.node_type === "service" ? (
                      <label>
                        РљР°РЅР°Р»С‹ РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={String(selected_node.channels)}
                          onChange={(event) => {
                            UpdateSelectedNode((node) => {
                              const parsed = ParseOptionalNumber(event.target.value);
                              if (parsed === null) {
                                return;
                              }
                              node.channels = Math.max(1, Math.round(parsed));
                            });
                          }}
                        />
                      </label>
                    ) : null}

                  </div>

                  {selected_node.node_type === "service" ? (
                    <div className="node-schedule-block">
                      <div className="routes-header">
                        <h4>Р“СЂР°С„РёРє СЂР°Р±РѕС‚С‹</h4>
                        <button
                          type="button"
                          onClick={HandleAddScheduleInterval}
                          disabled={!can_add_schedule_interval}
                        >
                          Р”РѕР±Р°РІРёС‚СЊ РёРЅС‚РµСЂРІР°Р»
                        </button>
                      </div>

                      <div className="node-schedule-list">
                        {selected_node_schedule.map((schedule_interval, interval_index) => (
                          <div
                            key={`${selected_node.node_id}_schedule_${interval_index}`}
                            className="editor-grid node-schedule-row"
                          >
                            <label>
                              РћС‚РєСЂС‹РІР°РµС‚СЃСЏ РІ
                              <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={String(schedule_interval.open_time)}
                                onChange={(event) =>
                                  HandleScheduleIntervalChange(
                                    interval_index,
                                    "open_time",
                                    event.target.value,
                                  )
                                }
                              />
                            </label>

                            <label>
                              Р—Р°РєСЂС‹РІР°РµС‚СЃСЏ РІ
                              <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={
                                  schedule_interval.close_time === null
                                    ? ""
                                    : String(schedule_interval.close_time)
                                }
                                placeholder="РџСѓСЃС‚Рѕ вЂ” РЅРµ Р·Р°РєСЂС‹РІР°РµС‚СЃСЏ"
                                onChange={(event) =>
                                  HandleScheduleIntervalChange(
                                    interval_index,
                                    "close_time",
                                    event.target.value,
                                  )
                                }
                              />
                            </label>

                            <div className="node-schedule-actions">
                              <button
                                type="button"
                                className="secondary small"
                                onClick={() => HandleRemoveScheduleInterval(interval_index)}
                                disabled={selected_node_schedule.length <= 1}
                              >
                                РЈРґР°Р»РёС‚СЊ РёРЅС‚РµСЂРІР°Р»
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selected_node.node_type === "generator" ? (
                    <>
                      <div className="editor-grid">
                        <label>
                          Р’СЂРµРјСЏ СЃС‚Р°СЂС‚Р° РіРµРЅРµСЂР°С‚РѕСЂР°
                          <select
                            value={String(config.generator?.start_time ?? 0)}
                            onChange={(event) => {
                              const next_config = CloneConfig(config);
                              const generator_config = EnsureGeneratorConfig(next_config);
                              generator_config.start_time = ParseSelectNumber(
                                event.target.value,
                                config.generator?.start_time ?? 0,
                              );
                              CommitModel(next_config, { ...node_positions });
                            }}
                          >
                            {time_options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          Р’СЂРµРјСЏ РѕСЃС‚Р°РЅРѕРІРєРё РіРµРЅРµСЂР°С‚РѕСЂР°
                          <select
                            value={ToSelectValue(config.generator?.stop_time ?? null)}
                            onChange={(event) => {
                              const next_config = CloneConfig(config);
                              const generator_config = EnsureGeneratorConfig(next_config);
                              generator_config.stop_time =
                                event.target.value === "none"
                                  ? null
                                  : ParseSelectNumber(
                                      event.target.value,
                                      config.generator?.stop_time ?? config.simulation_duration,
                                    );
                              CommitModel(next_config, { ...node_positions });
                            }}
                          >
                            <option value="none">РќРµ РѕСЃС‚Р°РЅР°РІР»РёРІР°С‚СЊ</option>
                            {time_options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <DistributionEditor
                        title="Р—Р°РєРѕРЅ РіРµРЅРµСЂР°С†РёРё Р·Р°СЏРІРѕРє"
                        distribution={
                          config.generator?.interarrival_distribution ??
                          CreateInterarrivalDistribution()
                        }
                        on_change={(next_distribution) => {
                          const next_config = CloneConfig(config);
                          const generator_config = EnsureGeneratorConfig(next_config);
                          generator_config.interarrival_distribution = next_distribution;
                          CommitModel(next_config, { ...node_positions });
                        }}
                        allowed_types={generator_distribution_types}
                        compact
                      />
                    </>
                  ) : null}

                  {selected_node.node_type === "service" && selected_node.service_distribution ? (
                    <DistributionEditor
                      title="Р Р°СЃРїСЂРµРґРµР»РµРЅРёРµ РІСЂРµРјРµРЅРё РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ СѓР·Р»Р°"
                      distribution={selected_node.service_distribution}
                      on_change={(next_distribution) => {
                        UpdateSelectedNode((node) => {
                          node.service_distribution = next_distribution;
                        });
                      }}
                      allowed_types={service_distribution_types}
                      compact
                    />
                  ) : null}

                  {selected_node.node_type !== "exit" ? (
                    <div className="routes-block">
                      <div className="routes-header">
                        <h4>РњР°СЂС€СЂСѓС‚С‹ Р·Р°СЏРІРѕРє</h4>
                        <button type="button" onClick={HandleAddRouteForSelectedNode}>
                          Р”РѕР±Р°РІРёС‚СЊ РјР°СЂС€СЂСѓС‚
                        </button>
                      </div>

                      <div className="routes-table-wrapper">
                        <table className="routes-table">
                          <thead>
                            <tr>
                              <th>РќР°Р·РІР°РЅРёРµ СЂРµР±СЂР°</th>
                              <th>РљСѓРґР° РёРґРµС‚</th>
                              <th>Р’РµСЂРѕСЏС‚РЅРѕСЃС‚СЊ, %</th>
                              <th className="route-action-header" />
                              <th className="route-action-header" />
                            </tr>
                          </thead>
                          <tbody>
                            {selected_node.routes.map((route, route_index) => {
                              const is_selected_route =
                                String(route_index) === selected_route_for_edge_settings;
                              return (
                                <tr
                                  key={`${selected_node.node_id}_${route_index}`}
                                  className={is_selected_route ? "is-selected-route" : ""}
                                  onClick={() =>
                                    setSelectedRouteForEdgeSettings(String(route_index))
                                  }
                                >
                                  <td>
                                    <textarea
                                      rows={2}
                                      className="route-name-field"
                                      value={route.edge_id ?? ""}
                                      disabled={route.target_node_id === null}
                                      onFocus={() =>
                                        setSelectedRouteForEdgeSettings(String(route_index))
                                      }
                                      onChange={(event) =>
                                        HandleRouteEdgeNameChange(route_index, event.target.value)
                                      }
                                      placeholder={
                                        route.target_node_id === null
                                          ? "РЎРЅР°С‡Р°Р»Р° РІС‹Р±РµСЂРёС‚Рµ С†РµР»СЊ"
                                          : "Р’РІРµРґРёС‚Рµ РЅР°Р·РІР°РЅРёРµ СЂРµР±СЂР°"
                                      }
                                    />
                                  </td>
                                  <td>
                                    <select
                                      value={route.target_node_id ?? "exit"}
                                      onFocus={() =>
                                        setSelectedRouteForEdgeSettings(String(route_index))
                                      }
                                      onChange={(event) =>
                                        HandleRouteTargetChange(route_index, event.target.value)
                                      }
                                    >
                                      <option value="exit">Р’С‹С…РѕРґ РёР· СЃРёСЃС‚РµРјС‹</option>
                                      {config.nodes
                                        .filter((node) => node.node_id !== selected_node.node_id)
                                        .filter((node) => node.node_type !== "generator")
                                        .map((node) => (
                                          <option key={node.node_id} value={node.node_id}>
                                            {node.node_id} В· {node.name}
                                          </option>
                                        ))}
                                    </select>
                                  </td>
                                  <td>
                                    <input
                                      type="number"
                                      min={0}
                                      max={100}
                                      step={0.01}
                                      value={Number((route.probability * 100).toFixed(4))}
                                      onFocus={() =>
                                        setSelectedRouteForEdgeSettings(String(route_index))
                                      }
                                      onChange={(event) =>
                                        HandleRouteProbabilityChange(route_index, event.target.value)
                                      }
                                    />
                                  </td>
                                  <td className="route-action-cell">
                                    <button
                                      type="button"
                                      className="secondary small"
                                      aria-label="РР·РјРµРЅРёС‚СЊ РјР°СЂС€СЂСѓС‚"
                                      title="РР·РјРµРЅРёС‚СЊ РјР°СЂС€СЂСѓС‚"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setSelectedRouteForEdgeSettings(String(route_index));
                                      }}
                                    >
                                      <span className="route-action-icon" aria-hidden="true">
                                        вњЋ
                                      </span>
                                    </button>
                                  </td>
                                  <td className="route-action-cell">
                                    <button
                                      type="button"
                                      className="secondary small route-remove-button"
                                      aria-label="РЈРґР°Р»РёС‚СЊ РјР°СЂС€СЂСѓС‚"
                                      title="РЈРґР°Р»РёС‚СЊ РјР°СЂС€СЂСѓС‚"
                                      disabled={selected_node.routes.length <= 1}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        HandleRemoveRouteForSelectedNode(route_index);
                                      }}
                                    >
                                      <span className="route-action-icon" aria-hidden="true">
                                        рџ—‘
                                      </span>
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={2} className="routes-summary-title">
                                РЎСѓРјРјР°СЂРЅР°СЏ РІРµСЂРѕСЏС‚РЅРѕСЃС‚СЊ РїРµСЂРµС…РѕРґР°
                              </td>
                              <td
                                className={`routes-summary-value ${
                                  selected_node_probability_is_valid ? "" : "is-invalid"
                                }`}
                              >
                                {selected_node_probability_percent !== null
                                  ? `${selected_node_probability_percent.toFixed(2)}%`
                                  : "вЂ”"}
                              </td>
                              <td className="routes-summary-empty" />
                              <td className="routes-summary-empty" />
                            </tr>
                          </tfoot>
                        </table>
                      </div>

                      {!selected_node_probability_is_valid ? (
                        <div className="route-probability-warning">
                          РЎСѓРјРјР°СЂРЅР°СЏ РІРµСЂРѕСЏС‚РЅРѕСЃС‚СЊ РїРµСЂРµС…РѕРґР° РґРѕР»Р¶РЅР° Р±С‹С‚СЊ 100%.
                        </div>
                      ) : null}

                      <div className="route-edge-settings">
                        {selected_route_edge && selected_route_index_for_edge_settings !== null ? (
                          <DistributionEditor
                            title={`РџР°СЂР°РјРµС‚СЂС‹ СЂРµР±СЂР° ${selected_route_edge.edge_id}`}
                            distribution={selected_route_edge.travel_distribution}
                            on_change={(next_distribution) =>
                              HandleRouteEdgeDistributionChange(
                                selected_route_index_for_edge_settings,
                                next_distribution,
                              )
                            }
                            allowed_types={edge_distribution_types}
                            compact
                          />
                        ) : selected_route_for_edge_distribution ? (
                          <div className="muted-text">
                            Р РµР±СЂРѕ СЃ С‚Р°РєРёРј РЅР°Р·РІР°РЅРёРµРј СѓР¶Рµ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ РІ РґСЂСѓРіРѕРј РјР°СЂС€СЂСѓС‚Рµ.
                            РЈРєР°Р¶РёС‚Рµ СѓРЅРёРєР°Р»СЊРЅРѕРµ РЅР°Р·РІР°РЅРёРµ СЂРµР±СЂР°.
                          </div>
                        ) : (
                          <div className="muted-text">
                            Р”Р»СЏ РЅР°СЃС‚СЂРѕР№РєРё РїР°СЂР°РјРµС‚СЂРѕРІ СЂРµР±СЂР° Р·Р°РґР°Р№С‚Рµ РґР»СЏ РјР°СЂС€СЂСѓС‚Р° С†РµР»СЊ Рё РЅР°Р·РІР°РЅРёРµ,
                            Р·Р°С‚РµРј РІС‹Р±РµСЂРёС‚Рµ СЃС‚СЂРѕРєСѓ СЂРµР±СЂР° РІ С‚Р°Р±Р»РёС†Рµ.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="muted-text">РЈР·РµР» РІС‹С…РѕРґР° РЅРµ РёРјРµРµС‚ РёСЃС…РѕРґСЏС‰РёС… РјР°СЂС€СЂСѓС‚РѕРІ Рё РїР°СЂР°РјРµС‚СЂРѕРІ РѕР±СЃР»СѓР¶РёРІР°РЅРёСЏ.</div>
                  )}
                </>
              ) : null}
            </section>
          ) : null}

          <DismissibleError message={error} on_dismiss={() => setError(null)} />
        </aside>
      </div>
    </section>
  );
}


