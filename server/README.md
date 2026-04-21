# Backend

## Запуск через uv

```bash
uv sync
uv run uvicorn api.main:app --reload --port 8000
```

Демо-учётные данные:
- `username`: `admin`
- `password`: `admin`

JWT параметры можно переопределить переменными окружения:
- `JWT_SECRET`
- `TOKEN_LIFETIME_MINUTES`
- `DEMO_USERNAME`
- `DEMO_PASSWORD`
