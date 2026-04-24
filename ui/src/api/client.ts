import axios from "axios";
import type {
  RunData,
  SavedRun,
  SimulationRunRequest,
  StartTaskResponse,
  TaskStatusResponse,
} from "../types";

const api_base_url = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const token_storage_key = "demo4_token";
export const auth_changed_event = "demo4-auth-changed";

export const api_client = axios.create({
  baseURL: api_base_url,
});

function NotifyAuthChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(auth_changed_event));
  }
}

api_client.interceptors.request.use((config) => {
  const token = localStorage.getItem(token_storage_key);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api_client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      RemoveToken();
    }
    return Promise.reject(error);
  },
);

export function SaveToken(token: string): void {
  localStorage.setItem(token_storage_key, token);
  NotifyAuthChanged();
}

export function RemoveToken(): void {
  localStorage.removeItem(token_storage_key);
  NotifyAuthChanged();
}

export function HasToken(): boolean {
  return Boolean(localStorage.getItem(token_storage_key));
}

export async function Login(username: string, password: string): Promise<void> {
  const response = await api_client.post<{ access_token: string }>("/auth/login", {
    username,
    password,
  });
  SaveToken(response.data.access_token);
}

export async function StartSimulation(payload: SimulationRunRequest): Promise<StartTaskResponse> {
  const response = await api_client.post<StartTaskResponse>("/simulation/start", payload);
  return response.data;
}

export async function GetSimulationStatus(task_id: string): Promise<TaskStatusResponse> {
  const response = await api_client.get<TaskStatusResponse>(`/simulation/status/${task_id}`);
  return response.data;
}

export async function GetSimulationResult(task_id: string): Promise<RunData> {
  const response = await api_client.get<RunData>(`/simulation/result/${task_id}`);
  return response.data;
}

export async function GetSavedRuns(): Promise<SavedRun[]> {
  const response = await api_client.get<SavedRun[]>("/models");
  return response.data;
}

export async function GetRunById(run_id: string): Promise<RunData> {
  const response = await api_client.get<RunData>(`/models/${run_id}`);
  return response.data;
}

export async function DeleteRunById(run_id: string): Promise<void> {
  await api_client.delete(`/models/${run_id}`);
}
