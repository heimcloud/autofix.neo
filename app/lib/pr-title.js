/**
 * PR titles (and suggested commit subjects): `<unit>/<fix|feat>: <summary>`,
 * e.g. `web/fix: clear stale activation job after aborted CLI update`.
 *
 * - unit: lowercase service / component from the incident's systemd unit
 *   (docker-swag.service → swag, neo-web.service → web), else from the
 *   changed paths (cli/… → cli, nix/services/nextcloud/… → nextcloud).
 * - type: feat for admin-composer feature requests, fix otherwise.
 * - summary: the first usable candidate (Hermes' pr_title / commit message,
 *   the HEAD commit subject, the request title, Hermes' summary), with any
 *   existing type prefix stripped. A candidate is dropped when the redaction
 *   would change it (no slugs, hosts, domains, IPs, emails, home paths), when
 *   it names an incident id, or when it is generic. Last resort: built from
 *   the changed files. Never throws.
 */
import path from "node:path";
import { redactIdentifyingDetails } from "./redact.js";

export const PR_TITLE_MAX = 72;
const UNIT_RE = /^[a-z][a-z0-9]{1,23}$/;
const STRIP_PREFIX = /^(?:docker|podman|container|neo|ops)-/;
const STRIP_SUFFIX = /\.(?:service|timer|socket|path|mount|target)$/;
const GENERIC = /^(?:fix(?:es|ed)?|feat(?:ure)?|update[sd]?|changes?|change|automated fix|auto ?fix(?: attempt)?|wip|misc|minor fixes?|bug ?fix|patch|tweak|cleanup|ready to push|ready_to_push|lab test pending)$/i;
const INCIDENT_ID = /\b(?:incident|issue|ticket|ops)[\s_-]*#?\d+\b|(?:^|\s)#\d+\b/i;

function clean(s) {
  return String(s ?? "")
    .split(/\r?\n/)[0]
    .replace(/[\u0000-\u001f\u007f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `docker-swag.service` → `swag`; null when nothing usable. */
export function unitFromName(unit) {
  let u = String(unit || "").toLowerCase().trim();
  if (!u || u.includes("/") || u.startsWith("[redacted")) return null;
  u = u.replace(STRIP_SUFFIX, "").replace(/@.*$/, "");
  for (let i = 0; i < 3 && STRIP_PREFIX.test(u); i += 1) u = u.replace(STRIP_PREFIX, "");
  u = u.split(/[-_.]/)[0];
  return UNIT_RE.test(u) ? u : null;
}

/** Most frequent component among the changed paths, or null. */
export function unitFromPaths(paths) {
  const count = new Map();
  for (const p of paths || []) {
    const parts = String(p).split("/").filter(Boolean);
    let u = null;
    const i = parts.indexOf("services");
    if (i >= 0 && parts[i + 1] && i + 2 < parts.length) u = parts[i + 1];
    else if (parts.length > 1) u = parts[0];
    u = u ? unitFromName(u) : null;
    if (u && !["src", "lib", "nix", "app", "docs", "test", "tests"].includes(u)) count.set(u, (count.get(u) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

/** Drop an existing `fix:` / `web/fix:` / `fix(web):` prefix and tidy up. */
function stripType(s) {
  return clean(s)
    .replace(/^\[[^\]]{1,20}\]\s*/, "")
    .replace(/^(?:[a-z0-9-]{1,24}\/)?(?:fix|feat|chore|docs|refactor|perf|test|build|ci|ops)(?:\([^)]{0,30}\))?!?\s*:\s*/i, "")
    .replace(/[.;:,\s]+$/, "");
}

/** Usable summary or null (see module comment). */
export function sanitizeSummary(s, slugs = []) {
  let t = stripType(s);
  if (t.length < 8 || t.split(" ").length < 2) return null;
  if (INCIDENT_ID.test(t) || GENERIC.test(t)) return null;
  if (redactIdentifyingDetails(t, { knownSlugs: slugs }) !== t) return null;
  if (/^[A-Z][a-z]/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  return t;
}

function shorten(s, max) {
  if (s.length <= max) return s;
  // Prefer ending before a trailing clause ("… so …", "… because …").
  const clause = /\s(?:so that|so|because|since|which|when|to avoid|instead of)\s/gi;
  let best = 0;
  for (const m of s.matchAll(clause)) if (m.index <= max && m.index > max * 0.5) best = m.index;
  if (best) return s.slice(0, best).replace(/[\s,;:.-]+$/, "");
  const cut = s.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[\s,;:.-]+$/, "");
}

/** Fallback summary from the changed directories (file names with dots read like domains to the redaction). */
function fromPaths(paths, type, slugs) {
  const dirs = [...new Set((paths || []).map((p) => path.dirname(String(p))).filter((d) => d !== "." && /^[A-Za-z0-9_/-]{1,80}$/.test(d)))];
  const safe = dirs.filter((d) => redactIdentifyingDetails(d, { knownSlugs: slugs }) === d).slice(0, 2);
  if (!safe.length) return null;
  const more = dirs.length > safe.length ? ` and ${dirs.length - safe.length} more` : "";
  return `${type === "feat" ? "extend" : "adjust"} ${safe.join(", ")}${more}`;
}

/**
 * Title for a fix / feature PR.
 * @param {object} o
 * @param {string} [o.unit]        systemd unit of the incident
 * @param {string[]} [o.paths]     files changed vs the base
 * @param {string} [o.requestType] "feature" for admin feature requests
 * @param {string[]} [o.candidates] summary candidates, best first
 * @param {string[]} [o.slugs]     known customer slugs (redaction)
 */
export function buildPrTitle({ unit, paths = [], requestType, candidates = [], slugs = [], max = PR_TITLE_MAX } = {}) {
  const scope = unitFromName(unit) || unitFromPaths(paths) || "ops";
  const type = requestType === "feature" ? "feat" : "fix";
  const prefix = `${scope}/${type}: `;
  let summary = null;
  for (const c of candidates) {
    summary = sanitizeSummary(c, slugs);
    if (summary) break;
  }
  summary ||= fromPaths(paths, type, slugs) || (type === "feat" ? `add the requested ${scope} change` : `handle the reported ${scope} failure`);
  return prefix + shorten(summary, Math.max(16, max - prefix.length));
}
