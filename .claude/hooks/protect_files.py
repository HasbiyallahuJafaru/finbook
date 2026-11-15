#!/usr/bin/env python3
"""PreToolUse (Edit|Write|MultiEdit): block edits that would break auditability or leak secrets.

Exit 2 blocks the tool call; stderr is shown to Claude so it can change course.
"""
import fnmatch
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import edited_paths, is_git_tracked, read_input, rel  # noqa: E402

# (glob, reason)
BLOCKED = [
    (".env", "Secrets live in environment variables. Edit .env.example instead, with placeholder values."),
    ("*/.env", "Secrets live in environment variables. Edit .env.example instead, with placeholder values."),
    (".env.*", None),            # handled below so .env.example stays editable
    ("*/.env.*", None),
    ("docs/spec/*.md", "docs/spec is exported from the Claude Doc (source of truth). Ask the user to change the doc and re-export."),
    ("graphify-out/*", "graphify-out is generated. Run `graphify update .` or `/graphify . --update` instead."),
    ("fixtures/private/*", "Real client data must never be written into the repo."),
    ("bundles/*", "Backup bundles must never be written into the repo."),
    ("*.xlsx", "Do not create or edit spreadsheets in the repo. Client workbooks stay outside it."),
]

MIGRATIONS_GLOBS = ["packages/db/migrations/*", "packages/db/drizzle/*", "packages/db/prisma/migrations/*"]


def check(path_rel: str, path) -> str | None:
    for pattern, reason in BLOCKED:
        if fnmatch.fnmatch(path_rel, pattern):
            if reason is None:
                if path_rel.endswith(".env.example"):
                    continue
                return "Secrets live in environment variables. Only .env.example (placeholders) may be edited."
            return reason
    for pattern in MIGRATIONS_GLOBS:
        if fnmatch.fnmatch(path_rel, pattern) and path.exists() and is_git_tracked(path):
            return ("This migration is already committed. Migrations are forward-only: create a new one with "
                    "`pnpm db:new <name>` (see the db-migration skill). Never edit an applied migration.")
    return None


def main() -> int:
    payload = read_input()
    for path in edited_paths(payload):
        reason = check(rel(path), path)
        if reason:
            print(f"BLOCKED edit to {rel(path)}: {reason}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
