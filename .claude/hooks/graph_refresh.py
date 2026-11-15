#!/usr/bin/env python3
"""Stop: keep the graphify code graph in step with what was just edited.

`graphify update .` re-extracts code locally (tree-sitter, cached, no LLM). Never blocks: always exits 0.
"""
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import GRAPH_JSON, code_files_newer_than, graphify_bin, read_input, run  # noqa: E402


def main() -> None:
    payload = read_input()
    if payload.get("stop_hook_active"):
        return
    gbin = graphify_bin()
    if not gbin or not GRAPH_JSON.exists():
        return
    if not code_files_newer_than(GRAPH_JSON.stat().st_mtime, limit=1):
        return
    run([gbin, "update", "."], timeout=150)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
