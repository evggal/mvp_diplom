from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import Body, Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from modeling import BuildRunExportArchive, DeleteRun, ImportRunFromZipArchive, ListSavedRuns, LoadRun
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
    task_id = await StartSimulationTask(
        request.model_name,
        request.config,
        request.node_positions,
    )
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


@app.get("/models/{run_id}/export")
def ExportModelArchive(
    run_id: str,
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> Response:
    try:
        archive_content, archive_name = BuildRunExportArchive(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    fallback_name = f"{run_id}.zip"
    content_disposition = (
        f'attachment; filename="{fallback_name}"; filename*=UTF-8\'\'{quote(archive_name)}'
    )
    return Response(
        content=archive_content,
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


@app.post("/models/import")
def ImportModelArchive(
    archive_bytes: bytes = Body(..., media_type="application/zip"),
    user: str = Depends(GetCurrentUser),  # noqa: ARG001
) -> dict[str, Any]:
    try:
        imported_run = ImportRunFromZipArchive(archive_bytes)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    return {
        "status": "imported",
        **imported_run,
    }
