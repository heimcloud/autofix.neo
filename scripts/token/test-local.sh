#!/usr/bin/env bash
# Local validation of extract + materialize + wrapper + git credential helper
# (dummy token only). Uses nix-build for the shipped wrapper when available.
# Single-quoted $VARs below are expanded by the wrapped child shell on purpose.
# shellcheck disable=SC2016
set +x
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AF="$ROOT/scripts/token"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SETTINGS="$TMP/settings.toml"
TOKEN_FILE="$TMP/run/neo-autofix/github-token"
HELPER="$AF/git-credential-helper.sh"
# Raw sources carry @forkOwner@ / @checkRepo@ placeholders; the built ones are
# checked for leftovers below.
export NEO_AUTOFIX_FORK_OWNER=example-bot NEO_AUTOFIX_CHECK_REPO=example-bot/neo
EXTRACT="$AF/extract-token.py"

mkdir -p "$(dirname "$TOKEN_FILE")"
chmod 0700 "$(dirname "$TOKEN_FILE")"

DUMMY='ghp_DUMMY_TEST_TOKEN_DO_NOT_USE_9f3a2b1c'

cat > "$SETTINGS" <<EOF
[services.autofix]
enabled = true

[services.autofix.github]
token = "$DUMMY"
EOF

echo "== extract =="
got="$("$EXTRACT" "$SETTINGS")"
if [[ "$got" != "$DUMMY" ]]; then
  echo "FAIL: extract mismatch" >&2
  exit 1
fi
echo "extract ok (value not printed)"

echo "== extract missing key =="
cat > "$TMP/empty.toml" <<'EOF'
[services.autofix]
enabled = true
EOF
got2="$("$EXTRACT" "$TMP/empty.toml" || true)"
if [[ -n "$got2" ]]; then
  echo "FAIL: expected empty extract" >&2
  exit 1
fi
echo "missing key → empty ok"

echo "== removed credentials key is ignored =="
printf '[services.credentials.ops]\nautofixForkPushToken = "%s"\n' "$DUMMY" > "$TMP/legacy.toml"
[[ -z "$("$EXTRACT" "$TMP/legacy.toml" 2>/dev/null)" ]] || { echo "FAIL: old key must be ignored" >&2; exit 1; }
echo "old key ignored ok"

echo "== materialize (real script) =="
# Run scripts/autofix/materialize.sh with the local user as owner (no hermes).
export NEO_AUTOFIX_TOKEN_FILE="$TOKEN_FILE"
export NEO_AUTOFIX_SETTINGS="$SETTINGS"
export NEO_AUTOFIX_EXTRACT="$EXTRACT"
NEO_AUTOFIX_OWNER="$(id -un)"
NEO_AUTOFIX_GROUP="$(id -gn)"
export NEO_AUTOFIX_OWNER NEO_AUTOFIX_GROUP
MAT="$AF/materialize.sh"
TOKEN_DIR="$(dirname "$TOKEN_FILE")"
PR_TOKEN_FILE="$TOKEN_DIR/pr-token"
want_owner="$(id -un):$(id -gn)"
set +x

check_dir() {
  local m o
  m="$(stat -c '%a' "$TOKEN_DIR")"; o="$(stat -c '%U:%G' "$TOKEN_DIR")"
  if [[ "$m" != "700" || "$o" != "$want_owner" ]]; then
    echo "FAIL: dir mode=$m owner=$o want 700 $want_owner ($1)" >&2
    exit 1
  fi
}
check_token() {
  local m o
  m="$(stat -c '%a' "$TOKEN_FILE")"; o="$(stat -c '%U:%G' "$TOKEN_FILE")"
  if [[ "$m" != "400" || "$o" != "$want_owner" ]]; then
    echo "FAIL: token mode=$m owner=$o want 400 $want_owner ($1)" >&2
    exit 1
  fi
  if [[ "$(cat "$TOKEN_FILE")" != "$DUMMY" ]]; then
    echo "FAIL: token content mismatch ($1)" >&2
    exit 1
  fi
}

# Pre-existing dir with the wrong mode (what a stale tmpfiles rule leaves) +
# a reserved pr-token that materialize must leave alone.
chmod 0755 "$TOKEN_DIR"
printf 'reserved-pr\n' > "$PR_TOKEN_FILE"
chmod 0400 "$PR_TOKEN_FILE"
out="$(bash "$MAT")"
if [[ "$out" == *"$DUMMY"* ]]; then
  echo "FAIL: materialize printed the token" >&2
  exit 1
