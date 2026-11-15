#!/usr/bin/env python3
"""SessionStart: report graphify status and refresh a stale code graph.

Whatever this prints to stdout is added to Claude's context at session start.
Never blocks the session: always exits 0.
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import (GRAPH_JSON, GRAPH_REPORT, code_files_newer_than, graphify_bin,  # noqa: E402
                     read_input, run)


def main() -> None:
    read_input()
    lines = ["[project] Spec: docs/spec/build-spec.md. Rules: CLAUDE.md (money is bigint minor units; balances only from journal_lines; every query tenant-scoped)."]

    gbin = graphify_bin()
    if not gbin:
        lines.append("[graphify] NOT INSTALLED. Ask the user to run scripts/setup-claude.sh "
                     "(uv tool install graphifyy && graphify install). Until then, say so before using Grep/Glob for structure.")
        print("\n".join(lines))
        return

    if not GRAPH_REPORT.exists() or not GRAPH_JSON.exists():
        lines.append("[graphify] No knowledge graph yet. FIRST ACTION THIS SESSION: run `/graphify .` "
                     "then skim graphify-out/GRAPH_REPORT.md once for the overall structure.")
        print("\n".join(lines))
        return

    built = GRAPH_JSON.stat().st_mtime
    age_h = (time.time() - built) / 3600
    stale = code_files_newer_than(built)
    if stale:
        code, out = run([gbin, "update", "."], timeout=100)
        if code == 0:
            lines.append(f"[graphify] Graph refreshed for {len(stale)} changed code file(s).")
        else:
            lines.append(f"[graphify] Graph is stale ({len(stale)} code file(s) changed) and `graphify update .` failed: "
                         f"{out[-300:]}. Run `/graphify . --update`.")
    else:
        lines.append(f"[graphify] Graph is current (built {age_h:.1f}h ago).")

    lines.append("[graphify] Run `graphify query \"...\"` (or `graphify path` / `graphify explain`) before any Grep, Glob "
                 "or source read. GRAPH_REPORT.md is for broad architecture reviews only. Docs changed? run `/graphify . --update`.")
    print("\n".join(lines))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break a session over a status hook
        print(f"[graphify] status check failed: {e}")
    sys.exit(0)
