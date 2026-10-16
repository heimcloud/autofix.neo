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
const { prOverrideSource, prOverrideView } = await import("../lib/pr-override.js");
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



const A = "a".repeat(40);
const Bsha = "b".repeat(40);
const BR = "fix/additional-disks-zfs-mount-race";
const fail2 = (reason = "zfs mount raced on 10.20.30.40; 9/11 checks passed") => ({ verdict: "fail", reason, checks: [], generation: { before: 41, after: 41, restored: true } });

/** #53 as seen live: protected change, admin approval, attempt 1 fail → Hermes retry → attempt 2/2 fail, needs_human. */
function history53(id, { tail = [] } = {}) {
  applyResult({ kind: "fix", incident_id: id, status: "lab_approval_needed", branch: BR, head_sha: A, pr_title: "fix(disko): wait for the zfs pool before mounting", pr_body: "Orders the mount after zfs-import.", target_repo: "example-upstream/neo", protected: { paths: ["nix/modules/core"], core: true }, summary: `Branch ${BR} was pushed to the fork; the automated lab test did not run because the change touches nix/modules/core.` });
  db.addIncidentEvent(id, "lab_approved", "Admin approved the protected lab test", { approved_by: "admin", branch: BR, head_sha: A });
  db.addIncidentEvent(id, "lab_enqueued", "Lab test queued", { branch: BR, head_sha: A });
  applyResult({ kind: "fix", via: "lab", incident_id: id, status: "lab_retry", lab: "failed", branch: BR, attempts: 1, max_attempts: 2, lab_report: fail2("first try"), summary: "Lab test failed (8/11). Retrying." });
  applyResult({ kind: "fix", incident_id: id, status: "lab_queued", branch: BR, head_sha: Bsha, pr_title: "fix(disko): wait for the zfs pool before mounting", pr_body: "Orders the mount after zfs-import (v2).", target_repo: "example-upstream/neo", attempt: 2, summary: "pushed attempt 2" });
  applyResult({ kind: "fix", via: "lab", incident_id: id, status: "needs_human", lab: "failed", branch: BR, attempts: 2, max_attempts: 2, target_repo: "example-upstream/neo", lab_report: fail2(), summary: "Lab test failed after 2 attempt(s) (9/11 checks passed, generation 41 → lab → 41 (restored)): zfs mount raced" });
  for (const t of tail) t(id);
}
const inc53 = () => incident({ unit: "neo-disko-additionalDisks.service", title: "additionalDisks mount fails at boot" });
const drawer = (id, c = CAPS) => renderDrawer(buildDrawerModel(db.getIncident(id), events(id), db.listFixAttempts(id), redact, { labAuto: true, prAuto: true }), "/admin", c);
const ENABLED = /<details class="kc-more dr-more" data-has-override><summary[^>]*>More<\/summary>[\s\S]*?action="\/admin\/incidents\/\d+\/open-pr-anyway"[\s\S]*?<button[^>]*>Open PR anyway \(lab failed\)<\/button>/;

