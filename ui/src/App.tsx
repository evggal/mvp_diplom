import { useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { HasToken, RemoveToken, auth_changed_event } from "./api/client";
import { EditorPage } from "./pages/EditorPage";
import { LoginPage } from "./pages/LoginPage";
import { ModelsPage } from "./pages/ModelsPage";
import { ResultsPage } from "./pages/ResultsPage";

interface LoginRouteProps {
  on_success: () => void;
}

function LoginRoute({ on_success }: LoginRouteProps) {
  const location = useLocation();
  if (HasToken()) {
    const navigation_state = location.state as { from?: string } | null;
    const target_path = navigation_state?.from ?? "/";
    return <Navigate to={target_path} replace />;
  }
  return <LoginPage on_success={on_success} />;
}

function ProtectedShell() {
  const [last_run_id, setLastRunId] = useState<string | null>(null);
  const location = useLocation();

  if (!HasToken()) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  function HandleLogout() {
    RemoveToken();
  }

  return (
    <div className="layout">
      <header className="topbar">
        <h1>Система дискретно-событийного моделирования</h1>
        <nav>
          <Link to="/">Редактор</Link>
          <Link to="/models">Список моделей</Link>
          {last_run_id ? <Link to={`/results/${last_run_id}`}>Последний результат</Link> : null}
          <button onClick={HandleLogout} className="secondary small">
            Выйти
          </button>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<EditorPage on_run_ready={(run_id) => setLastRunId(run_id)} />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/results/:run_id" element={<ResultsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [, setAuthRevision] = useState(0);

  useEffect(() => {
    function HandleAuthChanged() {
      setAuthRevision((current) => current + 1);
    }

    window.addEventListener(auth_changed_event, HandleAuthChanged);
    window.addEventListener("storage", HandleAuthChanged);
    return () => {
      window.removeEventListener(auth_changed_event, HandleAuthChanged);
      window.removeEventListener("storage", HandleAuthChanged);
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={<LoginRoute on_success={() => setAuthRevision((current) => current + 1)} />}
        />
        <Route path="/*" element={<ProtectedShell />} />
      </Routes>
    </BrowserRouter>
  );
}
