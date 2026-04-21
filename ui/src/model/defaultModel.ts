import type { SimulationConfig } from "../types";

export const default_simulation_config: SimulationConfig = {
  simulation_duration: 120,
  random_seed: 42,
  max_requests: 1200,
  generator: {
    target_node_id: "node_a",
    start_time: 0,
    stop_time: 110,
    interarrival_distribution: {
      distribution_type: "exponential",
      scale: 1.2,
      min_value: 0.01,
    },
  },
  nodes: [
    {
      node_id: "node_a",
      name: "Приём заявок",
      open_time: 0,
      close_time: null,
      channels: 2,
      service_distribution: {
        distribution_type: "normal",
        mean: 1.7,
        std: 0.5,
        min_value: 0.05,
      },
      routes: [
        {
          target_node_id: "node_b",
          edge_id: "edge_ab",
          probability: 0.85,
        },
        {
          target_node_id: null,
          edge_id: null,
          probability: 0.15,
        },
      ],
    },
    {
      node_id: "node_b",
      name: "Проверка",
      open_time: 0,
      close_time: null,
      channels: 1,
      service_distribution: {
        distribution_type: "normal",
        mean: 2.6,
        std: 0.7,
        min_value: 0.05,
      },
      routes: [
        {
          target_node_id: null,
          edge_id: null,
          probability: 1,
        },
      ],
    },
  ],
  edges: [
    {
      edge_id: "edge_ab",
      source_node_id: "node_a",
      target_node_id: "node_b",
      travel_distribution: {
        distribution_type: "uniform",
        low: 0.15,
        high: 0.8,
        min_value: 0.01,
      },
    },
  ],
};