fi
check_dir "first run"
check_token "first run"
[[ -f "$PR_TOKEN_FILE" ]] || { echo "FAIL: pr-token removed" >&2; exit 1; }
if compgen -G "$TOKEN_DIR/.github-token.tmp.*" >/dev/null; then
  echo "FAIL: temp file left behind" >&2
  exit 1
fi
# Idempotent: second run (token file already 0400) still succeeds.
bash "$MAT" >/dev/null
check_dir "second run"
check_token "second run"
echo "materialize ok (dir 700, token 400, owner $want_owner, idempotent, pr-token kept)"

echo "== materialize edge cases never fail =="
# Missing key → token removed, exit 0, pr-token kept.
NEO_AUTOFIX_SETTINGS="$TMP/empty.toml" bash "$MAT" >/dev/null
[[ ! -e "$TOKEN_FILE" ]] || { echo "FAIL: stale token kept for null key" >&2; exit 1; }
[[ -f "$PR_TOKEN_FILE" ]] || { echo "FAIL: pr-token removed (null key)" >&2; exit 1; }
check_dir "null key"
# Explicitly empty value → feature off.
printf '[services.autofix.github]\ntoken = ""\n' > "$TMP/blank.toml"
NEO_AUTOFIX_SETTINGS="$TMP/blank.toml" bash "$MAT" >/dev/null
[[ ! -e "$TOKEN_FILE" ]] || { echo "FAIL: token for empty value" >&2; exit 1; }
# No settings file → exit 0.
NEO_AUTOFIX_SETTINGS="$TMP/nope.toml" bash "$MAT" >/dev/null
# Unknown owner → skip, exit 0.
NEO_AUTOFIX_OWNER="neo-no-such-user-$$" bash "$MAT" >/dev/null
# Unexpected error (parent not writable) → warning, still exit 0.
mkdir -p "$TMP/ro"; chmod 0500 "$TMP/ro"
if ! NEO_AUTOFIX_TOKEN_FILE="$TMP/ro/sub/github-token" bash "$MAT" >/dev/null 2>&1; then
  echo "FAIL: materialize exited non-zero on error" >&2
  exit 1
fi
chmod 0700 "$TMP/ro"
# Restore token for the helper/wrapper checks below.
bash "$MAT" >/dev/null
check_token "restore"
# github.tokenFile: copied from the source file (settings ignored).
printf '%s\n' "$DUMMY" > "$TMP/token-src"
chmod 0400 "$TMP/token-src"
NEO_AUTOFIX_TOKEN_SOURCE="$TMP/token-src" NEO_AUTOFIX_SETTINGS="$TMP/empty.toml" bash "$MAT" >/dev/null
check_token "tokenFile source"
NEO_AUTOFIX_TOKEN_SOURCE="$TMP/no-such-src" bash "$MAT" >/dev/null
[[ ! -e "$TOKEN_FILE" ]] || { echo "FAIL: token kept with a missing tokenFile" >&2; exit 1; }
bash "$MAT" >/dev/null
check_token "restore after tokenFile"
echo "edge cases ok (all exit 0)"

echo "== helper (raw source) =="
export NEO_AUTOFIX_TOKEN_FILE="$TOKEN_FILE"
out="$(printf 'protocol=https\nhost=github.com\npath=example-bot/neo\n\n' | "$HELPER" get)"
if ! grep -q 'username=x-access-token' <<<"$out"; then
  echo "FAIL: helper username" >&2
  exit 1
fi
if ! grep -q "password=$DUMMY" <<<"$out"; then
  echo "FAIL: helper password" >&2
  exit 1
fi
# Refuse paths outside the fork owner
out2="$(printf 'protocol=https\nhost=github.com\npath=other/repo\n\n' | "$HELPER" get || true)"
if [[ -n "$out2" ]]; then
  echo "FAIL: helper should refuse other/repo" >&2
  exit 1
fi
unset out out2
echo "helper ok (scoped)"

# --- Build the wrapper the way it ships -------------------------------------
# The original bug only existed after build-time substitution, so the git
# checks below run against built wrappers with NO helper/git overrides.
echo "== build wrapper =="
BUILT_SED="$TMP/sed/bin/neo-autofix-env"
SED_HELPER="$TMP/sed/bin/neo-autofix-git-credential"
mkdir -p "$TMP/sed/bin"
sed -e "s|@forkOwner@|example-bot|g" "$HELPER" > "$SED_HELPER"
chmod 0755 "$SED_HELPER"
# Same substitution as package.nix (replaceStrings = replace every occurrence).
sed -e "s|@helper@|$SED_HELPER|g" -e "s|@git@|$(command -v git)|g" \
  -e "s|@forkOwner@|example-bot|g" -e "s|@checkRepo@|example-bot/neo|g" \
  "$AF/neo-autofix-env.sh" > "$BUILT_SED"
