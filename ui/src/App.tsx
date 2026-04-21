import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { useState } from "react";
import { HasToken, RemoveToken } from "./api/client";
import { EditorPage } from "./pages/EditorPage";
import { LoginPage } from "./pages/LoginPage";
import { ModelsPage } from "./pages/ModelsPage";
import { ResultsPage } from "./pages/ResultsPage";

function ApplicationShell() {
  const [last_run_id, setLastRunId] = useState<string | null>(null);

  function HandleLogout() {
    RemoveToken();
    window.location.reload();
  }

  return (
    <BrowserRouter>
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
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(HasToken());

  if (!authenticated) {
    return <LoginPage on_success={() => setAuthenticated(true)} />;
  }

  return <ApplicationShell />;
}