test("#53 exact state (attempt 2/2 failed, generation restored, needs_human): More is enabled and holds the override", () => {
  const inc = inc53();
  history53(inc.id);
  assert.equal(db.getIncident(inc.id).status, "needs_human");
  const html = drawer(inc.id);
  assert.match(html, ENABLED);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Open PR/);
  assert.doesNotMatch(html, /data-pr-override-reason/);
  assert.doesNotMatch(renderCard(card(inc.id), "/admin", CAPS), /open-pr-anyway|dr-more/);
  const s = prOverrideSource(db.getIncident(inc.id), events(inc.id));
  assert.equal(s.ok, true);
  assert.equal(s.mode, "lab_failed");
  assert.equal(s.head_sha, Bsha, "head of attempt 2, not the approved attempt 1");
  // The More toggle is styled with the board palette (v0.3.6 used undefined vars → looked disabled).
  const css = fs.readFileSync(new URL("../public/css/board.css", import.meta.url), "utf8");
  const rule = css.match(/\.kc-more > summary \{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /var\(--(line|muted),/);
  assert.match(rule, /cursor: pointer/);
});

test("#53 variants: a later non-lab fix_result, a worker lab error without branch, a build failure, branch only on the row", () => {
  // Hermes attempt result after the lab failure (no via, still needs_human)
  const a = inc53();
  history53(a.id, { tail: [(id) => applyResult({ kind: "fix", incident_id: id, status: "needs_human", summary: "Hermes: no further change" })] });
  assert.match(drawer(a.id), ENABLED);
  // Worker crash on the lab job: failureResult has via lab / lab error but no branch
  const b = inc53();
  history53(b.id, { tail: [(id) => applyResult({ kind: "fix", via: "lab", incident_id: id, status: "lab_error", lab: "error", summary: "worker error: boom" })] });
  assert.match(drawer(b.id), ENABLED);
  // Build failure in the lab (lab error with the branch, stored in failed/)
  const c = inc53();
  history53(c.id, { tail: [(id) => applyResult({ kind: "fix", via: "lab", incident_id: id, status: "lab_error", lab: "error", branch: BR, lab_report: { verdict: "error", reason: "nixos-rebuild build failed" }, summary: "Lab test error: build failed" })] });
  assert.match(drawer(c.id), /Open PR anyway \(lab error\)/);
  // Branch only in draft_branch (old rows)
  const d = incident({ unit: "neo-disko-additionalDisks.service" });
  db.updateIncident(d.id, { draft_branch: BR, status: "needs_human" });
  const v = prOverrideView(db.getIncident(d.id), events(d.id));
  assert.equal(v.ok, true);
  assert.equal(v.lab, "never");
  assert.match(drawer(d.id), /Open PR anyway \(not lab-tested\)/);
});

test("#47-like: open PR / stale PR job / PR off / not allowlisted show the reason in More; closed PR allows a new one; read-only hides", () => {
  const open = inc53();
  history53(open.id);
  prResult(open.id, "opened", { branch: BR });
  let html = drawer(open.id);
  assert.match(html, /data-pr-override-reason>[^<]*PR #12 is already open/);
  assert.doesNotMatch(html, /open-pr-anyway/);
  prResult(open.id, "closed", { pr_state: "closed", branch: BR });
  assert.match(drawer(open.id), /data-has-override/);
  // stale PR job left in processing/
  const st = inc53();
  history53(st.id);
  const stale = path.join(tmpDir, "queue", "processing", `pr-${st.id}-2026-10-01T00-00-00-000Z.json`);
  fs.writeFileSync(stale, "{}");
  html = drawer(st.id);
  assert.match(html, /already queued or running \(pr-\d+-2026-10-01T00-00-00-000Z\.json since /);
  fs.rmSync(stale);
  assert.match(drawer(st.id), ENABLED);
  // PR automation off (caps) → reason, no form
  html = drawer(st.id, { ...CAPS, pr: false });
  assert.match(html, /PR automation is off/);
  assert.doesNotMatch(html, /open-pr-anyway/);
  // target not allowlisted
  const t = inc53();
  history53(t.id);
  applyResult({ kind: "fix", via: "lab", incident_id: t.id, status: "needs_human", lab: "failed", branch: BR, target_repo: "someone/else", lab_report: fail2(), summary: "fail" });
  assert.match(drawer(t.id), /not allowlisted/);
  assert.doesNotMatch(drawer(st.id, { ...CAPS, readOnly: true }), /dr-more/);
  // no fix branch at all → nothing
  const none = incident();
  assert.doesNotMatch(drawer(none.id), /dr-more/);
});

test("manual report with a fix branch and no lab run: not_tested job, ops/ title fallback", async () => {
  const m = incident({ source: "manual", unit: null, title: "Disk mount fails at boot", contact: "x" });
  applyResult({ kind: "fix", incident_id: m.id, status: "lab_queued", branch: "fix/manual-mount", head_sha: A, target_repo: "example-upstream/neo", summary: "pushed" });
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${m.id}/open-pr-anyway`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /not lab-tested/);
  });
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "pr", jobs("pr", m.id)[0]), "utf8"));
  assert.equal(job.mode, "not_tested");
  assert.equal(job.lab_failure_reason, undefined);
  assert.match(job.pr_title, /^ops\/fix: /);
  const t = PR.buildPrText({}, { prTitle: job.pr_title, prBody: "b", untested: true, labNeverRan: true });
  assert.match((typeof t === "string" ? t : t.body).split("\n")[0], /NOT lab-tested\.\*\* The lab test never ran/);
});

test("route on #53: one lab_failed job (title, redacted reason, head of attempt 2), admin event, double click 409, CSRF 403", async () => {
  const inc = inc53();
  history53(inc.id);
  await withAdmin(async (port) => {
    const x = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`, { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    assert.equal(jobs("pr", inc.id).length, 0);
    const [r, again] = await Promise.all([
      request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`),
      request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`),
    ]);
    assert.deepEqual([r.status, again.status].sort(), [200, 409]);
    const third = await request(port, "POST", `/admin/incidents/${inc.id}/open-pr-anyway`);
    assert.equal(third.status, 409);
    assert.equal(third.json.error, "already_queued");
    assert.match(third.json.message, /already queued or running/);
  });
  const files = jobs("pr", inc.id);
  assert.equal(files.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "pr", files[0]), "utf8"));
  assert.equal(job.mode, "lab_failed");
  assert.equal(job.branch, BR);
  assert.equal(job.head_sha, Bsha);
  assert.match(job.pr_title, /^disko-additionalDisks\/fix: |^[a-zA-Z-]+\/fix: /);
  assert.ok(job.pr_title.length <= 72);
  assert.doesNotMatch(job.lab_failure_reason, /10\.20\.30\.40/);
  assert.match(job.lab_failure_reason, /\[redacted-ip\]/);
  const ev = events(inc.id).filter((e) => e.kind === "pr_override");
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /although the lab test failed/);
  // Ineligible (PR open) → 409 with the reason, no job.
  const o = inc53();
  history53(o.id);
  prResult(o.id, "opened", { branch: BR });
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${o.id}/open-pr-anyway`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "pr_open");
    assert.match(r.json.message, /PR #12 is already open/);
  });
});

test("lab passed → plain Open PR (mode open)", () => {
  const p = incident();
  labPassed(p.id);
  const s = prOverrideSource(db.getIncident(p.id), events(p.id));
  assert.equal(s.ok, true);
  assert.equal(s.mode, "open");
  assert.match(drawer(p.id), />Open PR<\/button>/);
});

test("PR body: FAILED notice with the redacted reason at the top", () => {
  const t = PR.buildPrText({}, { prTitle: "searxng/fix: drop stale engines", prBody: "Fixes the engines.", labFailed: { reason: "unit failed on 10.20.30.40\nnext line" } });
  const text = typeof t === "string" ? t : t.body;
  const first = text.split("\n").slice(0, 3).join("\n");
  assert.match(first, /Lab test FAILED/);
  assert.match(first, /\[redacted-ip\]/);
  assert.doesNotMatch(text, /10\.20\.30\.40/);
  assert.match(first, /Do not merge/);
});
