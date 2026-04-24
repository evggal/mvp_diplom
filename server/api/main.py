from __future__ import annotations

from typing import Any

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from modeling import DeleteRun, ListSavedRuns, LoadRun
from modeling.schemas import SimulationRunRequest

from .auth import (
    AuthenticateUser,
    CreateAccessToken,
    GetCurrentUser,
    LoginRequest,
    TokenResponse,
)
from .tasks import GetTask, StartSimulationTask


class StartTaskResponse(BaseModel):
    task_id: str
    status: str


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    model_name: str
    created_at: str
    updated_at: str
    error: str | None = None
    run_id: str | None = None
    summary: dict[str, Any] | None = None
    files: dict[str, str] | None = None


app = FastAPI(
    title="Discrete Event Simulation API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def Health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login", response_model=TokenResponse)
def Login(login_payload: LoginRequest) -> TokenResponse:
    if not AuthenticateUser(login_payload.username, login_payload.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    return CreateAccessToken(login_payload.username)


@app.post("/simulation/start", response_model=StartTaskResponse)
async def StartSimulation(
    request: SimulationRunRequest,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> StartTaskResponse:
    task_id = await StartSimulationTask(request.model_name, request.config)
    return StartTaskResponse(task_id=task_id, status="queued")


@app.get("/simulation/status/{task_id}", response_model=TaskStatusResponse)
async def GetSimulationStatus(
    task_id: str,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> TaskStatusResponse:
    task_data = await GetTask(task_id)
    if task_data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return TaskStatusResponse(**task_data)


@app.get("/simulation/result/{task_id}")
async def GetSimulationResult(
    task_id: str,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> dict[str, Any]:
    task_data = await GetTask(task_id)
    if task_data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    if task_data["status"] == "failed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Task failed: {task_data.get('error')}",
        )
    if task_data["status"] != "completed" or not task_data.get("run_id"):
        raise HTTPException(
            status_code=status.HTTP_202_ACCEPTED,
            detail="Task is not completed yet",
        )

    return LoadRun(task_data["run_id"])


@app.get("/models")
def GetModels(user: str = Depends(GetCurrentUser)) -> list[dict[str, Any]]:  # noqa: ARG001
    return ListSavedRuns()


@app.get("/models/{run_id}")
def GetModelData(
    run_id: str,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> dict[str, Any]:
    try:
        return LoadRun(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc


@app.delete("/models/{run_id}")
def DeleteModel(
    run_id: str,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> dict[str, str]:
    try:
        DeleteRun(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    return {
        "status": "deleted",
        "run_id": run_id,
    }
