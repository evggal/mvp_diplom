# AGENTS.md

## Purpose
This repository contains a full-stack discrete-event simulation product for service-flow modeling (airport-oriented scenario in the default template).

The system has two main parts:
- `server/`: FastAPI API + simulation engine + run artifact storage.
- `ui/`: React + TypeScript editor and analytics UI.

This document is for engineers and coding agents who need to make safe, consistent changes.

## Project Layout
- `server/api/`
- `server/modeling/`
- `server/csv_result/`
- `ui/src/pages/`
- `ui/src/api/client.ts`
- `ui/src/types.ts`
- `ui/src/model/defaultModel.ts`
- `instruction.md`, `glava2.md` (domain documentation)

Notes:
- `server/csv_result/` stores simulation runs (generated artifacts).
- Root `package-lock.json` is a minimal placeholder; frontend lockfile is `ui/package-lock.json`.

## Tech Stack
Backend:
- Python 3.11+
- FastAPI
- Pydantic v2
- NumPy
- Pandas
- PyJWT
- Uvicorn
- Dependency management via `uv`

Frontend:
- React 18
- TypeScript
- Vite
- Axios
- Chart.js + react-chartjs-2
- React Router

## Local Setup And Run
### 1. Backend
```bash
cd server
uv sync
uv run uvicorn api.main:app --reload --port 8000
```

Default auth credentials:
- username: `admin`
- password: `admin`

Optional backend env vars:
- `JWT_SECRET`
- `TOKEN_LIFETIME_MINUTES`
- `DEMO_USERNAME`
- `DEMO_PASSWORD`

### 2. Frontend
```bash
cd ui
npm install
```

Create `.env` from `.env.example`:
```bash
VITE_API_BASE_URL=http://localhost:8000
```

Run UI:
```bash
npm run dev
```

Build UI (includes TypeScript checks):
```bash
npm run build
```

Preview production build:
```bash
npm run preview
```

## Runtime Flow
1. User logs in via `POST /auth/login`.
2. Frontend stores JWT in localStorage (`demo4_token`).
3. Editor sends model payload to `POST /simulation/start`.
4. Backend starts async task and returns `task_id`.
5. Frontend polls `GET /simulation/status/{task_id}` every ~1.2s.
6. On completion, frontend navigates to `/results/{run_id}`.
7. Run artifacts are persisted under `server/csv_result/<run_id>/`.

## API Surface (Current)
Public:
- `GET /health`
- `POST /auth/login`

Protected (Bearer token required):
- `POST /simulation/start`
- `GET /simulation/status/{task_id}`
- `GET /simulation/result/{task_id}`
- `GET /models`
- `GET /models/{run_id}`
- `DELETE /models/{run_id}`
- `GET /models/{run_id}/export`
- `POST /models/import`

## Core Backend Modules
### `server/modeling/schemas.py`
Defines simulation contract and strict validation:
- node/edge IDs must be unique
- at least one `generator` node and one `exit` node
- generator settings must exist for every generator node
- route probabilities for each non-exit node must sum to exactly `1.0`
- each route->edge mapping must be directionally valid
- service nodes must define allowed service distributions

### `server/modeling/simulator.py`
Discrete-event engine based on event calendar (`heapq`).

Supported event types:
- `request_generated`
- `request_arrived`
- `service_started`
- `service_completed`
- `request_exited`
- `node_recheck`

Produces:
- events dataframe
- metrics dataframe
- summary dict

### `server/modeling/distributions.py`
Distribution sampling logic. Keep this aligned with frontend and schema definitions.

### `server/modeling/storage.py`
Run storage and import/export.

Run artifact contract (required files):
- `events.csv`
- `metrics.csv`
- `model.json`
- `summary.json`

Import supports fallback decoding for UTF-8 and CP1251 for CSV/JSON bytes.

### `server/api/tasks.py`
Async task orchestration and in-memory registry.

Important limitation:
- task state is process-local memory (not durable). Restarting backend loses queued/running/completed task metadata.

## Core Frontend Modules
### `ui/src/pages/EditorPage.tsx`
Main model editor.

