/**
 * neo-autofix — incident ingest API + Tinyauth-gated admin UI.
 */
import fs from "node:fs";
import express from "express";
import { getDb, getDbPath, upsertIncident, addIncidentEvent } from "./lib/db.js";
import { enqueueJob, getForkPushTokenState } from "./lib/queue.js";
import { ingestResultsDir, startResultsIngestLoop } from "./lib/results.js";
import { createAdminRouter, getAdminConfig } from "./lib/admin.js";
import { getGithubTokenConfigured, getAllowlist } from "./lib/github.js";
import { createPublicRouter } from "./lib/public.js";

const PORT = Number(process.env.PORT || 3000);
// Ingest secret: OPS_INGEST_SECRET_FILE (a file mounted into the container,
// read once at start) wins over the inline OPS_INGEST_SECRET.
function readIngestSecret() {
  const f = String(process.env.OPS_INGEST_SECRET_FILE || "").trim();
  if (f) {
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch (err) {
      console.error(`cannot read OPS_INGEST_SECRET_FILE: ${err.code || err.message}`);
      return "";
    }
  }
  return (process.env.OPS_INGEST_SECRET || "").trim();
}
const OPS_INGEST_SECRET = readIngestSecret();

const app = express();
// Client IP (public report rate limit): X-Forwarded-For is only honoured from
// a trusted peer. Default: loopback + private ranges (SWAG on the Docker
// network); OPS_TRUST_PROXY overrides (Express "trust proxy" syntax).
app.set("trust proxy", process.env.OPS_TRUST_PROXY || "loopback, uniquelocal");
const { ADMIN_ENABLED, ADMIN_PATH, ADMIN_READ_ONLY } = getAdminConfig();
// Body parsers: the admin router and the public report route bring their own
// (admin: large composer requests; public: small, strict limits).
const underAdmin = (req) => ADMIN_ENABLED && (req.path === ADMIN_PATH || req.path.startsWith(`${ADMIN_PATH}/`));
const globalForm = express.urlencoded({ extended: true, limit: "100kb" });
const globalJson = express.json({ limit: "2mb" });
app.use((req, res, next) => (underAdmin(req) || req.path === "/report" ? next() : globalForm(req, res, next)));
app.use((req, res, next) => (underAdmin(req) || req.path === "/report" ? next() : globalJson(req, res, next)));
app.use(express.static(new URL("./public", import.meta.url).pathname));

function requireIngestSecret(req, res, next) {
  if (!OPS_INGEST_SECRET) {
    return res.status(503).json({ error: "ops_ingest_not_configured" });
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = String(req.headers["x-ops-secret"] || "").trim();
  if (bearer !== OPS_INGEST_SECRET && header !== OPS_INGEST_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

function githubTokenHealth() {
  const t = getForkPushTokenState();
  return { known: t.known, ok: t.ok, source: t.source, checked_at: t.checked_at || null };
}
function githubTokenOk() {
  return getGithubTokenConfigured() || getForkPushTokenState().ok;
}

app.get("/health", (_req, res) => {
  try {
    getDb();
    res.json({
      ok: true,
      service: "neo-autofix",
      db: getDbPath(),
      ingestConfigured: Boolean(OPS_INGEST_SECRET),
      // The container never holds the GitHub token (the host worker does):
      // report the worker's last token check, else the Nix "configured" hint.
      githubConfigured: githubTokenOk(),
      githubToken: githubTokenHealth(),
      allowlist: getAllowlist(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.use(createPublicRouter({ adminPath: ADMIN_ENABLED ? ADMIN_PATH : "" }));

app.post("/api/incidents", requireIngestSecret, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { incident, created } = upsertIncident(body);
    if (created && ["1", "true", "yes", "on"].includes(String(process.env.OPS_AUTOTRIAGE || "").toLowerCase())) {
      try {
        const { path: jobPath } = enqueueJob("triage", incident, { trigger: "auto" });
        addIncidentEvent(incident.id, "triage_enqueued", "Auto-triage job enqueued (OPS_AUTOTRIAGE on ingest)", { job_path: jobPath, trigger: "ingest_autotriage" });
      } catch (err) {
        console.error("[ingest] autotriage enqueue failed", err);
      }
    }
    try { ingestResultsDir(); } catch { /* ignore */ }
    return res.status(created ? 201 : 200).json({
      ok: true,
      created,
      incident: {
        id: incident.id,
        report_hash: incident.report_hash,
        status: incident.status,
        class: incident.class,
        severity: incident.severity,
        target_hint: incident.target_hint,
        created_at: incident.created_at,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[ingest]", err);
    return res.status(status).json({ error: err.message || "ingest_failed" });
  }
});

if (ADMIN_ENABLED) {
  const adminRouter = createAdminRouter();
  app.use(ADMIN_PATH, adminRouter);
}

// Ensure DB migrates on boot
getDb();

// Background ingest of worker results (poll + best-effort fs.watch). Same
// claim-by-rename as the admin page-load path, so no double ingest.
const pollMs = Number(process.env.OPS_RESULTS_POLL_MS ?? 15000);
if (pollMs > 0) {
  startResultsIngestLoop({
    intervalMs: pollMs,
    watch: !["0", "false", "no", "off"].includes(String(process.env.OPS_RESULTS_WATCH || "true").toLowerCase()),
  });
}

app.listen(PORT, () => {
  console.log(
    `neo-autofix listening on :${PORT} (ingest=${Boolean(OPS_INGEST_SECRET)}, github=${githubTokenOk()}, admin=${ADMIN_ENABLED ? ADMIN_PATH : "off"}, readOnly=${ADMIN_READ_ONLY}, autoTriage=${["1", "true", "yes", "on"].includes(String(process.env.OPS_AUTOTRIAGE || "").toLowerCase())}, db=${getDbPath()})`,
  );
});
