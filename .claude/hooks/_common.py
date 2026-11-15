"""Shared helpers for the project's Claude Code hooks. Standard library only."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2])
GRAPH_DIR = PROJECT_DIR / "graphify-out"
GRAPH_JSON = GRAPH_DIR / "graph.json"
GRAPH_REPORT = GRAPH_DIR / "GRAPH_REPORT.md"

CODE_EXT = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql", ".py", ".dart"}
SKIP_DIRS = {"node_modules", ".git", "graphify-out", ".next", ".turbo", "dist", "build",
             ".open-next", ".wrangler", "coverage", "bundles", "fixtures"}


def read_input() -> dict:
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {}


def edited_paths(payload: dict) -> list[Path]:
    """File paths touched by Edit / Write / MultiEdit, resolved inside the project."""
    tool_input = payload.get("tool_input") or {}
    paths = []
    for key in ("file_path", "path"):
        if tool_input.get(key):
            paths.append(tool_input[key])
    out = []
    for p in paths:
        path = Path(p)
        if not path.is_absolute():
            path = PROJECT_DIR / path
        out.append(path.resolve())
    return out


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_DIR.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def graphify_bin() -> str | None:
    return shutil.which("graphify")


def code_files_newer_than(ts: float, limit: int = 50) -> list[str]:
    newer = []
    for root, dirs, files in os.walk(PROJECT_DIR):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            p = Path(root) / name
            if p.suffix in CODE_EXT:
                try:
                    if p.stat().st_mtime > ts:
                        newer.append(rel(p))
                        if len(newer) >= limit:
                            return newer
                except OSError:
                    pass
    return newer


def run(cmd: list[str], timeout: int) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=PROJECT_DIR, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except OSError as e:
        return 127, str(e)


def is_git_tracked(path: Path) -> bool:
    code, _ = run(["git", "ls-files", "--error-unmatch", rel(path)], timeout=10)
    return code == 0
