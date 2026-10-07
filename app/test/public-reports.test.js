/**
 * Public page: metrics (aggregate only), manual report form (abuse
 * protection, redaction, escaping) and the "never auto-enqueued" rule.
 * Synthetic data only.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-public-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOTRIAGE = "true"; // auto-triage ON: manual reports must still never be enqueued
process.env.OPS_PUBLIC_REPORTS_MIN_FILL_MS = "0";
process.env.OPS_PUBLIC_REPORTS_PER_IP = "4";
process.env.OPS_REDACT_HOSTNAMES = "labhost-a";
for (const d of ["triage", "fix", "push", "lab", "pr", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const P = await import("../lib/public.js");
const Q = await import("../lib/queue.js");
const { renderCard, buildCardModel } = await import("../lib/board-view.js");

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => P._resetPublicForTests());

async function withPublic(fn, { trust = "loopback" } = {}) {
  const app = express();
  app.set("trust proxy", trust);
  app.use(P.createPublicRouter({ adminPath: "/admin" }));
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
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const form = (fields) => new URLSearchParams(fields).toString();
function fresh() {
  const f = P.issueForm(Date.now() - 10_000);
  const [, a, b] = f.token.split(".");
  return { form_token: f.token, answer: String(Number(a) + Number(b)) };
}
const post = (port, fields, headers = {}) => request(port, "POST", "/report", { headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form(fields) });
const queued = () => ["triage", "fix", "lab", "pr", "push", "processing"].flatMap((k) => fs.readdirSync(path.join(tmpDir, "queue", k)));
const manual = () => db.getDb().prepare(`SELECT * FROM incidents WHERE source = 'manual' ORDER BY id`).all();

test("public page: same look as the board, explanation, metrics, form", async () => {
  db.upsertIncident({ report_hash: "pub-1", unit: "docker-searxng.service", severity: "warning", logs_excerpt: "engine failed on labhost-a 192.0.2.10", customer_repo_slug: "acme-corp/site" });
  await withPublic(async (port) => {
    const r = await request(port, "GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.body, /<body class="wide pub">/);
    assert.match(r.body, /\/css\/board\.css/);
    assert.match(r.body, /Autofix incident desk/);
    assert.match(r.body, /incidents received/);
    assert.match(r.body, /median time to fix/);
    assert.match(r.body, /name="website"/); // honeypot
    assert.match(r.body, /What is \d+ \+ \d+\?/);
    for (const leak of ["labhost-a", "192.0.2.10", "acme-corp", "searxng", "engine failed", "pub-1"]) assert.ok(!r.body.includes(leak), leak);
    const m = await request(port, "GET", "/metrics.json");
    const j = JSON.parse(m.body);
    assert.deepEqual(Object.keys(j).sort(), ["fixed", "generatedAt", "last30Days", "medianTimeToFixSec", "open", "received"]);
    assert.ok(j.received >= 1);
    for (const leak of ["labhost-a", "acme-corp", "searxng"]) assert.ok(!m.body.includes(leak), leak);
  });
});

test("metrics: counts + median time to fix, cached briefly", () => {
  P._resetPublicForTests();
  const inc = db.upsertIncident({ report_hash: "pub-fixed", unit: "x" }).incident;
  db.getDb().prepare(`UPDATE incidents SET status='resolved', created_at=?, updated_at=? WHERE id=?`).run("2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", inc.id);
  const a = P.publicMetrics();
  assert.ok(a.fixed >= 1);
  assert.equal(a.medianTimeToFixSec, 7200);
  db.upsertIncident({ report_hash: "pub-later", unit: "x" });
  assert.equal(P.publicMetrics().received, a.received, "cached");
  assert.equal(P.durationText(7200), "2 h");
});

test("manual report: stored untrusted, redacted, escaped; NEVER enqueued even with auto-triage on", async () => {
  await withPublic(async (port) => {
    const r = await post(port, { ...fresh(), title: "<script>alert(1)</script> broken on labhost-a", type: "bug", description: "It fails at 198.51.100.20, mail me at someone@example.org\n<img src=x onerror=alert(1)>", contact: "reach-me@example.org" });
    assert.equal(r.status, 201, r.body);
    assert.match(r.body, /your report was received/);
  });
  const inc = manual().at(-1);
  assert.equal(inc.source, "manual");
  assert.equal(inc.status, "open");
  assert.equal(inc.request_type, "bug");
  assert.match(inc.title, /\[redacted-host\]/);
  assert.match(inc.logs_excerpt, /\[redacted-ip\]/);
  assert.match(inc.logs_excerpt, /\[redacted-email\]/);
  assert.equal(inc.contact, "reach-me@example.org", "contact kept privately");
  assert.deepEqual(queued(), [], "nothing enqueued");
  // The queue refuses an automatic trigger for a manual report …
  assert.throws(() => Q.enqueueJob("triage", inc, { trigger: "auto" }), (e) => e.code === "manual_needs_admin");
  assert.throws(() => Q.enqueueJob("fix", inc, { trigger: "auto" }), (e) => e.code === "manual_needs_admin");
  assert.deepEqual(queued(), []);
  // … an admin may start it by hand (job marked so; the worker checks it).
  const { path: p, job } = Q.enqueueJob("triage", inc);
  assert.equal(job.source, "manual");
  assert.equal(job.enqueued_by, "admin");
  assert.ok(!("contact" in job), "contact never in a job");
  fs.rmSync(p);
  // Card: visible badge, escaped title, no contact.
  const card = buildCardModel(inc, db.listIncidentEvents(inc.id), [], (s) => s, {});
  const html = renderCard(card, "/admin", { readOnly: false, triage: true, fix: true });
  assert.match(html, /class="chip src-badge src-manual"[^>]*>manual bug · untrusted</);
  assert.ok(!html.includes("<script>alert"), "escaped");
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes("reach-me@"), "contact not on the card");
});

test("abuse protection: honeypot, min fill time, wrong answer, reused form, size limits", async () => {
  const before = manual().length;
  await withPublic(async (port) => {
    let r = await post(port, { ...fresh(), title: "t", description: "d", website: "http://spam.example" });
    assert.equal(r.status, 200); // pretends success
    process.env.OPS_PUBLIC_REPORTS_MIN_FILL_MS = "3000";
    const quick = P.issueForm(Date.now());
    const [, a, b] = quick.token.split(".");
    r = await post(port, { form_token: quick.token, answer: String(Number(a) + Number(b)), title: "t", description: "d" });
    assert.equal(r.status, 400);
    assert.match(r.body, /That was quick/);
    process.env.OPS_PUBLIC_REPORTS_MIN_FILL_MS = "0";
    r = await post(port, { ...fresh(), answer: "999", title: "t", description: "d" });
    assert.match(r.body, /answer to the question was wrong/);
  });
  P._resetPublicForTests();
  await withPublic(async (port) => {
    let r = await post(port, { ...fresh(), title: "x".repeat(121), description: "d" });
    assert.equal(r.status, 400);
    const f = fresh();
    r = await post(port, { ...f, title: "ok", description: "d" });
    assert.equal(r.status, 201);
    r = await post(port, { ...f, title: "ok", description: "d" });
    assert.match(r.body, /already submitted/);
    r = await request(port, "POST", "/report", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...fresh(), title: "t", description: "y".repeat(20000) }) });
    assert.equal(r.status, 413, "body limit");
  });
  assert.equal(manual().length, before + 1);
});

test("rate limit per client IP; X-Forwarded-For only from a trusted proxy", async () => {
  // Untrusted peer: a spoofed X-Forwarded-For does not get a fresh bucket.
  await withPublic(
    async (port) => {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await post(port, { ...fresh(), title: `r${i}`, description: "d" }, { "x-forwarded-for": `203.0.113.${i}` })).status);
      assert.deepEqual(codes, [201, 201, 201, 201, 429]);
    },
    { trust: false },
  );
  P._resetPublicForTests();
  // Trusted proxy (loopback): each forwarded client has its own bucket.
  await withPublic(async (port) => {
    for (let i = 0; i < 4; i++) assert.equal((await post(port, { ...fresh(), title: `a${i}`, description: "d" }, { "x-forwarded-for": "198.51.100.7" })).status, 201);
    assert.equal((await post(port, { ...fresh(), title: "a5", description: "d" }, { "x-forwarded-for": "198.51.100.7" })).status, 429);
    assert.equal((await post(port, { ...fresh(), title: "b", description: "d" }, { "x-forwarded-for": "198.51.100.8" })).status, 201);
  });
  assert.deepEqual(queued(), []);
});

test("switched off: no form, POST refused", async () => {
  process.env.OPS_PUBLIC_REPORTS = "false";
  try {
    await withPublic(async (port) => {
      const g = await request(port, "GET", "/");
      assert.ok(!g.body.includes('name="form_token"'));
      const r = await post(port, { ...fresh(), title: "t", description: "d" });
      assert.equal(r.status, 404);
    });
  } finally {
    delete process.env.OPS_PUBLIC_REPORTS;
  }
});