Key behaviors:
- normalizes graph/layout before run (`NormalizeConfigAndLayout`)
- validates route probability sums client-side before start
- loads model base from query param `?from_run=<run_id>`
- polls backend task status
- provides node/route/distribution/schedule editors

### `ui/src/pages/ResultsPage.tsx`
Simulation playback + charts + metrics UI.

### `ui/src/pages/ModelsPage.tsx`
Saved runs list, delete, export ZIP, import ZIP, and "use as base" navigation.

### `ui/src/types.ts`
Frontend data contract mirror of backend schema.

### `ui/src/api/client.ts`
Axios API client, token handling, auth change events.

## Invariants You Must Preserve
- Route probabilities are stored as fractions (`0..1`), not percent.
- Non-exit node route probability sum must remain exactly `1.0`.
- Frontend/backend schema parity is mandatory (`ui/src/types.ts` <-> `server/modeling/schemas.py`).
- Distribution support must stay synchronized across:
  - backend schema allowed sets
  - backend sampler
  - frontend type union
  - frontend distribution editors/defaults
- Run artifact file names and column semantics must remain stable, or import/export/results must be updated together.

## Style And Naming Conventions In This Repo
This codebase intentionally uses non-standard naming conventions in many places.

Keep existing style when editing nearby code:
- Python function names are typically `PascalCase`.
- TypeScript helper functions are also commonly `PascalCase`.
- Variables are usually `snake_case` or descriptive lower-case forms depending on file.

Do not perform large naming refactors unless explicitly requested.

## Safe Change Playbooks
### If you add or change model fields
Update all of:
- `server/modeling/schemas.py`
- `ui/src/types.ts`
- editor normalization/defaulting in `EditorPage.tsx`
- default template in `ui/src/model/defaultModel.ts` (if needed)
- results rendering if field is shown there

### If you add a new distribution type
Update all of:
- `DistributionType` in backend and frontend
- allowed distribution sets in backend validation
- backend sampler in `distributions.py`
- frontend distribution labels and editors
- any default distribution creation logic

### If you change metrics or summary fields
Update all of:
- `RunSimulation` output payload
- CSV save/load compatibility in `storage.py`
- metric label/formatting in `ResultsPage.tsx`
- any models list/summary cards using those fields

### If you change routes/edges behavior
Re-verify:
- `RebuildEdgesFromRoutes` behavior in editor
- backend route-edge direction validation
- UI edge configuration controls

## Manual Smoke Test Checklist
There is currently no automated test suite in the repository. Run this manual check before finishing significant changes:

1. Start backend and frontend locally.
2. Login with demo credentials.
3. Open editor and run simulation on default template.
4. Verify task transitions `queued -> running -> completed`.
5. Open results page for run; verify charts and playback render.
6. Check models list shows new run.
7. Export run as ZIP.
8. Import the same ZIP and confirm imported run appears.
9. Use "take as base" flow and verify editor loads that model.

## Known Pitfalls
- `server/csv_result/` contains generated data; do not commit generated runs.
- Task registry is in-memory only; not suitable for multi-worker or durable queue behavior.
- UI text is largely Russian-language; keep wording consistent unless localization change is requested.
- Some docs mention `frontend/`, while actual folder is `ui/`.
- API supports `node_positions`, but current editor run-start request sends only `model_name` + `config` (no layout persistence during run save).

## Security And Production Notes
Current auth model is demo-friendly, not production-grade:
- single demo user from env vars
- permissive CORS (`*`)
- no persistent user store

Treat this as a research/prototype system unless hardening work is explicitly done.

## Where To Look First
- Domain and implementation details: `instruction.md`
- Backend entrypoint: `server/api/main.py`
- Core simulation: `server/modeling/simulator.py`
- Editor UX and graph normalization: `ui/src/pages/EditorPage.tsx`
- Results analytics: `ui/src/pages/ResultsPage.tsx`

## Definition Of Done For Typical Changes
A change is done when:
- backend and frontend contracts remain aligned
- manual smoke flow passes end-to-end
- no generated artifacts or secrets are accidentally committed
- user-visible behavior is documented if changed
