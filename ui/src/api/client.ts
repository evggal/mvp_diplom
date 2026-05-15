import axios from "axios";
import type {
  ImportRunResponse,
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

function DecodeFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ParseDispositionFileName(disposition_header: string | undefined, fallback: string): string {
  if (!disposition_header) {
    return fallback;
  }

  const utf_match = disposition_header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf_match?.[1]) {
    const decoded = DecodeFileName(utf_match[1].trim());
    if (decoded) {
      return decoded;
    }
  }

  const file_match = disposition_header.match(/filename="?([^\";]+)"?/i);
  if (file_match?.[1]) {
    const normalized = file_match[1].trim();
    if (normalized) {
      return normalized;
    }
  }

  return fallback;
}

export async function ExportRunZip(run_id: string): Promise<{ blob: Blob; file_name: string }> {
  const response = await api_client.get<Blob>(`/models/${run_id}/export`, {
    responseType: "blob",
  });
  const file_name = ParseDispositionFileName(response.headers["content-disposition"], `${run_id}.zip`);
  return {
    blob: response.data,
    file_name,
  };
}

export async function ImportRunZip(file: File): Promise<ImportRunResponse> {
  const response = await api_client.post<ImportRunResponse>("/models/import", file, {
    headers: {
      "Content-Type": file.type || "application/zip",
    },
  });
  return response.data;
}
