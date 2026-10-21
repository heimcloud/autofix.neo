/**
 * v0.3.8 IPv4 redaction gate: narrow allowlist, masked file:line on the
 * card / event, gate hint in the fix prompt, "Retry fix with gate hint".
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-gate-ipv4-"));
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
const R = await import("../lib/redact.js");
const W = await import("../../scripts/autofix/worker.mjs");
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
  return db.upsertIncident({ report_hash: `gate-${n}`, unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine x failed", ...extra }).incident;
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




const IP = ["10", "20", "30", "40"].join(".");
const ip = (...o) => o.join(".");

test("gate allowlist: loopback, unspecified, RFC 5737 pass; private / CGNAT / link-local / public fail closed; non-addresses ignored", () => {
  for (const ok of ["0.0.0.0", "listen 0.0.0.0:80", "0.0.0.0/0", "127.0.0.1", "127.0.0.53:53", "192.0.2.10", "198.51.100.1/32", "203.0.113.200", "1.2.3.4.5", "999.1.1.1", "hash 698.744.152.302", "v2.57.46.71", "6.648.975.283"]) {
    assert.deepEqual(R.findIdentifierHits(ok), [], ok);
  }
  const cases = [
    [IP, "private", "10.x.x.x"],
    [`${ip(10, 0, 0, 0)}/8`, "private", "10.x.x.x"],
    [`allowedIPs = [ "${ip(172, 16, 0, 0)}/12" ]`, "private", "172.x.x.x"],
    [ip(192, 168, 1, 20), "private", "192.x.x.x"],
    ["100.64.0.0/10", "cgnat", "100.x.x.x"],
    ["169.254.1.1", "link_local", "169.254.x.x"],
    ["1.1.1.1", "public", "x.x.x.x"],
    ["version 1.2.3.4", "public", "x.x.x.x"],
    ["224.0.0.1", "reserved", "x.x.x.x"],
    ["192.0.3.1", "public", "x.x.x.x"],
  ];
  for (const [t, cls, masked] of cases) {
    assert.deepEqual(R.findIdentifierHits(t), ["ipv4"], t);
    const [m] = R.ipv4GateMatches(t);
    assert.equal(m.cls, cls, t);
    assert.equal(m.masked, masked, t);
  }
});

const DIFF = [
  "diff --git a/nix/lib/firewall.nix b/nix/lib/firewall.nix",
  "index 1111111..2222222 100644",
  "--- a/nix/lib/firewall.nix",
  "+++ b/nix/lib/firewall.nix",
  "@@ -10,4 +10,5 @@ in {",
  `   trusted = [ "${IP}" ];`,
  `-  bind = "${ip(192, 168, 1, 2)}";`,
  `+  bind = "127.0.0.1";`,
  `+  peer = "${IP}";`,
  "   ok = true;",
].join("\n");

test("worker locates gate hits: file:line, side (added / context / removed), masked class, no raw value", () => {
  const hits = W.locateIpv4("diff", DIFF, []);
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line}:${h.side}:${h.cls}:${h.masked}`), [
    "nix/lib/firewall.nix:10:context:private:10.x.x.x",
    "nix/lib/firewall.nix:11:removed:private:192.x.x.x",
    "nix/lib/firewall.nix:12:added:private:10.x.x.x",
  ]);
  assert.throws(() => W.scanOutbound("diff", DIFF, []), (err) => {
    assert.match(err.message, /^redaction_fail_closed:diff:ipv4 at nix\/lib\/firewall\.nix:10 \(context, private 10\.x\.x\.x\); nix\/lib\/firewall\.nix:11 \(removed/);
    assert.doesNotMatch(err.message + JSON.stringify(err.gate_hits), new RegExp(`${IP}|${ip(192, 168, 1, 2)}`.replace(/\./g, "\\.")));
    return true;
  });
  // commit message / PR text: line of that text
  const m = W.locateIpv4("commit_message", `fix: x\n\npeer ${IP}`, []);
  assert.deepEqual(m.map((h) => [h.scope, h.line, h.file]), [["commit_message", 3, null]]);
});

test("fix prompt carries the gate rule; a gate retry lists the masked locations and drops anything raw", () => {
  const cfg = { target: { upstream: "example-upstream/neo" }, baseRef: "dev", maxAttempts: 2 };
  const job = { incident_id: 57, report_hash: "h", unit: "u", severity: "warning", class: "x", neo_version: "1" };
  const plain = W.fixPrompt(job, "/tmp/neo", cfg, 1, "");
  assert.ok(plain.includes(W.GATE_HINT));
  assert.match(W.GATE_HINT, /never hardcode an IP/);
  assert.match(W.GATE_HINT, /192\.0\.2\.x/);
  assert.doesNotMatch(plain, /BLOCKED by the redaction gate/);
  const retry = W.fixPrompt({ ...job, gate_retry: { label: "diff", hits: [
    { scope: "diff", file: "nix/lib/firewall.nix", line: 12, side: "added", cls: "private", masked: "10.x.x.x" },
    { scope: "diff", file: `nix/${IP}.nix`, line: 3, side: "added", cls: "private", masked: IP },
  ] } }, "/tmp/neo", cfg, 1, "");
  assert.match(retry, /BLOCKED by the redaction gate \(diff: ipv4\)/);
  assert.match(retry, /- nix\/lib\/firewall\.nix:12 \(added, private 10\.x\.x\.x\)/);
  assert.doesNotMatch(retry, /10\.20\.30\.40/);
  const skill = fs.readFileSync(new URL("../../skills/autofix-fix/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /never hardcode an IP/);
  assert.match(skill, /192\.0\.2\.x/);
  assert.match(skill, /Gate retry/);
});

function gateBlocked(id, extra = {}) {
  applyResult({ kind: "fix", incident_id: id, status: "redaction_blocked", branch: "fix/peer", summary: "redaction_fail_closed:diff:ipv4 at nix/lib/firewall.nix:12 (added, private 10.x.x.x)", hits: ["ipv4"], gate_hits: [{ scope: "diff", file: "nix/lib/firewall.nix", line: 12, side: "added", cls: "private", masked: "10.x.x.x" }], ...extra });
}

test("card / drawer: masked file:line + class, Retry fix with gate hint offered (never started on its own)", () => {
  const inc = incident();
  gateBlocked(inc.id);
  assert.equal(jobs("fix", inc.id).length, 0, "no fix job started automatically");
  const h = hi(inc.id);
  assert.equal(h.reasons[0].code, "redaction_blocked");
  assert.deepEqual(h.reasons[0].actions.slice(0, 2), ["retry_gate_fix", "start_fix"]);
  const html = renderCard(card(inc.id), "/admin", CAPS);
  assert.match(html, /Redaction gate blocked the push/);
  assert.match(html, /class="kc-gate">IPv4 \(diff\) at nix\/lib\/firewall\.nix:12 \(added, private 10\.x\.x\.x\)/);
  assert.match(html, /action="\/admin\/incidents\/\d+\/retry-gate-fix"/);
  assert.match(html, />Retry fix with gate hint</);
  assert.ok(events(inc.id).some((e) => e.kind === "fix_result" && /nix\/lib\/firewall\.nix:12 \(added, private 10\.x\.x\.x\)/.test(e.message)));
  // Legacy #57-style result (before v0.3.8): no locations, retry still offered.
  const old = incident();
  applyResult({ kind: "fix", incident_id: old.id, status: "redaction_blocked", branch: "fix/x", summary: "redaction_fail_closed:diff:ipv4", hits: ["ipv4"] });
  assert.match(renderCard(card(old.id), "/admin", CAPS), /IPv4 \(diff\); location not recorded[\s\S]*retry-gate-fix/);
  // Other gate hits (email) keep the plain reason.
  const em = incident();
  applyResult({ kind: "fix", incident_id: em.id, status: "redaction_blocked", summary: "redaction_fail_closed:diff:email", hits: ["email"] });
  assert.doesNotMatch(renderCard(card(em.id), "/admin", CAPS), /retry-gate-fix/);
});

test("route retry-gate-fix: fix job with sanitized gate_retry from the DB; 409 when not gate-blocked; CSRF refused", async () => {
  const inc = incident();
  gateBlocked(inc.id, { gate_hits: [{ scope: "diff", file: "nix/lib/firewall.nix", line: 12, side: "added", cls: "private", masked: "10.x.x.x" }, { scope: "diff", file: `x/${IP}`, line: 1, side: "bogus", cls: "private", masked: IP }] });
  await withAdmin(async (port) => {
    const x = await request(port, "POST", `/admin/incidents/${inc.id}/retry-gate-fix`, { headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
    assert.equal(x.status, 403);
    const r = await request(port, "POST", `/admin/incidents/${inc.id}/retry-gate-fix`, { body: JSON.stringify({ gate_retry: { hits: [{ file: "evil" }] } }) });
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /gate hint/);
  });
  const files = jobs("fix", inc.id);
  assert.equal(files.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "fix", files[0]), "utf8"));
  assert.equal(job.gate_retry.label, "diff");
  assert.equal(job.gate_retry.hits.length, 2);
  assert.equal(job.gate_retry.hits[0].file, "nix/lib/firewall.nix");
  assert.equal(job.gate_retry.hits[1].file, null);
  assert.equal(job.gate_retry.hits[1].masked, "x.x.x.x");
  assert.equal(job.gate_retry.hits[1].side, null);
  assert.doesNotMatch(JSON.stringify(job), /10\.20\.30\.40/);
  assert.equal(db.getIncident(inc.id).status, "fixing");
  assert.ok(events(inc.id).some((e) => e.kind === "fix_enqueued" && /"gate_retry":true/.test(e.meta_json || "")));
  const other = incident();
  labPassed(other.id);
  await withAdmin(async (port) => {
    const r = await request(port, "POST", `/admin/incidents/${other.id}/retry-gate-fix`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "not_gate_blocked");
  });
  assert.equal(jobs("fix", other.id).length, 0);
});
