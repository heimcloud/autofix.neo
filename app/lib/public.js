/**
 * Public (unauthenticated) page: what this is, aggregate metrics, and a manual
 * bug / feature report form.
 *
 *  - Metrics are counts and a median only (no hosts, slugs, reporter ids,
 *    titles or excerpts), cached for METRICS_TTL_MS.
 *  - Manual reports land as source=manual (untrusted) incidents and are never
 *    enqueued: no auto-triage, the queue refuses an automatic trigger and the
 *    worker refuses a manual job an admin did not start (queue.js, worker.mjs).
 *  - Abuse protection: per-IP rate limit (in memory; client IP from
 *    X-Forwarded-For only when the peer is a trusted proxy, see server.js
 *    `trust proxy`), a global daily cap, field/body size limits, a honeypot
 *    field, a minimum fill time and a no-JS arithmetic question, both bound
 *    to an HMAC-signed form token. Text is redacted server-side (redact.js)
 *    before it is stored and HTML-escaped on every render.
 *  - The optional contact is stored privately (admin drawer only).
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { getDb, createRequestIncident, listDistinctCustomerRepoSlugs } from "./db.js";
import { redactIdentifyingDetails, mergeKnownSlugs, getExtraRedactSlugs } from "./redact.js";
import { escapeHtml as esc, publicLayout } from "./layout.js";

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
export const LIMITS = {
  title: 120,
  body: 8000,
  contact: 200,
  bodyBytes: "16kb",
};
const env = process.env;
const cfg = () => ({
  enabled: !["0", "false", "no", "off"].includes(String(env.OPS_PUBLIC_REPORTS ?? "true").toLowerCase()),
  perIp: num(env.OPS_PUBLIC_REPORTS_PER_IP, 5), // POST attempts per window per IP (wrong answers count too)
  windowMs: num(env.OPS_PUBLIC_REPORTS_WINDOW_MS, 10 * 60_000),
  perDay: num(env.OPS_PUBLIC_REPORTS_PER_DAY, 50), // all IPs together
  minFillMs: num(env.OPS_PUBLIC_REPORTS_MIN_FILL_MS, 3000),
  maxAgeMs: 2 * 60 * 60_000,
});
const METRICS_TTL_MS = 60_000;

// Per-process secret for the form token (a restart just invalidates open forms).
const SECRET = crypto.randomBytes(32);
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");

/** Form token: issue time + arithmetic question, signed. */
export function issueForm(now = Date.now()) {
  const a = 2 + crypto.randomInt(8);
  const b = 1 + crypto.randomInt(9);
  const nonce = crypto.randomBytes(9).toString("base64url");
  const payload = `${now}.${a}.${b}.${nonce}`;
  return { token: `${payload}.${sign(payload)}`, question: `${a} + ${b}` };
}

/** @returns {null | string} error code */
export function checkForm(token, answer, now = Date.now(), c = cfg()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 5) return "bad_token";
  const [ts, a, b, nonce, mac] = parts;
  const payload = `${ts}.${a}.${b}.${nonce}`;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(String(mac));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "bad_token";
  const age = now - Number(ts);
  if (!(age >= c.minFillMs)) return "too_fast";
  if (age > c.maxAgeMs) return "expired";
  if (String(answer ?? "").trim() !== String(Number(a) + Number(b))) return "wrong_answer";
  return null;
}

// ------------------------------------------------------------- rate limit
const hits = new Map(); // ip -> [timestamps]
let day = { key: "", n: 0 };
const usedNonces = new Map(); // nonce -> expiry (one submission per form)

export function _resetPublicForTests() {
  hits.clear();
  usedNonces.clear();
  day = { key: "", n: 0 };
  metricsCache = null;
}

function dailyCapHit(now = Date.now(), c = cfg()) {
  const k = new Date(now).toISOString().slice(0, 10);
  if (day.key !== k) day = { key: k, n: 0 };
  return day.n >= c.perDay;
}

function rateLimited(ip, now = Date.now(), c = cfg()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < c.windowMs);
  if (list.length >= c.perIp) {
    hits.set(ip, list);
    return "rate_limited";
  }
  list.push(now);
  hits.set(ip, list);
  // Bound memory: forget idle IPs.
  if (hits.size > 5000) for (const [key, v] of hits) if (!v.some((t) => now - t < c.windowMs)) hits.delete(key);
  return null;
}

