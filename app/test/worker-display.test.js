// /admin worker display: a "paused" left in worker-status.json by the last
// run must not show as paused once the pause flag is cleared.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-wdisp-"));
process.env.OPS_DATA_DIR = tmp;
const Q = path.join(tmp, "queue");
fs.mkdirSync(path.join(Q, "control"), { recursive: true });
const { workerModel } = await import("../lib/worker-state.js");
const QC = await import("../lib/queue-control.js");

function status(state) {
  fs.writeFileSync(path.join(Q, "worker-status.json"), JSON.stringify({ version: 2, state, heartbeat_at: new Date().toISOString() }));
}
const caps = { triage: true, fix: true };

test("stale 'paused' state without the pause flag displays idle", () => {
  status("paused");
  QC.setPaused(Q, false);
  const w = workerModel({ caps });
  assert.equal(w.display, "idle");
  assert.equal(w.state, "idle");
  assert.equal(w.paused, null);
});

test("pause flag set → paused (idle worker); running stays running", () => {
  status("idle");
  QC.setPaused(Q, true);
  assert.equal(workerModel({ caps }).display, "paused");
  status("paused");
  assert.equal(workerModel({ caps }).display, "paused");
  status("running");
  assert.equal(workerModel({ caps }).display, "running");
  QC.setPaused(Q, false);
});