chmod 0755 "$BUILT_SED"
BUILT_NIX=""
NIX_HELPER=""
if command -v nix-build >/dev/null 2>&1 && nix-instantiate --find-file nixpkgs >/dev/null 2>&1; then
  mapfile -t nix_out < <(nix-build "$AF/package.nix" --arg pkgs 'import <nixpkgs> {}' \
    --argstr forkOwner example-bot --argstr checkRepo example-bot/neo \
    -A envWrapper -A helper --no-out-link)
  if [[ "${#nix_out[@]}" != 2 ]]; then
    echo "FAIL: nix-build of scripts/token/package.nix" >&2
    exit 1
  fi
  BUILT_NIX="${nix_out[0]}/bin/neo-autofix-env"
  NIX_HELPER="${nix_out[1]}/bin/neo-autofix-git-credential"
  [[ -x "$BUILT_NIX" && -x "$NIX_HELPER" ]] || { echo "FAIL: nix outputs missing" >&2; exit 1; }
  if ! grep -qF "$NIX_HELPER" "$BUILT_NIX"; then
    echo "FAIL: nix wrapper does not reference the helper store path" >&2
    exit 1
  fi
  echo "nix-built wrapper: $BUILT_NIX"
else
  echo "SKIP nix build (nix-build or <nixpkgs> unavailable); sed-substituted wrapper only"
fi
for w in "$BUILT_SED" ${BUILT_NIX:+"$BUILT_NIX"}; do
  bash -n "$w"
  if grep -qE '@(helper|git|forkOwner|checkRepo)@' "$w"; then
    echo "FAIL: unsubstituted placeholder in $w" >&2
    exit 1
  fi
done
echo "built wrappers ok (no leftover placeholders)"

# --- Hermetic git environment -------------------------------------------------
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/xdg"
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
unset GIT_CONFIG_GLOBAL GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS || true
mkdir -p "$HOME" "$XDG_CONFIG_HOME"
# Neutral cwd: no repository-local config (e.g. this checkout) leaks in.
cd "$TMP"
# A "caller" gitconfig with a generic decoy helper and an identity: the wrapper
# must keep the identity but reset the helper list for github.com/example-bot/.
DECOY_HOME="$TMP/home-decoy"
mkdir -p "$DECOY_HOME"
cat > "$DECOY_HOME/.gitconfig" <<'EOF'
[user]
	name = Decoy Caller
[credential]
	helper = "!f() { echo username=decoy; echo password=decoy-pass; }; f"
EOF

# fill <wrapper|-> <host> <path>: git credential fill output (captured only).
fill() {
  local w="$1"
  shift
  if [[ "$w" == "-" ]]; then
    printf 'protocol=https\nhost=%s\npath=%s\n\n' "$1" "$2" | git credential fill 2>/dev/null || true
  else
    printf 'protocol=https\nhost=%s\npath=%s\n\n' "$1" "$2" | "$w" git credential fill 2>/dev/null || true
  fi
}
expect_token() { # <label> <output>
  grep -qx 'username=x-access-token' <<<"$2" || { echo "FAIL: $1: username" >&2; exit 1; }
  grep -qx "password=$DUMMY" <<<"$2" || { echo "FAIL: $1: password" >&2; exit 1; }
}
expect_none() { # <label> <output>
  if grep -q '^password=' <<<"$2" || [[ "$2" == *"$DUMMY"* ]]; then
    echo "FAIL: $1: expected no credential" >&2
    exit 1
  fi
}

