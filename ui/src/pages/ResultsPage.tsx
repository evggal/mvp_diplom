import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  BarElement,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import { GetRunById } from "../api/client";
import type { RunData } from "../types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
);

export function ResultsPage() {
  const { run_id } = useParams<{ run_id: string }>();
  const [run_data, setRunData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof run_id !== "string") {
      setError("Не передан run_id");
      setLoading(false);
      return;
    }
    const current_run_id: string = run_id;

    let disposed = false;
    async function LoadRunData() {
      setLoading(true);
      setError(null);
      try {
        const data = await GetRunById(current_run_id);
        if (!disposed) {
          setRunData(data);
        }
      } catch (request_error) {
        if (!disposed) {
          setError("Не удалось загрузить результаты моделирования");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }
    void LoadRunData();

    return () => {
      disposed = true;
    };
  }, [run_id]);

  const utilization_chart_data = useMemo(() => {
    if (!run_data) {
      return null;
    }
    const labels = run_data.metrics.map((item) => String(item.node_name ?? item.node_id));
    const values = run_data.metrics.map((item) => Number(item.utilization ?? 0));
    return {
      labels,
      datasets: [
        {
          label: "Загруженность каналов",
          data: values,
          backgroundColor: "#ee9b00",
        },
      ],
    };
  }, [run_data]);

  const queue_chart_data = useMemo(() => {
    if (!run_data) {
      return null;
    }
    const points = run_data.events
      .filter((item) => item.node_id !== null && item.event_time !== null)
      .slice(0, 600);

    return {
      labels: points.map((item) => Number(item.event_time).toFixed(2)),
      datasets: [
        {
          label: "Размер очереди",
          data: points.map((item) => Number(item.queue_length ?? 0)),
          borderColor: "#0a9396",
          backgroundColor: "rgba(10, 147, 150, 0.2)",
        },
      ],
    };
  }, [run_data]);

  if (loading) {
    return (
      <section className="page-panel">
        <h2>Результаты моделирования</h2>
        <div>Загрузка...</div>
      </section>
    );
  }

  if (error || !run_data) {
    return (
      <section className="page-panel">
        <h2>Результаты моделирования</h2>
        <div className="error-box">{error ?? "Нет данных"}</div>
      </section>
    );
  }

  return (
    <section className="page-panel">
      <h2>Результаты: {run_data.model.model_name}</h2>
      <div className="summary-grid">
        {Object.entries(run_data.summary).map(([key, value]) => (
          <div key={key} className="summary-item">
            <strong>{key}</strong>
            <span>{String(value)}</span>
          </div>
        ))}
      </div>

      {utilization_chart_data ? (
        <div className="chart-card">
          <h3>Загруженность узлов</h3>
          <Bar data={utilization_chart_data} />
        </div>
      ) : null}

      {queue_chart_data ? (
        <div className="chart-card">
          <h3>Динамика очереди (пошаговые события)</h3>
          <Line data={queue_chart_data} />
        </div>
      ) : null}

      <h3>Метрики по узлам</h3>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              {Object.keys(run_data.metrics[0] ?? {}).map((column_name) => (
                <th key={column_name}>{column_name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run_data.metrics.map((row, index) => (
              <tr key={`${row.node_id ?? "node"}_${index}`}>
                {Object.values(row).map((value, value_index) => (
                  <td key={value_index}>{String(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Пошаговое моделирование (журнал событий)</h3>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              {Object.keys(run_data.events[0] ?? {}).map((column_name) => (
                <th key={column_name}>{column_name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run_data.events.slice(0, 300).map((row, index) => (
              <tr key={index}>
                {Object.values(row).map((value, value_index) => (
                  <td key={value_index}>{String(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
