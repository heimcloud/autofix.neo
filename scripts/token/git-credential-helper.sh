#!/usr/bin/env bash
# Git credential helper scoped via credential."https://github.com/<fork owner>/".helper
# Reads /run/neo-autofix/github-token (hermes-owned, 0400). Never logs the token.
# @forkOwner@ is substituted by Nix (the owner of the targets' forks).
set +x
set -eu
TOKEN_FILE="${NEO_AUTOFIX_TOKEN_FILE:-/run/neo-autofix/github-token}"
FORK_OWNER="${NEO_AUTOFIX_FORK_OWNER:-@forkOwner@}"
# Unsubstituted / malformed owner: hand out nothing.
[[ "$FORK_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || exit 0

op="${1:-}"
case "$op" in
  get)
    if [[ ! -r "$TOKEN_FILE" ]]; then
      exit 0
    fi
    # Parse credential request from stdin (host=, protocol=, path=).
    host=""
    protocol=""
    path=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && break
      case "$line" in
        host=*) host="${line#host=}" ;;
        protocol=*) protocol="${line#protocol=}" ;;
        path=*) path="${line#path=}" ;;
      esac
    done
    if [[ "$protocol" != "https" || "$host" != "github.com" ]]; then
      exit 0
    fi
    # Path-scoped helper is registered only for https://github.com/<owner>/
    # Still refuse anything that is clearly not under <owner>/.
    if [[ -n "$path" && "$path" != "$FORK_OWNER"/* && "$path" != "$FORK_OWNER" ]]; then
      exit 0
    fi
    token="$(tr -d '\n' < "$TOKEN_FILE")"
    if [[ -z "$token" ]]; then
      exit 0
    fi
    printf 'username=x-access-token\npassword=%s\n' "$token"
    ;;
  store|erase)
    # Ephemeral token file — do not persist via git credential store.
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
