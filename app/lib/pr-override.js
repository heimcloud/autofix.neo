/**
 * Admin "Open PR anyway" (v0.3.6, loosened in v0.3.7): a fix branch exists,
 * no PR is open and no PR job is pending, whatever the lab state. Queues the
 * normal kind "pr" job through the usual worker path (redaction gate, title
 * format, pinned reviewers, allowlist); the PR opens as a draft unless the
 * lab passed, and is never merged automatically. The body says
 *   lab failed / errored → "Lab test FAILED" + the redacted reason (mode lab_failed)
 *   lab never ran        → "NOT lab-tested"                       (mode not_tested)
 *   lab passed           → the normal lab evidence                (mode open)
 * Everything comes from the DB (events); the form carries nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { queueDir, ensureDir, findPendingJobs, isAutofixKindEnabled, QueueError, redactedIncidentFields } from "./queue.js";
import { resolveTargetRepo, isRepoAllowed } from "./github.js";
import { redactIdentifyingDetails } from "./redact.js";
import { buildPrTitle } from "./pr-title.js";

const BRANCH = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const validBranch = (b) => typeof b === "string" && BRANCH.test(b) && !b.includes("..");

function conflict(code, message) {
  const e = new QueueError(code, message);
  e.status = 409;
  return e;
}

function metaOf(e) {
  if (e.meta !== undefined && typeof e.meta === "object") return e.meta || {};
  try {
    return JSON.parse(e.meta_json || "null") || {};
  } catch {
    return {};
  }
}

/** Branch of a fix_result / lab event under any of the fields it is stored in. */
function branchOf(m) {
  for (const b of [m.branch, m.draft_branch, m.lab_info?.branch, m.lab?.branch, m.protected_info?.branch]) if (validBranch(b)) return b;
  return null;
}

/**
 * Pure: what the override would open, or why it can't.
 * { ok, code, reason, branch, lab: "failed"|"error"|"passed"|"never", mode, head_sha, ... }
 * ok:false with code null means "no fix branch": the toggle is not rendered at all.
 */
export function prOverrideSource(incident, events = []) {
  if (!incident) return { ok: false, code: null, reason: "" };
  const evs = [...events].map((e) => ({ ...e, meta: metaOf(e) })).sort((a, b) => Number(a.id) - Number(b.id));
  const fixes = evs.filter((e) => e.kind === "fix_result");
  let branch = null;
  for (const e of [...fixes].reverse()) if ((branch = branchOf(e.meta))) break;
  if (!branch) for (const e of [...evs].reverse()) if (e.kind === "lab_approved" && (branch = branchOf(e.meta))) break;
  if (!branch && validBranch(incident.draft_branch)) branch = incident.draft_branch;
  if (!branch) return { ok: false, code: null, reason: "" };

  // Head / prepared PR text: latest event of that branch carrying a head sha.
  const withHead = [...evs].reverse().find((e) => ["fix_result", "lab_approved", "lab_enqueued", "push_enqueued"].includes(e.kind) && branchOf(e.meta) === branch && SHA.test(String(e.meta.head_sha || "")));
  const pm = withHead?.meta || {};
  // Lab state of that branch: the latest lab outcome after its latest push.
  const pushIdx = withHead && withHead.meta.via !== "lab" && !withHead.meta.lab ? Number(withHead.id) : 0;
  const labEv = [...fixes].reverse().find((e) => (e.meta.via === "lab" || e.meta.lab) && branchOf(e.meta) === branch && Number(e.id) >= pushIdx && ["failed", "error", "passed"].includes(e.meta.lab));
  const lm = labEv?.meta || {};
  const lab = labEv ? lm.lab : "never";
  const report = lm.lab_report && typeof lm.lab_report === "object" ? lm.lab_report : null;
  const base = {
    branch,
    lab,
    mode: lab === "failed" || lab === "error" ? "lab_failed" : lab === "passed" ? "open" : "not_tested",
    head_sha: SHA.test(String(pm.head_sha || "")) ? pm.head_sha : undefined,
    target_repo: lm.target_repo || pm.target_repo || incident.target_repo || undefined,
    pr_title: typeof pm.pr_title === "string" ? pm.pr_title : incident.prepared_pr_title || "",
    pr_body: typeof pm.pr_body === "string" ? pm.pr_body : incident.prepared_pr_body || "",
    lab_report: report || undefined,
    lab_reason: labEv ? String(report?.reason || lm.summary || `lab test ${lab}`) : "",
    fix_event_id: labEv ? Number(labEv.id) : withHead ? Number(withHead.id) : null,
  };
  if (["resolved", "closed"].includes(incident.status)) return { ...base, ok: false, code: "incident_closed", reason: `Incident is ${incident.status}; reopen it first.` };
  // Open / merged PR (tracked pr_state, else the row's PR number).
  const pr = [...evs].reverse().find((e) => e.kind === "pr_state" || e.kind === "pr_merged");
  const prState = pr?.meta?.pr_state || (pr?.kind === "pr_merged" ? "merged" : null);
  const prNum = Number(pr?.meta?.pr_number) || Number(incident.draft_pr_number) || null;
  if (prState === "merged") return { ...base, ok: false, code: "pr_merged", reason: `PR #${prNum || "?"} is already merged.` };
  if (prState === "open" || (prNum && prState !== "closed" && (incident.draft_pr_url || prState))) {
    return { ...base, ok: false, code: "pr_open", reason: `PR #${prNum} is already open for this incident.` };
  }
  return { ...base, ok: true, code: null, reason: "" };
}

