/**
 * Configured upstream repos of the autofix loop (single source of truth).
 *
 * Nix renders neo.services.autofix.targets (settings.toml
 * [[services.autofix.targets]]) into /etc/neo-autofix/targets.json (and
 * OPS_TARGETS) for the container, the worker, the PR wrapper and the root lab
 * runner. There is no built-in target: without targets autofix only triages.
 *
 * Entry: { upstream, fork, baseRef, flakeInput, lab, flakeUrl, units, paths,
 *          keywords, protectedPaths, basePaths, reviewers }
 *  - upstream   owner/repo the PR goes to (the incident's target_repo)
 *  - fork       owner/repo the worker pushes fix/* | ops/* branches to; all
 *               forks share one owner (the bot account the token belongs to)
 *  - baseRef    branch the host runs / PR base; null = upstream default branch
 *               (resolved by the worker, cached in state/base-refs.json)
 *  - flakeInput host flake input the lab overrides (null = find it by URL)
 *  - lab        "flake-override" (default) | "none" (→ needs_human, test by hand)
 *  - flakeUrl   override URL with {branch} (default github:<fork>/{branch})
 *  - units / paths / keywords  routing hints for triage
 *  - protectedPaths  admin approval before the lab test (shared host)
 *  - basePaths  subset of protected paths shown as "base system"
 *  - reviewers  PR reviewer logins (null = global list / auto-detect)
 * Shared by the app (lib) and the worker package (copied, byte-identical).
 */

import fs from "node:fs";
import path from "node:path";

export const LAB_METHODS = ["flake-override", "none"];

const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const INPUT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FLAKE_URL_RE = /^(github:|git\+https:\/\/github\.com\/)[A-Za-z0-9_.\/?=&{}-]+$/;
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isSlug(s) {
  const v = String(s || "");
  return SLUG_RE.test(v) && !v.split("/").some((p) => p === "." || p === ".." || p.startsWith("."));
}

export function validRef(r) {
  return typeof r === "string" && REF_RE.test(r) && !r.includes("..");
}

const strList = (v, re, max = 50) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 200 && re.test(x)))].slice(0, max);

const pathList = (v) => strList(v, /^[A-Za-z0-9._\/-]+$/).map((p) => p.replace(/^\.?\/+|\/+$/g, "")).filter((p) => p && !p.split("/").includes(".."));

/** Validate one entry; null when unusable (never throws). */
export function normalizeTarget(t) {
  if (!t || typeof t !== "object" || !isSlug(t.upstream)) return null;
  if (!isSlug(t.fork)) return null;
  const fork = String(t.fork);
  const baseRef = t.baseRef == null || t.baseRef === "" ? null : String(t.baseRef);
  if (baseRef !== null && !validRef(baseRef)) return null;
  const flakeInput = t.flakeInput == null || t.flakeInput === "" ? null : String(t.flakeInput);
  if (flakeInput !== null && !INPUT_RE.test(flakeInput)) return null;
  const lab = LAB_METHODS.includes(t.lab) ? t.lab : t.lab == null ? "flake-override" : null;
  if (!lab) return null;
  const flakeUrl = t.flakeUrl ? String(t.flakeUrl) : `github:${fork}/{branch}`;
  if (!FLAKE_URL_RE.test(flakeUrl) || !flakeUrl.includes("{branch}")) return null;
  const protectedPaths = pathList(t.protectedPaths);
  return {
    upstream: t.upstream,
    fork,
    baseRef,
    flakeInput,
    lab,
    flakeUrl,
    units: strList(t.units, /^[A-Za-z0-9@._:*-]+$/),
    paths: strList(t.paths, /^[A-Za-z0-9._\/-]+$/),
    keywords: strList(t.keywords, /^[^\n\r]{2,80}$/),
    protectedPaths,
    basePaths: pathList(t.basePaths),
    reviewers: Array.isArray(t.reviewers) ? strList(t.reviewers, LOGIN_RE, 15) : null,
  };
}

export function ownerOfSlug(slug) {
  return String(slug || "").split("/")[0];
}

/**
 * Parse OPS_TARGETS (JSON array). Invalid entries are dropped; duplicates of
 * an upstream keep the first; entries whose fork owner differs from the first
 * entry's are dropped (one token, one bot account). `baseRefs` (upstream →
 * ref, lower-case keys) fills unset base refs.
 */