# git_suite <label> <wrapper> <expected helper path>
git_suite() {
  local label="$1" w="$2" want="$3" out rc
  echo "-- git suite: $label"
  out="$("$w" --check 2>&1)" && rc=0 || rc=$?
  [[ "$out" != *"$DUMMY"* ]] || { echo "FAIL: $label: --check leaked token" >&2; exit 1; }
  [[ "$rc" == 0 ]] || { echo "FAIL: $label: --check rc=$rc: $out" >&2; exit 1; }
  out="$("$w" git config --get-urlmatch credential.helper https://github.com/example-bot/neo || true)"
  [[ "$out" == "$want" ]] || { echo "FAIL: $label: get-urlmatch='$out' want '$want'" >&2; exit 1; }
  out="$("$w" bash -c 'printf %s "${GIT_CONFIG_GLOBAL-UNSET}"')"
  [[ "$out" == "UNSET" ]] || { echo "FAIL: $label: GIT_CONFIG_GLOBAL set" >&2; exit 1; }
  expect_token "$label example-bot/neo.git" "$("$w" bash -c 'printf "protocol=https\nhost=github.com\npath=example-bot/neo.git\n\n" | git credential fill 2>/dev/null')"
  expect_token "$label example-bot/neo" "$(fill "$w" github.com example-bot/neo)"
  expect_none "$label other/repo.git" "$(fill "$w" github.com other/repo.git)"
  expect_none "$label example-botx/neo.git" "$(fill "$w" github.com example-botx/neo.git)"
  expect_none "$label gitlab.com/example-bot" "$(fill "$w" gitlab.com example-bot/neo.git)"
  expect_none "$label no wrapper" "$(fill - github.com example-bot/neo.git)"
  # Caller config kept (identity), generic decoy helper reset for example-bot/.
  out="$(HOME="$DECOY_HOME" "$w" git config --get user.name || true)"
  [[ "$out" == "Decoy Caller" ]] || { echo "FAIL: $label: caller gitconfig dropped" >&2; exit 1; }
  expect_token "$label decoy reset" "$(HOME="$DECOY_HOME" fill "$w" github.com example-bot/neo.git)"
  # Ambient GIT_CONFIG_COUNT entries are preserved (appended after).
  out="$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=Ambient \
    "$w" git config --get user.name || true)"
  [[ "$out" == "Ambient" ]] || { echo "FAIL: $label: ambient GIT_CONFIG_COUNT lost" >&2; exit 1; }
  expect_token "$label ambient count" "$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name \
    GIT_CONFIG_VALUE_0=Ambient fill "$w" github.com example-bot/neo.git)"
  expect_token "$label bogus count" "$(GIT_CONFIG_COUNT=bogus fill "$w" github.com example-bot/neo.git)"
  echo "   $label ok"
}

echo "== wrapper git credential (built wrappers, no overrides) =="
export NEO_AUTOFIX_TOKEN_FILE="$TOKEN_FILE"
export NEO_AUTOFIX_PR_TOKEN_FILE="$PR_TOKEN_FILE"
unset NEO_AUTOFIX_GIT_HELPER NEO_AUTOFIX_GIT || true
git_suite "sed-substituted" "$BUILT_SED" "$SED_HELPER"
if [[ -n "$BUILT_NIX" ]]; then
  git_suite "nix-built" "$BUILT_NIX" "$NIX_HELPER"
fi
# Raw source: placeholders are not executable → PATH lookup of the helper.
RAW="$AF/neo-autofix-env.sh"
# (shims only add env; the wrapper under test is the unmodified source file)
printf '#!%s\nPATH="%s:$PATH" exec "%s" "$@"\n' "$(command -v bash)" "$TMP/sed/bin" "$RAW" > "$TMP/raw-path"
printf '#!%s\nNEO_AUTOFIX_GIT_HELPER="%s" exec "%s" "$@"\n' "$(command -v bash)" "$SED_HELPER" "$RAW" > "$TMP/raw-override"
chmod 0755 "$TMP/raw-path" "$TMP/raw-override"
git_suite "raw source + PATH helper" "$TMP/raw-path" "$SED_HELPER"
git_suite "raw source + override" "$TMP/raw-override" "$SED_HELPER"

echo "== --check failure modes =="
# check_fails <label> <expected stderr substring> [env...]
check_fails() {
  local label="$1" want="$2" out rc
  shift 2
  out="$(env "$@" "$RAW" --check 2>&1)" && rc=0 || rc=$?
  [[ "$out" != *"$DUMMY"* ]] || { echo "FAIL: $label: --check leaked token" >&2; exit 1; }
  [[ "$rc" != 0 ]] || { echo "FAIL: $label: --check should fail" >&2; exit 1; }
  [[ "$out" == *"$want"* ]] || { echo "FAIL: $label: message '$out'" >&2; exit 1; }
  echo "   $label → rc=$rc: $out"
}
check_fails "helper missing" "not found" NEO_AUTOFIX_GIT_HELPER=/nonexistent/helper
printf '#!/bin/sh\nexit 0\n' > "$TMP/empty-helper"
chmod 0755 "$TMP/empty-helper"
check_fails "helper returns nothing" "returned no password" \
  NEO_AUTOFIX_GIT_HELPER="$TMP/empty-helper"
