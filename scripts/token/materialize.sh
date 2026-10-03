#!/usr/bin/env bash
# Materialize the autofix GitHub token → tmpfs token file. Source:
#   NEO_AUTOFIX_TOKEN_SOURCE (github.tokenFile, a root-readable file), else
#   services.autofix.github.token in settings.toml (read at runtime, never
#   copied into the Nix store; legacy credentials key still accepted).
#
# Result: $TOKEN_DIR 0700 owner:group, $TOKEN_FILE 0400 owner:group (hermes).
# Idempotent; safe to re-run on every activation / `systemctl start`.
# Never fails the activation snippet or unit: a missing/null token is
# "feature off", and any unexpected error only logs a warning (exit 0).
# Never touches other files in the dir (e.g. the reserved pr-token).
set +x
set -eu

TOKEN_FILE="${NEO_AUTOFIX_TOKEN_FILE:-/run/neo-autofix/github-token}"
TOKEN_DIR="$(dirname "$TOKEN_FILE")"
TOKEN_BASE="$(basename "$TOKEN_FILE")"
SETTINGS="${NEO_AUTOFIX_SETTINGS:-/etc/neo/settings.toml}"
SOURCE="${NEO_AUTOFIX_TOKEN_SOURCE:-@source@}"
case "$SOURCE" in @*@) SOURCE="" ;; esac
EXTRACT="${NEO_AUTOFIX_EXTRACT:-@extract@}"
# @owner@/@group@ are substituted by Nix (services.hermes-agent.{user,group}).
OWNER_USER="${NEO_AUTOFIX_OWNER:-@owner@}"
OWNER_GROUP="${NEO_AUTOFIX_GROUP:-@group@}"
# Unsubstituted (script run straight from the repo) → Hermes default.
case "$OWNER_USER" in @*@) OWNER_USER=hermes ;; esac
case "$OWNER_GROUP" in @*@) OWNER_GROUP=hermes ;; esac

tmp=""
dir_ready=0

# Hand the dir (back) to the owner on every exit path, drop partial temp
# files, and turn any unexpected failure into a warning + exit 0.
finish() {
  local rc=$?
  set +e
  if [[ -n "$tmp" ]]; then
    rm -f -- "$tmp"
  fi
  if [[ "$dir_ready" == 1 ]]; then
    chown -- "$OWNER_USER:$OWNER_GROUP" "$TOKEN_DIR" &&
      chmod 0700 "$TOKEN_DIR" ||
      rc=1
  fi
  if [[ "$rc" != 0 ]]; then
    echo "neo-autofix: WARNING materialize failed (rc=$rc); token may be unavailable, triage-only" >&2
  fi
  exit 0
}
trap finish EXIT

if ! id -u "$OWNER_USER" >/dev/null 2>&1; then
  echo "neo-autofix: user $OWNER_USER absent; skip materialize"
  exit 0
fi
if command -v getent >/dev/null 2>&1 && ! getent group "$OWNER_GROUP" >/dev/null 2>&1; then
  echo "neo-autofix: group $OWNER_GROUP absent; skip materialize"
  exit 0
fi

# The dir must be a real directory (not a symlink / stray file).
if [[ -L "$TOKEN_DIR" || ( -e "$TOKEN_DIR" && ! -d "$TOKEN_DIR" ) ]]; then
  rm -f -- "$TOKEN_DIR"
fi
mkdir -p -- "$TOKEN_DIR"
# Lock the dir to the invoking user (root) while writing so the owner cannot
# race the temp file; finish() hands it to OWNER_USER:OWNER_GROUP 0700 after.
# Also repairs a dir left with the wrong owner (e.g. an old root tmpfiles rule).
chown -- "$(id -u):$(id -g)" "$TOKEN_DIR"
chmod 0700 "$TOKEN_DIR"
dir_ready=1

# Remove stale token (and leftover temp files) first so a cleared settings
# key disables the feature. Only our own names — never the reserved pr-token.
rm -f -- "$TOKEN_FILE" "$TOKEN_DIR/.${TOKEN_BASE}".tmp.* "${TOKEN_FILE}".tmp.*

if [[ -n "$SOURCE" ]]; then
  if [[ ! -f "$SOURCE" || ! -r "$SOURCE" ]]; then
    echo "neo-autofix: github.tokenFile $SOURCE missing or unreadable; feature off"
    exit 0
  fi
  token="$(head -c 4096 -- "$SOURCE" | tr -d '\r\n' || true)"
else
  if [[ ! -f "$SETTINGS" ]]; then
    echo "neo-autofix: no settings.toml at $SETTINGS; feature off"
    exit 0
  fi
  token="$("$EXTRACT" "$SETTINGS" || true)"
fi
if [[ -z "${token}" ]]; then
  echo "neo-autofix: GitHub token unset; feature off"
  exit 0
fi

umask 077
# Write via exclusive temp + rename; never echo token.
tmp="$(mktemp "$TOKEN_DIR/.${TOKEN_BASE}.tmp.XXXXXX")"
printf '%s\n' "$token" > "$tmp"
unset token
chown -- "$OWNER_USER:$OWNER_GROUP" "$tmp"
chmod 0400 "$tmp"
mv -f -- "$tmp" "$TOKEN_FILE"
tmp=""
# Confirm mode without revealing contents
echo "neo-autofix: materialized token file mode=$(stat -c '%a' "$TOKEN_FILE") owner=$(stat -c '%U:%G' "$TOKEN_FILE")"
