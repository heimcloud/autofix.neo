/**
 * /health githubConfigured: the container never holds the GitHub token, so
 * it reports the host worker's last token check (queue/worker-status.json),
 * else the Nix hint OPS_AUTOFIX_TOKEN_CONFIGURED. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, "../server.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-health-"));
const children = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function health(name, env, status) {
  const data = path.join(tmp, name);
  fs.mkdirSync(path.join(data, "queue"), { recursive: true });
  if (status) fs.writeFileSync(path.join(data, "queue", "worker-status.json"), JSON.stringify(status));
  const port = await freePort();
  const c = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env, PORT: String(port), OPS_DATA_DIR: data, OPS_DB_PATH: path.join(data, "ops.sqlite"), OPS_RESULTS_POLL_MS: "0", OPS_INGEST_SECRET: "test-only" },
    stdio: "ignore",
  });
  children.push(c);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = await r.json();
      c.kill("SIGKILL");
      return j;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  c.kill("SIGKILL");
  throw new Error("server did not start");
}

test("/health githubConfigured follows the worker token check, then the Nix hint", async () => {
  let h = await health("hint", { OPS_AUTOFIX_TOKEN_CONFIGURED: "true" });
  assert.equal(h.githubConfigured, true);
  assert.equal(h.githubToken.source, "config");
  h = await health("worker", { OPS_AUTOFIX_TOKEN_CONFIGURED: "true" }, { fork_push_token: false, checked_at: "2026-01-01T00:00:00Z" });
  assert.equal(h.githubConfigured, false);
  assert.equal(h.githubToken.source, "worker");
  h = await health("none", { OPS_AUTOFIX_TOKEN_CONFIGURED: "false" });
  assert.equal(h.githubConfigured, false);
  assert.ok(!JSON.stringify(h).includes("ghp_"));
});
