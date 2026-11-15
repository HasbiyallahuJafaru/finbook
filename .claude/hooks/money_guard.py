#!/usr/bin/env python3
"""PostToolUse (Edit|Write|MultiEdit): catch float money and hardcoded FX rates.

The edit has already happened; exit 2 sends the findings back to Claude to fix.
Escape hatch for a genuine non-money use on one line:  // money-guard: ok <reason>
"""
import re
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import edited_paths, read_input, rel  # noqa: E402

SCOPES = ("packages/money/", "packages/ledger/", "packages/reports/", "packages/contracts/",
          "packages/db/", "apps/api/src/", "apps/worker/src/", "apps/web/")
EXTS = (".ts", ".tsx", ".sql")

MONEY_WORDS = re.compile(r"amount|price|cost|kobo|naira|ngn|rmb|cny|usd|total|balance|debit|credit|margin|"
                         r"profit|fee|levy|duty|charge|commission|deposit|payment|receipt|invoice|rate",
                         re.IGNORECASE)
FLOAT_OPS = re.compile(r"parseFloat\(|\.toFixed\(|Math\.(round|floor|ceil)\(|\bNumber\(|\*\s*100\b|/\s*100\b")
NUMBER_TYPE = re.compile(r"\b\w*(amount|price|cost|total|balance|kobo|fee|margin|profit|debit|credit)\w*\s*\??:\s*number\b",
                         re.IGNORECASE)
HARDCODED_RATE = re.compile(r"\b\w*rate\w*\s*[:=]\s*['\"]?\d{2,5}(\.\d+)?['\"]?", re.IGNORECASE)
SQL_FLOAT = re.compile(r"\b(real|double precision|float\d?|money)\b", re.IGNORECASE)
ALLOW = "money-guard: ok"


def scan(path, text: str) -> list[str]:
    path_rel = rel(path)
    is_test = bool(re.search(r"(\.test\.|\.spec\.|/test/|/tests/|__tests__|fixtures)", path_rel))
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if ALLOW in line or stripped.startswith(("//", "*", "--", "/*")):
            continue
        if path_rel.endswith(".sql"):
            if SQL_FLOAT.search(line):
                problems.append(f"{path_rel}:{n}: float/money SQL type: use BIGINT minor units, or NUMERIC(18,6) for rates")
            continue
        if FLOAT_OPS.search(line) and MONEY_WORDS.search(line):
            problems.append(f"{path_rel}:{n}: float arithmetic on money: use packages/money (bigint minor units, decimal rates)")
        if NUMBER_TYPE.search(line):
            problems.append(f"{path_rel}:{n}: money typed as `number`: use the Money type (bigint + currency)")
        if (not is_test and HARDCODED_RATE.search(line)
                and "rate_source" not in line and "limit" not in line.lower() and "ratelimit" not in line.lower()):
            problems.append(f"{path_rel}:{n}: looks like a hardcoded FX rate: rates come from the user, evidence or the reference-rate table")
    return problems


def main() -> int:
    payload = read_input()
    findings = []
    for path in edited_paths(payload):
        path_rel = rel(path)
        if not path_rel.endswith(EXTS) or not path_rel.startswith(SCOPES) or not path.exists():
            continue
        try:
            findings += scan(path, path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
    if findings:
        print("money-guard found possible violations of the money rules in CLAUDE.md:", file=sys.stderr)
        print("\n".join(findings[:20]), file=sys.stderr)
        print(f"Fix them, or add `// {ALLOW} <reason>` on a line that genuinely isn't money.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
