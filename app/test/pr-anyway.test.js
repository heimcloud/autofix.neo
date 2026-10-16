/**
 * v0.3.6 "Open PR anyway" (lab failed): route, job, PR body, drawer rules.
 * Based on the PR loop app harness: kind "pr" results → card state / incident status,
 * needs_human reasons (PR closed, revision cap, no lab method, unknown
 * target), "Skip lab" → draft PR job, "Open the PR now", PR-loop validation
 * route. Synthetic data only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-pr-anyway-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_LAB = "true";
process.env.OPS_AUTOFIX_PR = "true";
process.env.OPS_TARGETS = JSON.stringify([
  { upstream: "example-upstream/neo", fork: "example-bot/neo", baseRef: "master", flakeInput: "neo", protectedPaths: ["nix/services/ops", "nix/services/hermes", "nix/services/swag", "nix/modules/core"], basePaths: ["nix/modules/core"] },
  { upstream: "example-upstream/highsea.neo", fork: "example-bot/highsea.neo", baseRef: "master", lab: "none" },
]);
delete process.env.ADMIN_READ_ONLY;

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { applyResult } = await import("../lib/results.js");
const { createAdminRouter } = await import("../lib/admin.js");
const B = await import("../lib/board.js");
const Q = await import("../lib/queue.js");
const PR = await import("../../scripts/autofix/pr.mjs");
const { labFailedPrSource } = await import("../lib/pr-override.js");
const { buildCardModel, buildDrawerModel, renderCard, renderDrawer } = await import("../lib/board-view.js");

for (const d of ["triage", "fix", "push", "lab", "pr", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CAPS = { readOnly: false, triage: true, fix: true, push: true, lab: true, pr: true, protectedWatchdogSec: 600 };
const redact = (s) => String(s ?? "");
const events = (id) => db.listIncidentEvents(id);
const card = (id) => buildCardModel(db.getIncident(id), events(id), db.listFixAttempts(id), redact, { labAuto: true, prAuto: true });
const hi = (id) => B.needsHumanInput(db.getIncident(id), events(id), [], { prAuto: true });
const jobs = (kind, id) => fs.readdirSync(path.join(tmpDir, "queue", kind)).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".json"));
let n = 0;
function incident(extra = {}) {
  n += 1;
  return db.upsertIncident({ report_hash: `prany-${n}`, unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine x failed", ...extra }).incident;
}
const prResult = (id, event, extra = {}) =>
  applyResult({
    kind: "pr",
    via: "pr",
    pr_event: event,
    incident_id: id,
    target_repo: "example-upstream/neo",
    branch: "fix/searxng",
    pr_number: 12,
    pr_url: "https://github.com/example-upstream/neo/pull/12",
    pr_state: "open",
    pr_draft: false,
    review_state: "open",
    round: 0,
    max_rounds: 3,
    last_feedback_at: null,
    revise_pending: null,
    stopped: false,
    halted: null,
    summary: `PR ${event}`,
    ...extra,
  });
function labPassed(id, extra = {}) {
  applyResult({
    kind: "fix",
    incident_id: id,
    status: "compare_ready",
    lab: "passed",
    branch: "fix/searxng",
    head_sha: "a".repeat(40),
    compare_url: "https://github.com/example-upstream/neo/compare/master...example-bot:neo:fix/searxng?expand=1",
    pr_title: "fix(searxng): drop stale engines",
    pr_body: "body",
    target_repo: "example-upstream/neo",
    summary: "Lab test passed; open the compare link to create the upstream PR.",
    ...extra,
  });
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
function request(port, method, p, { headers = {}, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", accept: "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}


function labFailed(id, reason = "searxng.service failed on 10.20.30.40 after switch") {
  applyResult({ kind: "fix", incident_id: id, status: "lab_queued", branch: "fix/searxng", head_sha: "b".repeat(40), pr_title: "fix(searxng): drop stale engines", pr_body: "Fixes the engines.", target_repo: "example-upstream/neo", summary: "pushed" });
  applyResult({ kind: "fix", via: "lab", incident_id: id, status: "needs_human", lab: "failed", branch: "fix/searxng", attempts: 2, max_attempts: 2, summary: "Lab test failed after 2 attempt(s)", lab_report: { verdict: "fail", reason } });
}
const drawer = (id) => buildDrawerModel(db.getIncident(id), events(id), db.listFixAttempts(id), redact, { labAuto: true, prAuto: true });

test("drawer: Open PR anyway only behind More when the lab failed and no PR is open; never on the card", () => {
  const inc = incident();
  labFailed(inc.id);
  const html = renderDrawer(drawer(inc.id), "/admin", CAPS);
  assert.match(html, /<details class="kc-more dr-more"><summary[^>]*>More<\/summary>[\s\S]*action="\/admin\/incidents\/\d+\/open-pr-anyway"/);
  assert.doesNotMatch(renderCard(card(inc.id), "/admin", CAPS), /open-pr-anyway/);
  assert.doesNotMatch(renderDrawer(drawer(inc.id), "/admin", { ...CAPS, readOnly: true }), /open-pr-anyway/);
  assert.doesNotMatch(renderDrawer(drawer(inc.id), "/admin", { ...CAPS, pr: false }), /open-pr-anyway/);
  // lab passed → normal path, no override
  const ok = incident();
  labPassed(ok.id);
  assert.doesNotMatch(renderDrawer(drawer(ok.id), "/admin", CAPS), /open-pr-anyway/);
  // PR already open → hidden
  const open = incident();
  labFailed(open.id);
  prResult(open.id, "opened");
  assert.doesNotMatch(renderDrawer(drawer(open.id), "/admin", CAPS), /open-pr-anyway/);
  assert.equal(labFailedPrSource(db.getIncident(open.id), events(open.id)), null);
});

test("route: queues one lab_failed PR job (title format, redacted reason), logs admin event, double click 409, CSRF refused", async () => {
  const inc = incident({ title: "searxng engines failing" });
  labFailed(inc.id);
  await withAdmin(async (port) => {
    const x = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`, { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    assert.equal(jobs("pr", inc.id).length, 0);
    const [r, again] = await Promise.all([
      request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`),
      request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`),
    ]);
    const st = [r.status, again.status].sort();
    assert.deepEqual(st, [200, 409]);
    const third = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`);
    assert.equal(third.status, 409);
    assert.equal(third.json.error, "already_queued");
  });
  const files = jobs("pr", inc.id);
  assert.equal(files.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "pr", files[0]), "utf8"));
  assert.equal(job.kind, "pr");
  assert.equal(job.mode, "lab_failed");
  assert.equal(job.branch, "fix/searxng");
  assert.equal(job.head_sha, "b".repeat(40));
  assert.match(job.pr_title, /^searxng\/fix: drop stale engines$/);
  assert.ok(job.pr_title.length <= 72);
  assert.doesNotMatch(job.lab_failure_reason, /10\.20\.30\.40/);
  assert.match(job.lab_failure_reason, /\[redacted-ip\]/);
  assert.equal(job.auto_merge, undefined);
  const ev = events(inc.id).filter((e) => e.kind === "pr_override");
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /lab test failed/);
  // Not eligible (lab passed) → 409, no job.
  const ok = incident();
  labPassed(ok.id);
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${ok.id}/open-pr-anyway`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "no_failed_branch");
  });
  assert.equal(jobs("pr", ok.id).length, 0);
});

test("PR body: FAILED notice with the redacted reason at the top", () => {
  const t = PR.buildPrText({}, { prTitle: "docker-searxng/fix: drop stale engines", prBody: "Fixes the engines.", labFailed: { reason: "unit failed on 10.20.30.40\nnext line" } });
  const text = typeof t === "string" ? t : t.body;
  const first = text.split("\n").slice(0, 3).join("\n");
  assert.match(first, /Lab test FAILED/);
  assert.match(first, /\[redacted-ip\]/);
  assert.doesNotMatch(text, /10\.20\.30\.40/);
  assert.match(first, /Do not merge/);
});
