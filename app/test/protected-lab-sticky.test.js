/**
 * Protected lab approval sticks to the incident (v0.3.1): an admin approval
 * covers the automatic lab-retry attempts of the same branch / revise round,
 * a lab-failed protected card offers "Rerun lab test" (approval kept, fresh
 * signature), and a new revise round still needs a new approval.
 * Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-prot-sticky-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_LAB = "true";
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const B = await import("../lib/board.js");
const LT = await import("../../scripts/autofix/labtest.mjs");

for (const d of ["triage", "fix", "push", "lab", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });
const sqliteBin = path.join(tmpDir, "sqlite3");
fs.writeFileSync(
  sqliteBin,
  `#!${process.execPath}
const Database = require(${JSON.stringify(path.join(repo, "app", "node_modules", "better-sqlite3"))});
const a = process.argv.slice(2);
if (a[0] !== "-readonly" || a[1] !== "-json") process.exit(2);
const db = new Database(a[2], { readonly: true, fileMustExist: true });
const rows = db.prepare(a[3]).all();
process.stdout.write(rows.length ? JSON.stringify(rows) : "");
`,
  { mode: 0o755 },
);
const runnerCfg = () => ({ opsDir: tmpDir, opsUid: process.getuid(), stateDir: path.join(tmpDir, "labstate"), dbPath: process.env.OPS_DB_PATH, sqlite: sqliteBin, approvalMaxAgeSec: 3 * 86400 });
after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PROT = { areas: ["hermes"], paths: ["nix/services/hermes"], core: false, label: "hermes" };
const events = (id) => db.listIncidentEvents(id);
const hi = (id) => B.needsHumanInput(db.getIncident(id), events(id), db.listFixAttempts(id), { labAuto: true });
const labDir = path.join(tmpDir, "queue", "lab");
const labJobs = (id) => fs.readdirSync(labDir).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".json"));

function needsApproval(id, { attempt = 1, sha = "e", round } = {}) {
  applyResult({
    kind: "fix",
    incident_id: id,
    status: "lab_approval_needed",
    lab: "awaiting_approval",
    branch: `fix/sticky-${id}`,
    job: `fix-${id}-2026-01-01T00-00-0${attempt}-000Z`,
    fix_job: `fix-${id}-2026-01-01T00-00-0${attempt}-000Z`,
    attempt,
    max_attempts: 2,
    head_sha: sha.repeat(40),
    base_sha: "f".repeat(40),
    pending_compare_url: `https://github.com/example/neo/compare/dev...fork:neo:fix/sticky-${id}?expand=1`,
    pr_title: "fix: agent",
    pr_body: "body",
    ...(round ? { pr_number: 7, revise_round: round } : {}),
    protected: PROT,
    summary: "Protected path (hermes): approve lab test.",
  });
}
/** Worker claims the queued lab job, the runner verifies it, the lab fails. */
async function runAndFail(id, { retry }) {
  const [file] = labJobs(id);
  assert.ok(file, "an approved lab job is queued");
  const instance = `lab-${file.replace(/\.json$/, "")}`;
  fs.renameSync(path.join(labDir, file), path.join(tmpDir, "queue", "processing", `${instance}.json`));
  const spec = LT.loadSpec(runnerCfg(), instance);
  const v = await LT.verifyApproval(runnerCfg(), spec, instance);
  assert.equal(v.ok, true, v.reason);
  fs.mkdirSync(path.join(tmpDir, "labstate", "approvals"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "labstate", "approvals", `${v.eventId}.used`), `${instance}\n`); // single use
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "processing", `${instance}.json`), "utf8"));
  fs.renameSync(path.join(tmpDir, "queue", "processing", `${instance}.json`), path.join(tmpDir, "queue", "failed", `${instance}.json`));
  applyResult({
    kind: "fix",
    via: "lab",
    incident_id: id,
    branch: job.branch,
    head_sha: job.head_sha,
    job: job.fix_job,
    lab_job: instance,
    attempts: job.attempt,
    max_attempts: 2,
    protected: { ...PROT, approved: true, approval_event_id: v.eventId },
    status: retry ? "lab_retry" : "needs_human",
    lab: "failed",
    summary: retry ? "Lab test failed (1/2 checks passed). Retrying the fix (attempt 2/2)." : "Lab test failed after 2 attempt(s) (1/2 checks passed)",
  });
  return v.eventId;
}
async function withAdmin(fn) {
  const app = express();
  app.use("/admin", createAdminRouter());
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}
function post(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: p, headers: { "content-type": "application/json", accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data || "null"), body: data }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("approve → lab fails → retry fix touches the protected path again → the approval still holds", async () => {
  const inc = db.upsertIncident({ report_hash: "sticky-1", unit: "docker-hermes.service", severity: "high", logs_excerpt: "agent crashed" }).incident;
  needsApproval(inc.id);
  await withAdmin(async (port) => assert.equal((await post(port, `/admin/incidents/${inc.id}/approve-lab`)).status, 200));
  const first = await runAndFail(inc.id, { retry: true });

  // Attempt 2: the worker pushes a new head on the same branch, still protected.
  needsApproval(inc.id, { attempt: 2, sha: "d" });
  assert.equal(db.getIncident(inc.id).status, "testing", "no second approval card");
  assert.equal(hi(inc.id).needed, false);
  const ev = events(inc.id).filter((e) => e.kind === "lab_approved");
  assert.equal(ev.length, 2);
  const meta = JSON.parse(ev[1].meta_json);
  assert.equal(meta.head_sha, "d".repeat(40));
  assert.equal(meta.reused_approval, first);
  const second = await runAndFail(inc.id, { retry: false });
  assert.notEqual(second, first, "fresh signature + event per lab job (single use kept)");

  // Out of attempts: Rerun lab test (approval kept) next to Start fix.
  const r = hi(inc.id).reasons[0];
  assert.equal(r.code, "lab_failed");
  assert.deepEqual(r.actions, ["rerun_lab", "start_fix", "close"]);
  await withAdmin(async (port) => {
    const x = await post(port, `/admin/incidents/${inc.id}/retry-lab`);
    assert.equal(x.status, 200, x.body);
    assert.match(x.json.message, /approval kept/);
  });
  assert.equal(db.getIncident(inc.id).status, "testing");
  const [file] = labJobs(inc.id);
  const job = JSON.parse(fs.readFileSync(path.join(labDir, file), "utf8"));
  assert.equal(job.head_sha, "d".repeat(40));
  assert.equal(job.attempt, 2);
  await runAndFail(inc.id, { retry: false });
});