mkdir -p "$TMP/home-specific"
cat > "$TMP/home-specific/.gitconfig" <<'EOF'
[credential "https://github.com/example-bot/neo"]
	helper = /nonexistent/more-specific
EOF
check_fails "get-urlmatch mismatch" "does not resolve" \
  NEO_AUTOFIX_GIT_HELPER="$SED_HELPER" HOME="$TMP/home-specific"
mkdir -p "$TMP/nogit"
ln -s "$(command -v bash)" "$TMP/nogit/bash"
check_fails "git missing" "git not found" \
  NEO_AUTOFIX_GIT_HELPER="$SED_HELPER" NEO_AUTOFIX_GIT=/nonexistent/git \
  PATH="$TMP/nogit"
echo "--check failure modes ok"

WRAPPER="$BUILT_SED"
e2e_https_push() {
  # Real `git push https://github.com/example-bot/neo` under the built wrapper,
  # inside a private network namespace (nothing can reach the internet):
  # github.com:443 resolves to a local HTTPS git http-backend that requires
  # Basic auth x-access-token:<dummy>. url.insteadOf would rewrite the URL
  # before credential lookup, so curl's resolve override is used instead.
  set -euo pipefail
  ip link set lo up
  local E="$TMP/e2e" srv rc out
  mkdir -p "$E/root/example-bot" "$E/root/other"
  git init -q --bare "$E/root/example-bot/neo.git"
  git init -q --bare "$E/root/other/neo.git"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=github.com \
    -addext subjectAltName=DNS:github.com -keyout "$E/key.pem" -out "$E/cert.pem" 2>/dev/null
  printf 'x-access-token:%s' "$DUMMY" > "$E/auth"
  E2E_EXPECT_AUTH_FILE="$E/auth" python3 "$AF/test-https-git-server.py" \
    "$E/root" "$E/cert.pem" "$E/key.pem" 443 "$E/ready" 2>"$E/server.log" &
  srv=$!
  trap 'kill "$srv" 2>/dev/null || true' RETURN
  for _ in $(seq 100); do [[ -f "$E/ready" ]] && break; sleep 0.1; done
  [[ -f "$E/ready" ]] || { echo "FAIL: e2e server did not start" >&2; cat "$E/server.log" >&2; return 1; }
  git init -q "$E/work"
  git -C "$E/work" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m e2e
  local -a gc=(-c http.curloptResolve=github.com:443:127.0.0.1 -c "http.sslCAInfo=$E/cert.pem")
  # Without the wrapper: the reported symptom.
  out="$(git -C "$E/work" "${gc[@]}" push -q https://github.com/example-bot/neo HEAD:refs/heads/e2e 2>&1)" && rc=0 || rc=$?
  [[ "$rc" != 0 && "$out" == *"could not read Username"* ]] || { echo "FAIL: e2e: unwrapped push should fail (rc=$rc)" >&2; return 1; }
  # Other owner under the wrapper: helper not used → no credentials.
  out="$("$WRAPPER" git -C "$E/work" "${gc[@]}" push -q https://github.com/other/neo HEAD:refs/heads/e2e 2>&1)" && rc=0 || rc=$?
  [[ "$rc" != 0 && "$out" == *"could not read Username"* ]] || { echo "FAIL: e2e: other-owner push should fail (rc=$rc)" >&2; return 1; }
  # example-bot/neo under the wrapper: succeeds with the dummy token.
  out="$("$WRAPPER" git -C "$E/work" "${gc[@]}" push -q https://github.com/example-bot/neo HEAD:refs/heads/e2e 2>&1)" && rc=0 || rc=$?
  [[ "$out" != *"$DUMMY"* ]] || { echo "FAIL: e2e: push output leaked token" >&2; return 1; }
  [[ "$rc" == 0 ]] || { echo "FAIL: e2e: wrapped push rc=$rc: $out" >&2; return 1; }
  [[ "$(git -C "$E/root/example-bot/neo.git" rev-parse refs/heads/e2e)" == "$(git -C "$E/work" rev-parse HEAD)" ]] ||
    { echo "FAIL: e2e: ref not pushed" >&2; return 1; }
  if git -C "$E/root/other/neo.git" rev-parse -q --verify refs/heads/e2e >/dev/null; then
    echo "FAIL: e2e: other owner received a push" >&2
    return 1
  fi
  echo "e2e https push ok (unwrapped: prompt error; other owner: refused; example-bot/neo: pushed)"
}
echo "== e2e https push (private netns) =="
if [[ -n "$BUILT_NIX" ]]; then
  WRAPPER="$BUILT_NIX"
