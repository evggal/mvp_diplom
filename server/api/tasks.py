from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from modeling import RunSimulation, SaveRunArtifacts
from modeling.schemas import NodePosition, SimulationConfig


task_registry: dict[str, dict[str, Any]] = {}
task_lock = asyncio.Lock()


def BuildTaskSnapshot(task_id: str) -> dict[str, Any]:
    task_data = task_registry[task_id]
    return {
        "task_id": task_id,
        "status": task_data["status"],
        "model_name": task_data["model_name"],
        "created_at": task_data["created_at"],
        "updated_at": task_data["updated_at"],
        "error": task_data.get("error"),
        "run_id": task_data.get("run_id"),
        "summary": task_data.get("summary"),
        "files": task_data.get("files"),
    }


async def SetTaskStatus(task_id: str, status: str, **updates: Any) -> None:
    async with task_lock:
        task_data = task_registry[task_id]
        task_data["status"] = status
        task_data["updated_at"] = datetime.now(UTC).isoformat()
        task_data.update(updates)


async def ExecuteSimulationTask(
    task_id: str,
    model_name: str,
    config: SimulationConfig,
    node_positions: dict[str, NodePosition],
) -> None:
    await SetTaskStatus(task_id, "running")

    try:
        simulation_output = await asyncio.to_thread(RunSimulation, config)
        created_at = datetime.now(UTC).isoformat()
        summary = {
            **simulation_output["summary"],
            "model_name": model_name,
            "created_at": created_at,
            "task_id": task_id,
        }
        model_payload = {
            "model_name": model_name,
            "config": config.model_dump(mode="json"),
            "node_positions": {
                node_id: position.model_dump(mode="json")
                for node_id, position in node_positions.items()
            },
        }
        storage_result = await asyncio.to_thread(
            SaveRunArtifacts,
            model_name,
            model_payload,
            simulation_output["events"],
            simulation_output["metrics"],
            summary,
        )
        await SetTaskStatus(
            task_id,
            "completed",
            run_id=storage_result["run_id"],
            files=storage_result["files"],
            summary=summary,
        )
    except Exception as exc:  # noqa: BLE001
        await SetTaskStatus(task_id, "failed", error=str(exc))


async def StartSimulationTask(
    model_name: str,
    config: SimulationConfig,
    node_positions: dict[str, NodePosition] | None = None,
) -> str:
    task_id = str(uuid.uuid4())
    now = datetime.now(UTC).isoformat()

    async with task_lock:
        task_registry[task_id] = {
            "status": "queued",
            "model_name": model_name,
            "created_at": now,
            "updated_at": now,
            "error": None,
            "run_id": None,
            "summary": None,
            "files": None,
        }

    asyncio.create_task(
        ExecuteSimulationTask(task_id, model_name, config, node_positions or {}),
    )
    return task_id


async def GetTask(task_id: str) -> dict[str, Any] | None:
    async with task_lock:
        if task_id not in task_registry:
            return None
        return BuildTaskSnapshot(task_id)
