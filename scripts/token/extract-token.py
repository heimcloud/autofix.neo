#!/usr/bin/env python3
"""Extract the autofix GitHub token from Neo's settings.toml.

Key: services.autofix.github.token.

Reads TOML at runtime so the value is never interpolated into Nix derivations
by this plugin. Prints the token to stdout only (no trailing commentary).
Exit 0 with empty stdout if missing/null/blank — callers treat that as off.
Never prints the token to stderr.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import tomllib
except ImportError:  # pragma: no cover
    import tomli as tomllib  # type: ignore


KEY_PATH = ("services", "autofix", "github", "token")


def dig(data: object, path: tuple[str, ...]) -> object:
    cur: object = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def main() -> int:
    # Refuse to leave shell xtrace on if invoked under bash -x via wrapper.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "settings",
        nargs="?",
        default="/etc/neo/settings.toml",
        help="Path to Neo settings.toml (default: /etc/neo/settings.toml)",
    )
    args = parser.parse_args()
    path = Path(args.settings)
    if not path.is_file():
        return 0
    try:
        with path.open("rb") as fh:
            data = tomllib.load(fh)
    except Exception as exc:  # noqa: BLE001 — never leak file contents
        print(f"neo-autofix: failed to parse settings.toml: {type(exc).__name__}", file=sys.stderr)
        return 0
    value = dig(data, KEY_PATH)
    key = ".".join(KEY_PATH)
    if value is None:
        return 0
    if not isinstance(value, str):
        print(f"neo-autofix: {key} must be a string", file=sys.stderr)
        return 0
    token = value.strip()
    if not token or token.lower() in {"null", "none", "~"}:
        return 0
    # stdout only — no newline logging elsewhere
    sys.stdout.write(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