export function parseTargets(raw, { baseRefs = {} } = {}) {
  let list = [];
  if (raw && String(raw).trim()) {
    try {
      const v = JSON.parse(raw);
      list = Array.isArray(v) ? v : [];
    } catch {
      list = [];
    }
  }
  const out = [];
  const seen = new Set();
  let owner = null;
  for (const t of list) {
    const n = normalizeTarget(t);
    if (!n || seen.has(n.upstream.toLowerCase())) continue;
    const o = ownerOfSlug(n.fork).toLowerCase();
    if (owner === null) owner = o;
    else if (o !== owner) continue;
    seen.add(n.upstream.toLowerCase());
    if (n.baseRef === null) {
      const c = baseRefs[n.upstream.toLowerCase()];
      const ref = c && typeof c === "object" ? c.ref : c;
      if (validRef(ref)) n.baseRef = ref;
    }
    out.push(n);
  }
  return out;
}

/** Owner of the forks (= the bot account), or "" without targets. */
export function forkOwner(targets) {
  return targets && targets.length ? ownerOfSlug(targets[0].fork) : "";
}

/** Rendered by the ops module on the host (interactive checks without the unit env). */
export const DEFAULT_TARGETS_FILE = "/etc/neo-autofix/targets.json";

/**
 * OPS_TARGETS (JSON), else the JSON file OPS_TARGETS_FILE (systemd units: no
 * quoting issues), else DEFAULT_TARGETS_FILE when it exists.
 */
export function loadTargets(env = process.env) {
  return parseTargets(env.OPS_TARGETS || readTargetsFile(env.OPS_TARGETS_FILE || DEFAULT_TARGETS_FILE), { baseRefs: readBaseRefs(env) });
}

/** Cached default branches (written by the worker), {} when absent. */
export function readBaseRefs(env = process.env) {
  const file = env.OPS_BASE_REFS_FILE || (env.OPS_DATA_DIR ? path.join(env.OPS_DATA_DIR, "state", "base-refs.json") : "");
  if (!file) return {};
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function readTargetsFile(file) {
  if (!file) return "";
  try {
    return fs.readFileSync(String(file), "utf8").slice(0, 200000);
  } catch {
    return "";
  }
}

/** Configured target by upstream slug (case-insensitive), or null. */
export function findTarget(targets, slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  return targets.find((t) => t.upstream.toLowerCase() === s) || null;
}

/** Target whose fork is this slug, or null. */
export function findTargetByFork(targets, fork) {
  const s = String(fork || "").trim().toLowerCase();
  return targets.find((t) => t.fork.toLowerCase() === s) || null;
}

function unitMatches(pattern, unit) {
  const u = String(unit || "").toLowerCase().replace(/\.service$/, "");
  const p = pattern.toLowerCase().replace(/\.service$/, "");
  if (!p.includes("*")) return u === p;
  const re = new RegExp(`^${p.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(u);
}

/**
 * Deterministic routing from the hints (used when triage names no target and
 * for the hint list shown to Hermes): unit pattern +3, changed-path prefix +2,
 * keyword in the logs +1. Ties and no match → the first entry; no targets
 * → { target: null }.
 */
export function routeTarget(targets, { unit = "", logs = "", files = [] } = {}) {
  if (!targets || !targets.length) return { target: null, score: 0 };
  let best = targets[0];
  let bestScore = 0;
  const text = String(logs || "").toLowerCase();
  for (const t of targets) {
    let score = 0;
    if (t.units.some((p) => unitMatches(p, unit))) score += 3;
    if (t.paths.some((p) => files.some((f) => f === p || f.startsWith(`${p.replace(/\/+$/, "")}/`)))) score += 2;
    score += t.keywords.filter((k) => text.includes(k.toLowerCase())).length;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return { target: best, score: bestScore };
}

/** Prompt lines describing the configured targets for the triage skill. */
export function targetHints(targets) {
  return targets.map((t) => {
    const bits = [t.units.length && `units ${t.units.join(", ")}`, t.paths.length && `paths ${t.paths.join(", ")}`, t.keywords.length && `keywords ${t.keywords.join(", ")}`].filter(Boolean);
    return `- ${t.upstream}${bits.length ? ` (${bits.join("; ")})` : ""}`;
  });
}

export function compareOpts(t) {
  const [, forkRepo] = t.fork.split("/");
  return { upstream: t.upstream, forkOwner: t.fork.split("/")[0], forkRepo, base: t.baseRef || "main" };
}