fi
if command -v unshare >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 &&
  command -v ip >/dev/null 2>&1 && unshare -rn true 2>/dev/null; then
  export TMP AF DUMMY WRAPPER
  unshare -rn bash -c "$(declare -f e2e_https_push); e2e_https_push"
else
  echo "SKIP e2e push (needs unshare -rn, ip, openssl); git credential fill checks above still ran"
fi

echo "== wrapper --check / env =="
WRAPPER="$BUILT_SED"
"$WRAPPER" --check
# Child sees GH_TOKEN; parent dump must not be used — verify via env print in child
child="$("$WRAPPER" bash -c 'printf %s "$GH_TOKEN"')"
if [[ "$child" != "$DUMMY" ]]; then
  echo "FAIL: child GH_TOKEN" >&2
  exit 1
fi
# Confirm wrapper stdout for a benign command does not include token when cmd is echo hi
benign="$("$WRAPPER" echo hi)"
if [[ "$benign" == *"DUMMY"* ]]; then
  echo "FAIL: token leaked in benign output" >&2
  exit 1
fi
if [[ "$benign" != "hi" ]]; then
  echo "FAIL: wrapper exec" >&2
  exit 1
fi
# Reserved pr-token: exported when readable, ignored when unreadable/absent.
child_pr="$("$WRAPPER" bash -c 'printf %s "${GH_PR_TOKEN-NONE}"')"
if [[ "$child_pr" != "reserved-pr" ]]; then
  echo "FAIL: expected GH_PR_TOKEN from reserved pr-token" >&2
  exit 1
fi
if [[ "$(id -u)" != 0 ]]; then
  chmod 0000 "$PR_TOKEN_FILE"
  child_pr2="$("$WRAPPER" bash -c 'printf %s "${GH_PR_TOKEN-NONE}:${GH_TOKEN:+set}"')"
  if [[ "$child_pr2" != "NONE:set" ]]; then
    echo "FAIL: unreadable pr-token should be ignored, got $child_pr2" >&2
    exit 1
  fi
  chmod 0400 "$PR_TOKEN_FILE"
fi
rm -f "$PR_TOKEN_FILE"
child_pr3="$("$WRAPPER" bash -c 'printf %s "${GH_PR_TOKEN-NONE}"')"
[[ "$child_pr3" == "NONE" ]] || { echo "FAIL: GH_PR_TOKEN without pr-token" >&2; exit 1; }
echo "pr-token reserved path ok"
# Unreadable fork-push token → --check non-zero (triage), wrapper still runs.
if [[ "$(id -u)" != 0 ]]; then
  chmod 0000 "$TOKEN_FILE"
  if "$WRAPPER" --check; then
    echo "FAIL: --check should fail for unreadable token" >&2
    exit 1
  fi
  out4="$("$WRAPPER" bash -c 'echo TOK=${GH_TOKEN-EMPTY}')"
  [[ "$out4" == "TOK=EMPTY" ]] || { echo "FAIL: unreadable token, got $out4" >&2; exit 1; }
  chmod 0400 "$TOKEN_FILE"
fi
# Absent token
rm -f "$TOKEN_FILE"
if "$WRAPPER" --check; then
  echo "FAIL: --check should fail without token" >&2
  exit 1
fi
out3="$("$WRAPPER" bash -c 'echo TOK=${GH_TOKEN-EMPTY}')"
if [[ "$out3" != "TOK=EMPTY" ]]; then
  echo "FAIL: expected no GH_TOKEN when absent, got $out3" >&2
  exit 1
fi
out5="$("$WRAPPER" bash -c 'echo C=${GIT_CONFIG_COUNT-UNSET}')"
[[ "$out5" == "C=UNSET" ]] || { echo "FAIL: git helper configured without token, got $out5" >&2; exit 1; }
echo "wrapper ok"

echo "== materialize absent key does not fail =="
export NEO_AUTOFIX_SETTINGS="$TMP/empty.toml"
rm -f "$TOKEN_FILE"
# simulate materialize exit 0 path
token="$("$EXTRACT" "$TMP/empty.toml" || true)"
if [[ -n "$token" ]]; then
  echo "FAIL" >&2
  exit 1
fi
echo "absent key ok"

echo "ALL LOCAL CHECKS PASSED"
