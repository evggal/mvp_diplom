from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd


def GetResultsRoot() -> Path:
    root = Path(__file__).resolve().parents[1] / "csv_result"
    root.mkdir(parents=True, exist_ok=True)
    return root


def SanitizeModelName(model_name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9а-яА-Я_-]+", "_", model_name.strip())
    return cleaned[:80] if cleaned else "model"


def CreateRunFolder(model_name: str) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    safe_name = SanitizeModelName(model_name)
    folder_name = f"{safe_name}_{timestamp}"
    run_path = GetResultsRoot() / folder_name
    run_path.mkdir(parents=True, exist_ok=True)
    return run_path


def SaveRunArtifacts(
    model_name: str,
    model_payload: dict[str, Any],
    events_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
    summary: dict[str, Any],
) -> dict[str, Any]:
    run_path = CreateRunFolder(model_name)

    events_path = run_path / "events.csv"
    metrics_path = run_path / "metrics.csv"
    model_path = run_path / "model.json"
    summary_path = run_path / "summary.json"

    events_df.to_csv(events_path, index=False)
    metrics_df.to_csv(metrics_path, index=False)
    model_path.write_text(json.dumps(model_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "run_id": run_path.name,
        "model_name": model_name,
        "run_path": str(run_path),
        "files": {
            "events_csv": str(events_path),
            "metrics_csv": str(metrics_path),
            "model_json": str(model_path),
            "summary_json": str(summary_path),
        },
    }


def ListSavedRuns() -> list[dict[str, Any]]:
    root = GetResultsRoot()
    runs: list[dict[str, Any]] = []

    for run_dir in sorted(root.glob("*"), key=lambda path: path.stat().st_mtime, reverse=True):
        if not run_dir.is_dir():
            continue
        summary_path = run_dir / "summary.json"
        model_path = run_dir / "model.json"
        if not summary_path.exists() or not model_path.exists():
            continue

        try:
            summary_data = json.loads(summary_path.read_text(encoding="utf-8"))
            model_data = json.loads(model_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        runs.append(
            {
                "run_id": run_dir.name,
                "model_name": model_data.get("model_name", run_dir.name),
                "created_at": summary_data.get("created_at"),
                "summary": summary_data,
            }
        )

    return runs


def LoadRun(run_id: str) -> dict[str, Any]:
    run_dir = GetResultsRoot() / run_id
    if not run_dir.exists() or not run_dir.is_dir():
        raise FileNotFoundError(f"Run '{run_id}' does not exist")

    events_path = run_dir / "events.csv"
    metrics_path = run_dir / "metrics.csv"
    model_path = run_dir / "model.json"
    summary_path = run_dir / "summary.json"

    if not events_path.exists() or not metrics_path.exists() or not model_path.exists() or not summary_path.exists():
        raise FileNotFoundError(f"Run '{run_id}' is incomplete")

    events_df = pd.read_csv(events_path)
    metrics_df = pd.read_csv(metrics_path)
    model_data = json.loads(model_path.read_text(encoding="utf-8"))
    summary_data = json.loads(summary_path.read_text(encoding="utf-8"))

    return {
        "run_id": run_id,
        "model": model_data,
        "summary": summary_data,
        "events": events_df.to_dict(orient="records"),
        "metrics": metrics_df.to_dict(orient="records"),
    }
