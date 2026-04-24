import { FormEvent, useState } from "react";
import { AxiosError } from "axios";
import { Login } from "../api/client";
import { DismissibleError } from "../components/DismissibleError";

interface LoginPageProps {
  on_success: () => void;
}

export function LoginPage({ on_success }: LoginPageProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function HandleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await Login(username, password);
      on_success();
    } catch (err) {
      const response_error = err as AxiosError<{ detail?: string }>;
      setError(response_error.response?.data?.detail ?? "Ошибка авторизации");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <h1>Discrete Event Modeling</h1>
        <p>Вход в систему моделирования (демо-пользователь по умолчанию: admin / admin)</p>
        <form onSubmit={HandleSubmit} className="column-form">
          <label>
            Логин
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? "Выполняется вход..." : "Войти"}
          </button>
        </form>
        <DismissibleError message={error} on_dismiss={() => setError(null)} />
      </div>
    </div>
  );
}
