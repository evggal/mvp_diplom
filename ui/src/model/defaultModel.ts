import type { DistributionConfig, SimulationConfig } from "../types";

export interface NodePosition {
  x: number;
  y: number;
}

export interface ModelTemplate {
  model_name: string;
  config: SimulationConfig;
  node_positions: Record<string, NodePosition>;
}

export const node_name_options = [
  "Генератор заявок",
  "Прием заявок",
  "Первичная проверка",
  "Обработка",
  "Согласование",
  "Финальная проверка",
  "Архивирование",
  "Отгрузка",
  "Выход из системы",
];

export const service_node_name_options = node_name_options.filter(
  (value) => value !== "Генератор заявок" && value !== "Выход из системы",
);

export const model_name_options = [
  "Базовая линия",
  "Контроль качества",
  "Пиковая нагрузка",
  "Сервисный сценарий",
];

export const channels_options = [1, 2, 3, 4, 5, 6];
export const duration_options = [60, 90, 120, 180, 240, 300, 360];
export const requests_options = [300, 500, 800, 1200, 1800, 2500, 3500, 5000];
export const seed_options = [1, 3, 7, 13, 21, 42, 77, 101];
export const probability_options = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.65, 0.8, 1];
export const time_step_options = [
  0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 110, 130, 150, 180, 210, 240, 300,
];

function CreateDistribution(overrides: Partial<DistributionConfig>): DistributionConfig {
  return {
    distribution_type: "normal",
    min_value: 0.01,
    ...overrides,
  };
}

export function BuildBaseTemplate(): ModelTemplate {
  return {
    model_name: model_name_options[0],
    config: {
      simulation_duration: 120,
      random_seed: 42,
      max_requests: 1200,
      generator: {
        target_node_id: "node_1",
        start_time: 0,
        stop_time: 110,
        interarrival_distribution: CreateDistribution({
          distribution_type: "poisson",
          rate: 0.9,
          min_value: 0.01,
        }),
      },
      nodes: [
        {
          node_id: "node_1",
          name: "Генератор заявок",
          node_type: "generator",
          open_time: 0,
          close_time: null,
          channels: 1,
          service_distribution: CreateDistribution({
            distribution_type: "deterministic",
            value: 0.01,
            min_value: 0.01,
          }),
          routes: [
            {
              target_node_id: "node_2",
              edge_id: "edge_1",
              probability: 1,
            },
          ],
        },
        {
          node_id: "node_2",
          name: "Прием заявок",
          node_type: "service",
          open_time: 0,
          close_time: null,
          channels: 2,
          service_distribution: CreateDistribution({
            distribution_type: "normal",
            mean: 1.7,
            std: 0.5,
            min_value: 0.05,
          }),
          routes: [
            {
              target_node_id: "node_3",
              edge_id: "edge_2",
              probability: 0.85,
            },
            {
              target_node_id: "node_4",
              edge_id: "edge_3",
              probability: 0.15,
            },
          ],
        },
        {
          node_id: "node_3",
          name: "Проверка",
          node_type: "service",
          open_time: 0,
          close_time: null,
          channels: 1,
          service_distribution: CreateDistribution({
            distribution_type: "normal",
            mean: 2.6,
            std: 0.7,
            min_value: 0.05,
          }),
          routes: [
            {
              target_node_id: "node_4",
              edge_id: "edge_4",
              probability: 1,
            },
          ],
        },
        {
          node_id: "node_4",
          name: "Выход из системы",
          node_type: "exit",
          open_time: 0,
          close_time: null,
          channels: 1,
          service_distribution: null,
          routes: [],
        },
      ],
      edges: [
        {
          edge_id: "edge_1",
          source_node_id: "node_1",
          target_node_id: "node_2",
          travel_distribution: CreateDistribution({
            distribution_type: "uniform",
            low: 0.01,
            high: 0.05,
          }),
        },
        {
          edge_id: "edge_2",
          source_node_id: "node_2",
          target_node_id: "node_3",
          travel_distribution: CreateDistribution({
            distribution_type: "uniform",
            low: 0.15,
            high: 0.8,
          }),
        },
        {
          edge_id: "edge_3",
          source_node_id: "node_2",
          target_node_id: "node_4",
          travel_distribution: CreateDistribution({
            distribution_type: "uniform",
            low: 0.1,
            high: 0.45,
          }),
        },
        {
          edge_id: "edge_4",
          source_node_id: "node_3",
          target_node_id: "node_4",
          travel_distribution: CreateDistribution({
            distribution_type: "uniform",
            low: 0.08,
            high: 0.4,
          }),
        },
      ],
    },
    node_positions: {
      node_1: { x: 90, y: 200 },
      node_2: { x: 390, y: 200 },
      node_3: { x: 700, y: 200 },
      node_4: { x: 1010, y: 200 },
    },
  };
}

export const default_simulation_config = BuildBaseTemplate().config;
