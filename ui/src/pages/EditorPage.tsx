import { useEffect, useMemo, useState } from "react";
import { AxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { GetSimulationStatus, StartSimulation } from "../api/client";
import { default_simulation_config } from "../model/defaultModel";
import type { SimulationConfig, TaskStatusResponse } from "../types";

interface EditorPageProps {
  on_run_ready: (run_id: string) => void;
}

export function EditorPage({ on_run_ready }: EditorPageProps) {
  const navigate = useNavigate();
  const [model_name, setModelName] = useState("demo_model");
  const [config_text, setConfigText] = useState(
    JSON.stringify(default_simulation_config, null, 2),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task_status, setTaskStatus] = useState<TaskStatusResponse | null>(null);

  const has_active_task = useMemo(() => {
    if (!task_status) {
      return false;
    }
    return task_status.status === "queued" || task_status.status === "running";
  }, [task_status]);

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
        setError(request_error.response?.data?.detail ?? "Не удалось обновить статус задачи");
      }
    }, 1500);

    return () => {
      disposed = true;
      clearInterval(timer_id);
    };
  }, [has_active_task, on_run_ready, task_status?.task_id]);

  async function HandleStartModeling() {
    setLoading(true);
    setError(null);
    try {
      const parsed_config = JSON.parse(config_text) as SimulationConfig;
      const start_data = await StartSimulation({
        model_name,
        config: parsed_config,
      });
      setTaskStatus({
        task_id: start_data.task_id,
        status: "queued",
        model_name,
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
        setError("Не удалось запустить моделирование. Проверьте JSON модели.");
      }
    } finally {
      setLoading(false);
    }
  }

  function HandleRestoreDefault() {
    setConfigText(JSON.stringify(default_simulation_config, null, 2));
  }

  return (
    <section className="page-panel">
      <h2>Редактор модели</h2>
      <p>
        Вставьте или отредактируйте JSON модели. Кнопка "Моделирование" запускает задачу на
        сервере асинхронно.
      </p>

      <div className="form-grid">
        <label>
          Название модели
          <input value={model_name} onChange={(event) => setModelName(event.target.value)} />
        </label>
      </div>

      <label className="text-area-label">
        JSON модели
        <textarea
          value={config_text}
          onChange={(event) => setConfigText(event.target.value)}
          rows={24}
        />
      </label>

      <div className="action-row">
        <button onClick={HandleStartModeling} disabled={loading || has_active_task}>
          {loading ? "Запуск..." : "Моделирование"}
        </button>
        <button onClick={HandleRestoreDefault} type="button" className="secondary">
          Загрузить пример
        </button>
      </div>

      {task_status ? (
        <div className="status-box">
          <div>
            Задача: <strong>{task_status.task_id}</strong>
          </div>
          <div>
            Статус: <strong>{task_status.status}</strong>
          </div>
          {task_status.error ? <div className="error-box">{task_status.error}</div> : null}
          {task_status.run_id ? (
            <button onClick={() => navigate(`/results/${task_status.run_id}`)}>
              Результаты моделирования
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error-box">{error}</div> : null}
    </section>
  );
}
