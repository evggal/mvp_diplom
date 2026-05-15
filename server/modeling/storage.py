from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd


required_run_files = ("events.csv", "metrics.csv", "model.json", "summary.json")
default_events_columns = [
    "event_time",
    "event_type",
    "request_id",
    "node_id",
    "from_node_id",
    "to_node_id",
    "queue_length",
    "busy_channels",
    "details",
]
default_metrics_columns = [
    "node_id",
    "node_name",
    "arrivals",
    "started",
    "completed",
    "average_queue_length",
    "max_queue_length",
    "average_waiting_time",
    "average_service_time",
    "utilization",
]


def GetResultsRoot() -> Path:
    root = Path(__file__).resolve().parents[1] / "csv_result"
    root.mkdir(parents=True, exist_ok=True)
    return root


def SanitizeModelName(model_name: str) -> str:
    cleaned = re.sub(r"[^\w-]+", "_", model_name.strip(), flags=re.UNICODE)
    cleaned = cleaned.strip("_")
    return cleaned[:80] if cleaned else "model"


def CreateRunFolder(model_name: str) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    safe_name = SanitizeModelName(model_name)
    folder_name = f"{safe_name}_{timestamp}"
    run_path = GetResultsRoot() / folder_name
    run_path.mkdir(parents=True, exist_ok=True)
    return run_path


def ResolveRunFolder(run_id: str) -> Path:
    root = GetResultsRoot().resolve()
    run_dir = (root / run_id).resolve()

    try:
        run_dir.relative_to(root)
    except ValueError as exc:
        raise FileNotFoundError(f"Run '{run_id}' does not exist") from exc

    if not run_dir.exists() or not run_dir.is_dir():
        raise FileNotFoundError(f"Run '{run_id}' does not exist")

    return run_dir


