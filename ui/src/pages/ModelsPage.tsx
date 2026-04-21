import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GetSavedRuns } from "../api/client";
import type { SavedRun } from "../types";

export function ModelsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    async function LoadRuns() {
      setLoading(true);
      setError(null);
      try {
        const list = await GetSavedRuns();
        if (!disposed) {
          setRuns(list);
        }
      } catch (request_error) {
        if (!disposed) {
          setError("Не удалось загрузить список моделей");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }
    void LoadRuns();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <section className="page-panel">
      <h2>Сохранённые модели</h2>
      <p>Каждый запуск сохраняется в отдельную папку на сервере вместе с csv/json файлами.</p>

      {loading ? <div>Загрузка списка...</div> : null}
      {error ? <div className="error-box">{error}</div> : null}

      <div className="run-list">
        {runs.map((run) => (
          <article key={run.run_id} className="run-card">
            <h3>{run.model_name}</h3>
            <div>Run ID: {run.run_id}</div>
            <div>Создано: {run.created_at ?? "unknown"}</div>
            <button onClick={() => navigate(`/results/${run.run_id}`)}>Открыть результаты</button>
          </article>
        ))}
      </div>
    </section>
  );
}