/** Back-compat (v0.3.6 name): source when eligible, else null. */
export function labFailedPrSource(incident, events = []) {
  const s = prOverrideSource(incident, events);
  return s.ok ? s : null;
}

/** Host-side checks (queue dir, settings, allowlist): { ok, code, reason }. */
export function prOverrideHostCheck(incident, src) {
  if (!isAutofixKindEnabled("pr")) {
    return { ok: false, code: "autofix_disabled", reason: "PR automation is off on this host (autofix.pr.enable, or the token cannot open upstream PRs); use the compare link." };
  }
  const pending = findPendingJobs("pr", incident.id);
  if (pending.length) {
    const f = path.basename(pending[0]);
    let age = "";
    try {
      age = ` since ${new Date(fs.statSync(pending[0]).mtimeMs).toISOString().slice(0, 16)}Z`;
    } catch {
      /* gone meanwhile */
    }
    return { ok: false, code: "already_queued", reason: `A PR job for #${incident.id} is already queued or running (${f}${age}); cancel it in the queue panel if it is stale.` };
  }
  let target = src?.target_repo;
  try {
    target ||= resolveTargetRepo(incident);
  } catch {
    target = null;
  }
  if (!target || !isRepoAllowed(target)) {
    return { ok: false, code: "unknown_target", reason: `Target repo ${String(target || "(none)").slice(0, 120)} is not allowlisted (services.autofix.targets).` };
  }
  return { ok: true, code: null, reason: "", target };
}

/** Drawer state: null (no fix branch → nothing rendered) or { ok, reason, lab, label }. */
export function prOverrideView(incident, events = []) {
  const src = prOverrideSource(incident, events);
  if (!src.branch) return null;
  let host = { ok: true, reason: "" };
  if (src.ok) {
    try {
      host = prOverrideHostCheck(incident, src);
    } catch (e) {
      host = { ok: false, reason: `Check failed: ${e.message || e}` };
    }
  }
  const label = src.lab === "failed" || src.lab === "error" ? `Open PR anyway (lab ${src.lab})` : src.lab === "passed" ? "Open PR" : "Open PR anyway (not lab-tested)";
  return { ok: src.ok && host.ok, reason: src.ok ? host.reason : src.reason, lab: src.lab, branch: src.branch, label };
}

function safeTitle(incident, src, slugs) {
  try {
    return buildPrTitle({ unit: incident.unit, requestType: incident.request_type, candidates: [src.pr_title, incident.title], slugs });
  } catch {
    return buildPrTitle({ unit: "", candidates: [] });
  }
}

/** Queue the override PR job; throws QueueError (409) with a readable reason. */
export function enqueueLabFailedPrJob(incident, src, { slugs = [] } = {}) {
  if (!src || !src.branch) throw conflict("no_fix_branch", `Incident #${incident.id} has no fix branch to open a PR from.`);
  if (src.ok === false) throw conflict(src.code || "not_eligible", src.reason || "Not eligible.");
  const host = prOverrideHostCheck(incident, src);
  if (!host.ok) throw conflict(host.code, host.reason);
  const red = (t) => redactIdentifyingDetails(String(t || ""), { knownSlugs: slugs }).replace(/\s+/g, " ").trim().slice(0, 400);
  const job = {
    job_version: 1,
    kind: "pr",
    mode: src.mode || "lab_failed",
    incident_id: incident.id,
    ...redactedIncidentFields(incident),
    target_repo: host.target,
    branch: src.branch,
    head_sha: src.head_sha,
    pr_title: safeTitle(incident, src, slugs),
    pr_body: String(src.pr_body || "").slice(0, 20000) || undefined,
    lab_report: src.lab_report,
    lab_failure_reason: src.mode === "lab_failed" ? red(src.lab_reason) : undefined,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "admin",
  };
  const dir = queueDir("pr");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    // wx: two clicks in the same millisecond cannot both write.
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660, flag: "wx" });
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (e.code === "EEXIST") throw conflict("already_queued", `A PR job for #${incident.id} is already being queued.`);
    throw conflict("queue_write_failed", `Could not write the PR job to the queue (${e.code || e.message}).`);
  }
  return { path: dest, job };
}
