import { useEffect, useState } from "react";
import { AxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { DeleteRunById, GetSavedRuns } from "../api/client";
import { DismissibleError } from "../components/DismissibleError";
import type { SavedRun } from "../types";

const text_date_unknown = "\u0414\u0430\u0442\u0430 \u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430";
const text_load_error = "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a \u043c\u043e\u0434\u0435\u043b\u0435\u0439";
const text_delete_error = "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043c\u043e\u0434\u0435\u043b\u044c";
const text_title = "\u0421\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0435 \u043c\u043e\u0434\u0435\u043b\u0438";
const text_description =
  "\u041a\u0430\u0436\u0434\u044b\u0439 \u0437\u0430\u043f\u0443\u0441\u043a \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0435\u0442\u0441\u044f \u0432 \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u0443\u044e \u043f\u0430\u043f\u043a\u0443 \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435 \u0432\u043c\u0435\u0441\u0442\u0435 \u0441 \u0444\u0430\u0439\u043b\u0430\u043c\u0438 \u043c\u043e\u0434\u0435\u043b\u0438 \u0438 \u043c\u0435\u0442\u0440\u0438\u043a.";
const text_loading = "\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0441\u043f\u0438\u0441\u043a\u0430...";
const text_requests_in_system = "\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u0437\u0430\u044f\u0432\u043e\u043a \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0435";
const text_events_in_system = "\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u0441\u043e\u0431\u044b\u0442\u0438\u0439 \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0435";
const text_view = "\u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c";
const text_take_as_base = "\u0412\u0437\u044f\u0442\u044c \u0437\u0430 \u043e\u0441\u043d\u043e\u0432\u0443";
const text_delete = "\u0423\u0434\u0430\u043b\u0438\u0442\u044c";
const text_deleting = "\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435...";
const text_dash = "\u2014";

function ParseSummaryCount(summary: Record<string, unknown>, key: string): number | null {
  const value = summary[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
}

function FormatRunDateTime(value: string | undefined): string {
  if (!value) {
    return text_date_unknown;
  }

  const parsed_date = new Date(value);
  if (Number.isNaN(parsed_date.getTime())) {
    return text_date_unknown;
  }

  const day = String(parsed_date.getDate()).padStart(2, "0");
  const month = String(parsed_date.getMonth() + 1).padStart(2, "0");
  const year = String(parsed_date.getFullYear()).slice(-2);
  const hours = String(parsed_date.getHours()).padStart(2, "0");
  const minutes = String(parsed_date.getMinutes()).padStart(2, "0");

  return `${day}.${month}.${year} ${hours}.${minutes}`;
}

export function ModelsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting_run_id, setDeletingRunId] = useState<string | null>(null);
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
      } catch {
        if (!disposed) {
          setError(text_load_error);
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

  async function HandleDeleteRun(run: SavedRun) {
    const should_delete = window.confirm(
      `\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043c\u043e\u0434\u0435\u043b\u044c \"${run.model_name}\"?`,
    );
    if (!should_delete) {
      return;
    }

    setDeletingRunId(run.run_id);
    setError(null);

    try {
      await DeleteRunById(run.run_id);
      setRuns((current) => current.filter((item) => item.run_id !== run.run_id));
    } catch (request_error) {
      const error_response = request_error as AxiosError<{ detail?: string }>;
      setError(error_response.response?.data?.detail ?? text_delete_error);
    } finally {
      setDeletingRunId(null);
    }
  }

  return (
    <section className="page-panel">
      <h2>{text_title}</h2>
      <p>{text_description}</p>

      {loading ? <div>{text_loading}</div> : null}
      <DismissibleError message={error} on_dismiss={() => setError(null)} />

      <div className="run-list">
        {runs.map((run) => {
          const requests_in_system = ParseSummaryCount(run.summary, "requests_in_system");
          const events_count = ParseSummaryCount(run.summary, "events_count");
          return (
            <article key={run.run_id} className="run-card">
              <div className="run-card-main">
                <h3>{run.model_name}</h3>
                <div className="run-card-datetime">{FormatRunDateTime(run.created_at)}</div>
                <div className="run-card-metric">
                  {text_requests_in_system}: {requests_in_system ?? text_dash}
                </div>
                <div className="run-card-metric">
                  {text_events_in_system}: {events_count ?? text_dash}
                </div>
              </div>

              <div className="run-card-actions">
                <button type="button" onClick={() => navigate(`/results/${run.run_id}`)}>
                  {text_view}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => navigate(`/?from_run=${encodeURIComponent(run.run_id)}`)}
                >
                  {text_take_as_base}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void HandleDeleteRun(run)}
                  disabled={deleting_run_id === run.run_id}
                >
                  {deleting_run_id === run.run_id ? text_deleting : text_delete}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