function nonceUsed(token, now = Date.now()) {
  const nonce = String(token || "").split(".")[3] || "";
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return true;
  usedNonces.set(nonce, now + 3 * 60 * 60_000);
  return false;
}

// ---------------------------------------------------------------- metrics
let metricsCache = null;
/** Aggregate, anonymized numbers only. */
export function publicMetrics(now = Date.now()) {
  if (metricsCache && now - metricsCache.at < METRICS_TTL_MS) return metricsCache.data;
  const db = getDb();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const received = one(`SELECT COUNT(*) AS n FROM incidents`).n;
  const last30 = one(`SELECT COUNT(*) AS n FROM incidents WHERE julianday(created_at) >= julianday('now', '-30 days')`).n;
  const fixed = one(`SELECT COUNT(*) AS n FROM incidents WHERE status = 'resolved'`).n;
  const open = one(`SELECT COUNT(*) AS n FROM incidents WHERE status NOT IN ('resolved', 'closed')`).n;
  const durs = db
    .prepare(`SELECT (julianday(updated_at) - julianday(created_at)) * 86400 AS s FROM incidents WHERE status = 'resolved' AND updated_at IS NOT NULL ORDER BY s`)
    .all()
    .map((r) => Number(r.s))
    .filter((s) => Number.isFinite(s) && s >= 0);
  let median = null;
  if (durs.length) {
    const m = Math.floor(durs.length / 2);
    median = Math.round(durs.length % 2 ? durs[m] : (durs[m - 1] + durs[m]) / 2);
  }
  const data = { received, last30Days: last30, fixed, open, medianTimeToFixSec: median, generatedAt: new Date(now).toISOString() };
  metricsCache = { at: now, data };
  return data;
}

export function durationText(sec) {
  if (sec == null) return "—";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}

// ------------------------------------------------------------------- page
const ERRORS = {
  bad_token: "The form expired. Please try again.",
  expired: "The form expired. Please try again.",
  too_fast: "That was quick. Please take a moment and submit again.",
  wrong_answer: "The answer to the question was wrong.",
  rate_limited: "Too many reports from your address. Please try again later.",
  daily_cap: "Too many reports today. Please try again tomorrow.",
  missing: "Please give a title and a description.",
  too_long: `Title max ${LIMITS.title}, description max ${LIMITS.body}, contact max ${LIMITS.contact} characters.`,
  reused: "This form was already submitted. Please use the new form.",
  disabled: "Manual reports are switched off on this host.",
};

export function renderPublicPage({ metrics, form, enabled, notice = "", error = "", values = {}, adminPath = "" }) {
  const m = metrics;
  const v = (k) => esc(String(values[k] ?? ""));
  const stat = (label, value, hint) => `<div class="pub-stat"><span class="pub-num">${esc(String(value))}</span><span class="pub-lbl">${esc(label)}</span>${hint ? `<span class="pub-hint">${esc(hint)}</span>` : ""}</div>`;
  const formHtml = enabled
    ? `<form class="pub-form" method="post" action="/report" autocomplete="off">
      <input type="hidden" name="form_token" value="${esc(form.token)}" />
      <div class="pub-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off" /></label></div>
      <div class="pub-row">
        <label class="pub-field pub-grow">Title<input name="title" required maxlength="${LIMITS.title}" value="${v("title")}" placeholder="Short summary" /></label>
        <label class="pub-field">Type<select name="type">
          <option value="bug"${values.type === "feature" ? "" : " selected"}>Bug</option>
          <option value="feature"${values.type === "feature" ? " selected" : ""}>Feature idea</option>
        </select></label>
      </div>
      <label class="pub-field">What happened? What did you expect?<textarea name="description" required rows="7" maxlength="${LIMITS.body}" placeholder="Steps, error messages, what you expected…">${v("description")}</textarea></label>
      <div class="pub-row">
        <label class="pub-field pub-grow">Contact (optional, private: only the maintainer sees it)<input name="contact" maxlength="${LIMITS.contact}" value="${v("contact")}" placeholder="e-mail or handle" /></label>
        <label class="pub-field">What is ${esc(form.question)}?<input name="answer" required inputmode="numeric" size="4" /></label>
      </div>
      <p class="pub-small">Do not paste passwords, tokens or personal data. Identifying details (addresses, e-mails, host names) are removed before the report is stored. Reports are reviewed by a human before anything happens.</p>
      <button class="kbtn primary" type="submit">Send report</button>
    </form>`
    : `<p class="pub-small">Manual reports are switched off on this host.</p>`;
  return publicLayout({
    title: "Autofix",
    adminPath,
    body: `<div class="pub-wrap">
    <section class="pub-hero">
      <h1>Autofix incident desk</h1>
      <p class="pub-lead">Neo hosts report failed updates and broken services here automatically. Each incident is triaged by an AI agent; fixable ones get a code fix on a branch, an automated lab test with rollback, and a pull request to the upstream project. A human reviews every pull request: nothing is merged automatically.</p>
    </section>
    <section class="pub-stats" aria-label="Public metrics">
      ${stat("incidents received", m.received)}
      ${stat("in the last 30 days", m.last30Days)}
      ${stat("fixed", m.fixed)}
      ${stat("open", m.open)}
      ${stat("median time to fix", durationText(m.medianTimeToFixSec), "report → resolved")}
    </section>
    <section class="pub-card">
      <h2>Report a bug or suggest a feature</h2>
      ${notice ? `<p class="pub-flash ok">${esc(notice)}</p>` : ""}
      ${error ? `<p class="pub-flash err">${esc(error)}</p>` : ""}
      ${formHtml}
    </section>
    <p class="pub-small pub-foot">Numbers are aggregate counts only and refresh every minute. <a href="/health">Health</a></p>
  </div>`,
  });
}

