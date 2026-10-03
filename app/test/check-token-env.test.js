/**
 * `neo-autofix-worker --check-token` outside the unit: loads the unit's
 * environment file (worker-env.json) and survives a caller cwd the user
 * cannot enter (sudo -u hermes from /root). Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(here, "../../scripts/autofix/worker.mjs");
const BASH = process.env.TEST_BASH || "/usr/bin/env bash";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-checktoken-"));
after(() => {
  for (const d of fs.readdirSync(tmp)) fs.chmodSync(path.join(tmp, d), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sh(file, body) {
  fs.writeFileSync(file, `#!${BASH}\nset -eu\n${body}\n`, { mode: 0o755 });
}

function setup() {
  const data = path.join(tmp, "data");
  fs.mkdirSync(path.join(data, "queue"), { recursive: true });
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // Fails when run from a directory it cannot enter (what git does there).
  sh(path.join(bin, "fake-env"), `[ "$1" = --check ] && ls . >/dev/null && exit 0; exit 1`);
  sh(path.join(bin, "fake-pr"), `ls . >/dev/null; echo '{"api_ok":true,"push_ok":true,"pr_ok":true,"token_kind":"classic"}'`);
  const targets = path.join(tmp, "targets.json");
  fs.writeFileSync(targets, JSON.stringify([{ upstream: "example-upstream/neo", fork: "example-bot/neo" }]));
  const envFile = path.join(tmp, "worker-env.json");
  fs.writeFileSync(
    envFile,
    JSON.stringify({
      OPS_DATA_DIR: data,
      OPS_TARGETS_FILE: targets,
      OPS_AUTOFIX_FIX: "1",
      OPS_AUTOFIX_PR: "1",
      OPS_AUTOFIX_ENV_BIN: path.join(bin, "fake-env"),
      OPS_AUTOFIX_PR_BIN: path.join(bin, "fake-pr"),
      OPS_PR_TOKEN_FILE: path.join(tmp, "no-token"),
    }),
  );
  return { envFile };
}

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("OPS_")) delete env[k];
  return { ...env, ...extra };
}

test("--check-token outside the unit: uses worker-env.json (PR loop on) and an unreadable cwd does not fail the push check", { skip: process.getuid?.() === 0 && "root can enter any dir" }, () => {
  const { envFile } = setup();
  const locked = path.join(tmp, "locked");
  fs.mkdirSync(locked);
  // cd into the dir, then take its permissions away (like /root for hermes).
  const r = spawnSync("sh", ["-c", `cd "$1" && chmod 000 "$1" && exec "$2" "$3" --check-token`, "sh", locked, process.execPath, WORKER], {
    encoding: "utf8",
    env: cleanEnv({ NEO_AUTOFIX_UNIT_ENV: envFile }),
  });
  const out = r.stdout + r.stderr;
  assert.match(out, /environment: .*worker-env\.json/);
  assert.match(out, /push \(git credential via .*fake-env\): ok/);
  assert.match(out, /PR loop: on/);
  assert.doesNotMatch(out, /PR loop: off/);
  assert.equal(r.status, 0, out);
});

test("--check-token under the unit (OPS_DATA_DIR set): the env file is not read", () => {
  const { envFile } = setup();
  const r = spawnSync(process.execPath, [WORKER, "--check-token"], {
    encoding: "utf8",
    cwd: tmp,
    env: cleanEnv({ NEO_AUTOFIX_UNIT_ENV: envFile, OPS_DATA_DIR: path.join(tmp, "data"), OPS_TARGETS: "[]" }),
  });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /environment: /);
  assert.match(out, /PR loop: off/);
});