def EnsureColumns(dataframe: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    if dataframe.columns.empty:
        return pd.DataFrame(columns=columns)

    for column in columns:
        if column not in dataframe.columns:
            dataframe[column] = None

    ordered_columns = columns + [column for column in dataframe.columns if column not in columns]
    return dataframe[ordered_columns]


def ParseCsvBytes(content: bytes, columns: list[str]) -> pd.DataFrame:
    if not content:
        return pd.DataFrame(columns=columns)

    for encoding in ("utf-8", "cp1251"):
        try:
            parsed = pd.read_csv(io.BytesIO(content), encoding=encoding)
            return EnsureColumns(parsed, columns)
        except (pd.errors.EmptyDataError, pd.errors.ParserError, UnicodeDecodeError):
            continue

    return pd.DataFrame(columns=columns)


def ParseJsonBytes(content: bytes) -> dict[str, Any]:
    if not content:
        return {}

    for encoding in ("utf-8", "cp1251"):
        try:
            parsed = json.loads(content.decode(encoding))
            if isinstance(parsed, dict):
                return parsed
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue

    return {}


def ExtractArchiveMember(
    archive: zipfile.ZipFile,
    available_members: dict[str, str],
    file_name: str,
) -> bytes:
    archive_member = available_members.get(file_name)
    if not archive_member:
        return b""

    return archive.read(archive_member)


def NormalizeModelPayload(model_payload: dict[str, Any], summary_payload: dict[str, Any], run_id: str) -> dict[str, Any]:
    raw_name = model_payload.get("model_name")
    if isinstance(raw_name, str) and raw_name.strip():
        model_name = raw_name.strip()
    else:
        summary_name = summary_payload.get("model_name")
        model_name = summary_name.strip() if isinstance(summary_name, str) and summary_name.strip() else run_id

    config_payload = model_payload.get("config") if isinstance(model_payload.get("config"), dict) else {}
    simulation_duration = config_payload.get("simulation_duration")
    if not isinstance(simulation_duration, (int, float)):
        simulation_duration = 0

    random_seed = config_payload.get("random_seed")
    if not isinstance(random_seed, (int, float)):
        random_seed = None
    elif isinstance(random_seed, float):
        random_seed = int(random_seed)

    max_requests = config_payload.get("max_requests")
    if not isinstance(max_requests, (int, float)):
        max_requests = None
    elif isinstance(max_requests, float):
        max_requests = int(max_requests)

    nodes = config_payload.get("nodes")
    if not isinstance(nodes, list):
        nodes = []

    edges = config_payload.get("edges")
    if not isinstance(edges, list):
        edges = []

    generators = config_payload.get("generators")
    if not isinstance(generators, list):
        generators = []

    generator = config_payload.get("generator")
    if generator is not None and not isinstance(generator, dict):
        generator = None

    node_positions_payload = model_payload.get("node_positions")
    node_positions: dict[str, dict[str, float]] = {}
    if isinstance(node_positions_payload, dict):
        for node_id, position in node_positions_payload.items():
            if not isinstance(node_id, str) or not isinstance(position, dict):
                continue
            x = position.get("x")
            y = position.get("y")
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                node_positions[node_id] = {"x": float(x), "y": float(y)}

    normalized_config: dict[str, Any] = {
        "simulation_duration": float(simulation_duration),
        "random_seed": random_seed,
        "max_requests": max_requests,
        "nodes": nodes,
        "edges": edges,
        "generators": generators,
    }
    if generator is not None:
        normalized_config["generator"] = generator

    normalized_model = {
        "model_name": model_name,
        "config": normalized_config,
        "node_positions": node_positions,
    }
    return normalized_model


def NormalizeSummaryPayload(
    summary_payload: dict[str, Any],
    model_payload: dict[str, Any],
    events_df: pd.DataFrame,
    created_at: str,
) -> dict[str, Any]:
    summary = dict(summary_payload)
    model_name = model_payload.get("model_name", "model")
    summary["model_name"] = model_name
    summary.setdefault("created_at", created_at)
    summary.setdefault("events_count", int(len(events_df.index)))

    if "requests_created" not in summary:
        summary["requests_created"] = int((events_df["event_type"] == "request_generated").sum()) if "event_type" in events_df else 0
    if "requests_exited" not in summary:
        summary["requests_exited"] = int((events_df["event_type"] == "request_exited").sum()) if "event_type" in events_df else 0
    if "requests_in_system" not in summary:
        created = summary["requests_created"] if isinstance(summary["requests_created"], (int, float)) else 0
        exited = summary["requests_exited"] if isinstance(summary["requests_exited"], (int, float)) else 0
        summary["requests_in_system"] = max(0, int(created) - int(exited))

    return summary


def SaveImportedRun(
    model_payload: dict[str, Any],
    summary_payload: dict[str, Any],
    events_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
) -> dict[str, Any]:
    raw_model_name = model_payload.get("model_name")
    if isinstance(raw_model_name, str) and raw_model_name.strip():
        folder_model_name = raw_model_name.strip()
    else:
        summary_model_name = summary_payload.get("model_name")
        folder_model_name = (
            summary_model_name.strip()
            if isinstance(summary_model_name, str) and summary_model_name.strip()
            else "model"
        )

    run_path = CreateRunFolder(folder_model_name)
    created_at = datetime.now(UTC).isoformat()

    normalized_model = NormalizeModelPayload(model_payload, summary_payload, run_path.name)
    normalized_summary = NormalizeSummaryPayload(summary_payload, normalized_model, events_df, created_at)
    normalized_events = EnsureColumns(events_df, default_events_columns)
    normalized_metrics = EnsureColumns(metrics_df, default_metrics_columns)

    events_path = run_path / "events.csv"
    metrics_path = run_path / "metrics.csv"
    model_path = run_path / "model.json"
    summary_path = run_path / "summary.json"

    normalized_events.to_csv(events_path, index=False)
    normalized_metrics.to_csv(metrics_path, index=False)
    model_path.write_text(json.dumps(normalized_model, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path.write_text(json.dumps(normalized_summary, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "run_id": run_path.name,
        "model_name": normalized_model["model_name"],
        "summary": normalized_summary,
        "files": {
            "events_csv": str(events_path),
            "metrics_csv": str(metrics_path),
            "model_json": str(model_path),
            "summary_json": str(summary_path),
        },
    }


def ImportRunFromZipArchive(archive_bytes: bytes) -> dict[str, Any]:
    if not archive_bytes:
        raise ValueError("Archive is empty")

    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError("Uploaded file is not a valid zip archive") from exc

    with archive:
        available_members: dict[str, str] = {}
        for member in archive.namelist():
            member_path = Path(member)
            if not member_path.name:
                continue
            member_name = member_path.name.lower()
            if member_name not in available_members:
                available_members[member_name] = member

        events_df = ParseCsvBytes(
            ExtractArchiveMember(archive, available_members, "events.csv"),
            default_events_columns,
        )
        metrics_df = ParseCsvBytes(
            ExtractArchiveMember(archive, available_members, "metrics.csv"),
            default_metrics_columns,
        )
        model_payload = ParseJsonBytes(
            ExtractArchiveMember(archive, available_members, "model.json"),
        )
        summary_payload = ParseJsonBytes(
            ExtractArchiveMember(archive, available_members, "summary.json"),
        )

    return SaveImportedRun(model_payload, summary_payload, events_df, metrics_df)


def BuildRunExportArchive(run_id: str) -> tuple[bytes, str]:
    run_dir = ResolveRunFolder(run_id)
    missing_files = [file_name for file_name in required_run_files if not (run_dir / file_name).exists()]
    if missing_files:
        missing_list = ", ".join(missing_files)
        raise FileNotFoundError(f"Run '{run_id}' is incomplete: missing {missing_list}")

    model_name = run_dir.name
    model_path = run_dir / "model.json"
    try:
        model_payload = json.loads(model_path.read_text(encoding="utf-8"))
        if isinstance(model_payload, dict):
            payload_model_name = model_payload.get("model_name")
            if isinstance(payload_model_name, str) and payload_model_name.strip():
                model_name = payload_model_name.strip()
    except json.JSONDecodeError:
        pass

    archive_name = f"{SanitizeModelName(model_name)}_{run_id}.zip"
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_name in required_run_files:
            archive.write(run_dir / file_name, arcname=file_name)

    return buffer.getvalue(), archive_name


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
    run_dir = ResolveRunFolder(run_id)

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


def DeleteRun(run_id: str) -> None:
    run_dir = ResolveRunFolder(run_id)
    shutil.rmtree(run_dir)