// ----------------------------------------------------------------- router
function clientIp(req) {
  // req.ip honours `trust proxy`: X-Forwarded-For only from a trusted peer.
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

export function createPublicRouter({ adminPath = "" } = {}) {
  const router = Router();
  const page = (res, status, extra = {}) =>
    res
      .status(status)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderPublicPage({ metrics: publicMetrics(), form: issueForm(), enabled: cfg().enabled, adminPath, ...extra }));

  router.get("/", (_req, res) => page(res, 200));
  router.get("/metrics.json", (_req, res) => res.set("Cache-Control", "public, max-age=60").json(publicMetrics()));

  router.post("/report", express.urlencoded({ extended: false, limit: LIMITS.bodyBytes, parameterLimit: 20 }), (req, res) => {
    const c = cfg();
    if (!c.enabled) return page(res, 404, { error: ERRORS.disabled });
    const b = req.body || {};
    const values = { title: String(b.title || "").slice(0, LIMITS.title), type: b.type === "feature" ? "feature" : "bug", description: String(b.description || "").slice(0, LIMITS.body), contact: String(b.contact || "").slice(0, LIMITS.contact) };
    const limited = rateLimited(clientIp(req), Date.now(), c);
    if (limited) return page(res, 429, { error: ERRORS[limited], values });
    // Honeypot: pretend success, store nothing.
    if (String(b.website || "").trim()) return page(res, 200, { notice: "Thanks, your report was received." });
    const formErr = checkForm(b.form_token, b.answer, Date.now(), c);
    if (formErr) return page(res, 400, { error: ERRORS[formErr], values });
    const title = String(b.title || "").trim();
    const desc = String(b.description || "").trim();
    const contact = String(b.contact || "").trim();
    if (!title || !desc) return page(res, 400, { error: ERRORS.missing, values });
    if (title.length > LIMITS.title || desc.length > LIMITS.body || contact.length > LIMITS.contact) return page(res, 400, { error: ERRORS.too_long, values });
    if (dailyCapHit(Date.now(), c)) return page(res, 429, { error: ERRORS.daily_cap, values });
    if (nonceUsed(b.form_token)) return page(res, 400, { error: ERRORS.reused });
    const knownSlugs = mergeKnownSlugs(listDistinctCustomerRepoSlugs(), ...getExtraRedactSlugs());
    const red = (s) => redactIdentifyingDetails(s, { knownSlugs });
    // Control characters out, then redact (title single line).
    const clean = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    createRequestIncident({
      source: "manual",
      title: red(clean(title).replace(/\s+/g, " ")),
      requestType: b.type === "feature" ? "feature" : "bug",
      logsExcerpt: red(clean(desc)),
      contact: contact ? clean(contact) : null,
    });
    day.n += 1;
    metricsCache = null;
    return page(res, 201, { notice: "Thanks, your report was received. A human will look at it." });
  });
  return router;
}
