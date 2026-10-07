/**
 * Admin "Feature / bug request" composer: same-origin guard, target
 * allowlist, a normal fix job, and the markdown reaching Hermes verbatim.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-composer-"));
process.env.OPS_DB_PATH = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DATA_DIR = tmpDir;
process.env.OPS_AUTOFIX_TRIAGE = "true";
process.env.OPS_AUTOFIX_FIX = "true";
process.env.OPS_AUTOFIX_LAB = "true";
process.env.OPS_AUTOFIX_PR = "true";
process.env.OPS_REDACT_HOSTNAMES = "labhost-a";
delete process.env.ADMIN_READ_ONLY;
for (const d of ["triage", "fix", "push", "lab", "pr", "processing", "done", "failed", "control"]) fs.mkdirSync(path.join(tmpDir, "queue", d), { recursive: true });

const express = (await import("express")).default;
const db = await import("../lib/db.js");
const { createAdminRouter } = await import("../lib/admin.js");
const Q = await import("../lib/queue.js");
const W = await import("../../scripts/autofix/worker.mjs");

after(() => {
  db._resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
const post = (port, fields, headers = {}) =>
  request(port, "POST", "/admin/request", { headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers }, body: new URLSearchParams(fields).toString() });
const fixJobs = () => fs.readdirSync(path.join(tmpDir, "queue", "fix"));

// ~60 KiB of markdown with everything the redactor would touch: URLs, an
// email, an IPv4, "::" (IPv6-like), a home path, a host name, long lines.
const LONG = [
  "# Add a `--dry-run` flag",
  "",
  "See https://example.org/docs/flags?x=1 and github:example-upstream/neo#readme.",
  "Contact: maintainer@example.org, host labhost-a, peer 10.20.30.40, path /home/alice/x, rust std::fs::read.",
  "```nix",
  "{ services.autofix.enabled = true; }",
  "```",
  ...Array.from({ length: 800 }, (_, i) => `- item ${i}: ${"lorem ipsum ".repeat(5)}`),
].join("\n");

test("composer page: title, type, target from the allowlist, markdown textarea + preview", async () => {
  await withAdmin(async (port) => {
    const r = await request(port, "GET", "/admin/request");
    assert.equal(r.status, 200);
    assert.match(r.body, /Feature \/ bug request/);
    assert.match(r.body, /<select name="target" required><option value="example-upstream\/neo">/);
    assert.match(r.body, /<textarea id="cmp-body" name="body"/);
    assert.match(r.body, /\/js\/composer\.js/);
  });
});

test("composer: refuses cross-origin, unknown targets and empty requests; nothing stored", async () => {
  const n = db.getDb().prepare(`SELECT COUNT(*) AS n FROM incidents`).get().n;
  await withAdmin(async (port) => {
    let r = await post(port, { title: "x", type: "bug", target: "example-upstream/neo", body: "y" }, { "sec-fetch-site": "cross-site", origin: "https://evil.example.net" });
    assert.equal(r.status, 403);
    r = await post(port, { title: "x", type: "bug", target: "someone/else", body: "y" });
    assert.equal(r.status, 400);
    assert.match(r.body, /Pick a target from the configured targets/);
    r = await post(port, { title: "x", type: "bug", target: "example-upstream/neo", body: "  " });
    assert.equal(r.status, 400);
  });
  assert.equal(db.getDb().prepare(`SELECT COUNT(*) AS n FROM incidents`).get().n, n);
  assert.deepEqual(fixJobs(), []);
});

test("composer: creates a trusted admin incident + a normal fix job; the request reaches the Hermes prompt verbatim", async () => {
  assert.ok(LONG.length > 55_000 && LONG.length < 64 * 1024, String(LONG.length));
  let loc;
  await withAdmin(async (port) => {
    const r = await post(port, { title: "Add a --dry-run flag", type: "feature", target: "example-upstream/neo", body: LONG });
    assert.equal(r.status, 303, r.body);
    loc = r.headers.location;
  });
  assert.match(loc, /Request%20%23\d+%20created/);
  const inc = db.getDb().prepare(`SELECT * FROM incidents WHERE source = 'admin' ORDER BY id DESC`).get();
  assert.equal(inc.status, "fixing");
  assert.equal(inc.class, "software");
  assert.equal(inc.target_repo, "example-upstream/neo");
  assert.equal(inc.request_body, LONG);
  const jobs = fixJobs();
  assert.equal(jobs.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(tmpDir, "queue", "fix", jobs[0]), "utf8"));
  assert.equal(job.kind, "fix");
  assert.equal(job.source, "admin");
  assert.equal(job.enqueued_by, "admin");
  assert.equal(job.target_repo, "example-upstream/neo");
  assert.equal(job.request_type, "feature");
  assert.equal(job.request_body, LONG, "job carries the request byte for byte (no redaction, no truncation)");
  // Prompt section (fix / triage / lab prompts) has the full text.
  const section = W.requestSection(job).join("\n");
  assert.ok(section.includes(LONG));
  assert.match(section, /Admin feature request \(trusted/);
  // Follow-up jobs (lab, lab retry, revise) carry it too.
  assert.equal(W.carried(job).request_body, LONG);
  assert.equal(Q.redactedIncidentFields(inc).request_body, LONG);
  // A reporter / manual incident never gets request_body into a job.
  const rep = db.upsertIncident({ report_hash: "cmp-rep", unit: "x", logs_excerpt: "y" }).incident;
  assert.ok(!("request_body" in Q.buildJobPayload("fix", rep)));
  assert.deepEqual(W.requestSection({ ...job, source: "manual" }), []);
  fs.rmSync(path.join(tmpDir, "queue", "fix", jobs[0]));
});

test("composer: board card shows the admin badge", async () => {
  await withAdmin(async (port) => {
    const r = await request(port, "GET", "/admin/");
    assert.match(r.body, /class="chip src-badge src-admin"[^>]*>admin feature</);
    assert.match(r.body, /Add a --dry-run flag/);
  });
});
