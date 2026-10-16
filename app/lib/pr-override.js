/**
 * Admin "Open PR anyway" (v0.3.6): a fix branch exists, its lab test failed,
 * no PR is open. Queues the normal kind "pr" job (mode lab_failed): the
 * worker opens it as a DRAFT through the usual path (redaction gate, title
 * format, pinned reviewers, allowlist), with a "Lab test FAILED" notice and
 * the redacted failure reason at the top of the body. Never merges.
 * Source is the DB (events), never the form.
 */
import fs from "node:fs";
import path from "node:path";
import { queueDir, ensureDir, findPendingJobs, isAutofixKindEnabled, QueueError, redactedIncidentFields } from "./queue.js";
import { resolveTargetRepo, isRepoAllowed } from "./github.js";
import { redactIdentifyingDetails } from "./redact.js";
import { buildPrTitle } from "./pr-title.js";

function conflict(code, message) {
  const e = new QueueError(code, message);
  e.status = 409;
  return e;
}

const BRANCH = /^(fix|ops)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA = /^[0-9a-f]{40}$/;

function metaOf(e) {
  if (e.meta !== undefined) return e.meta || {};
  try {
    return JSON.parse(e.meta_json || "null") || {};
  } catch {
    return {};
  }
}

/**
 * The failed-lab fix branch an admin may open a PR from, or null (button
 * hidden, route 409). Pure: incident row + its events.
 */
export function labFailedPrSource(incident, events = []) {
  if (!incident || ["resolved", "closed"].includes(incident.status) || incident.draft_pr_number) return null;
  const evs = [...events].map((e) => ({ ...e, meta: metaOf(e) })).sort((a, b) => Number(a.id) - Number(b.id));
  const fixes = evs.filter((e) => e.kind === "fix_result");
  const last = fixes[fixes.length - 1];
  const m = last?.meta || {};
  if (m.via !== "lab" || !["failed", "error"].includes(m.lab) || /ROLLBACK NOT VERIFIED/.test(String(m.summary || ""))) return null;
  const branch = String(m.branch || "");
  if (!BRANCH.test(branch) || branch.includes("..")) return null;
  // An open PR (tracked state) or a queued PR job: nothing to override.
  const pr = [...evs].reverse().find((e) => e.kind === "pr_state" || e.kind === "pr_merged");
  if (pr && (pr.meta.pr_state === "open" || pr.meta.pr_state === "merged" || (Number(pr.meta.pr_number) && pr.meta.pr_state !== "closed"))) return null;
  // The pushed fix of that branch: head, prepared title / body.
  const pushed = [...fixes].reverse().find((e) => e.meta.branch === branch && SHA.test(String(e.meta.head_sha || "")) && e.meta.via !== "lab")
    || [...evs].reverse().find((e) => e.kind === "lab_approved" && e.meta.branch === branch && SHA.test(String(e.meta.head_sha || "")));
  const pm = pushed?.meta || {};
  const report = m.lab_report && typeof m.lab_report === "object" ? m.lab_report : null;
  const reason = String(report?.reason || m.summary || "lab test failed");
  return {
    branch,
    head_sha: SHA.test(String(pm.head_sha || "")) ? pm.head_sha : undefined,
    target_repo: m.target_repo || pm.target_repo || undefined,
    pr_title: typeof pm.pr_title === "string" ? pm.pr_title : incident.prepared_pr_title || "",
    pr_body: typeof pm.pr_body === "string" ? pm.pr_body : incident.prepared_pr_body || "",
    lab_report: report || undefined,
    reason,
    fix_event_id: Number(last.id),
  };
}

/** Queue the override PR job; throws QueueError (409) when not eligible / already queued. */
export function enqueueLabFailedPrJob(incident, src, { slugs = [] } = {}) {
  if (!isAutofixKindEnabled("pr")) {
    throw new QueueError("autofix_disabled", "PR automation is not enabled on this host (autofix.pr.enable), or the token cannot open upstream PRs.");
  }
  if (!src) throw conflict("no_failed_branch", `Incident #${incident.id} has no fix branch with a failed lab test and no open PR.`);
  // Double click: the first job is still queued (or running) → refuse the second.
  if (findPendingJobs("pr", incident.id).length) throw conflict("already_queued", `A PR job for incident #${incident.id} is already queued.`);
  const target = src.target_repo || resolveTargetRepo(incident);
  if (!isRepoAllowed(target)) throw conflict("unknown_target", `Target repo ${String(target).slice(0, 120)} is not allowlisted.`);
  const title = buildPrTitle({
    unit: incident.unit,
    requestType: incident.request_type,
    candidates: [src.pr_title, incident.title],
    slugs,
  });
  const job = {
    job_version: 1,
    kind: "pr",
    mode: "lab_failed",
    incident_id: incident.id,
    ...redactedIncidentFields(incident),
    target_repo: target,
    branch: src.branch,
    head_sha: src.head_sha,
    pr_title: title,
    pr_body: String(src.pr_body || "").slice(0, 20000) || undefined,
    lab_report: src.lab_report,
    lab_failure_reason: redactIdentifyingDetails(src.reason, { knownSlugs: slugs }).replace(/\s+/g, " ").trim().slice(0, 400),
    enqueued_at: new Date().toISOString(),
    enqueued_by: "admin",
  };
  const dir = queueDir("pr");
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${incident.id}-${ts}.json`);
  const tmp = `${dest}.tmp-${process.pid}`;
  // wx: two clicks in the same millisecond cannot both write.
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o660, flag: "wx" });
  fs.renameSync(tmp, dest);
  return { path: dest, job };
}