test("a new revise round (new diff) still needs a new approval, and the card says so", async () => {
  const inc = db.upsertIncident({ report_hash: "sticky-2", unit: "docker-hermes.service", severity: "high", logs_excerpt: "agent crashed" }).incident;
  needsApproval(inc.id);
  await withAdmin(async (port) => assert.equal((await post(port, `/admin/incidents/${inc.id}/approve-lab`)).status, 200));
  await runAndFail(inc.id, { retry: false });
  needsApproval(inc.id, { sha: "c", round: 1 });
  assert.equal(db.getIncident(inc.id).status, "needs_human");
  const r = hi(inc.id).reasons[0];
  assert.equal(r.code, "lab_approval");
  assert.match(r.label, /new diff since your last approval/);
  assert.deepEqual(r.actions, ["approve_lab", "skip_lab", "close"]);
});

test("Start fix by the admin drops the approval", async () => {
  const inc = db.upsertIncident({ report_hash: "sticky-3", unit: "docker-hermes.service", severity: "high", logs_excerpt: "agent crashed" }).incident;
  needsApproval(inc.id);
  await withAdmin(async (port) => assert.equal((await post(port, `/admin/incidents/${inc.id}/approve-lab`)).status, 200));
  await runAndFail(inc.id, { retry: false });
  db.addIncidentEvent(inc.id, "fix_enqueued", "Fix job enqueued for host worker", { job_kind: "fix" });
  needsApproval(inc.id, { sha: "b" });
  assert.equal(db.getIncident(inc.id).status, "needs_human");
  assert.equal(hi(inc.id).reasons[0].code, "lab_approval");
});
