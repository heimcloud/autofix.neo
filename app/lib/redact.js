/**
 * Redact operator/customer-identifying details from text destined for GitHub.
 * Public surfaces may only use the incident number + report_hash plus
 * non-identifying metadata. Never emit customer slugs, host names, IPs,
 * emails, home paths, or plugin URLs that embed a slug.
 *
 * Host-specific terms come from the environment (rendered by the Nix module):
 *  - OPS_REDACT_EXTRA_SLUGS  comma list of terms (rotated slugs, lab host
 *                            names, …), redacted case-insensitively anywhere
 *  - OPS_REDACT_HOSTNAMES    comma list of host names (whole words); the
 *                            module adds the host's own networking.hostName
 *  - OPS_REDACT_PATTERNS     whitespace-separated whole-token regexes, e.g.
 *                            the shape of customer ids: [A-Z0-9]{10}
 *  - OPS_PUBLIC_OWNERS       comma list of GitHub owners whose owner/repo
 *                            names and github: flake refs are kept (the
 *                            targets' upstream and fork owners)
 */

const DOMAIN_ALLOWLIST = new Set(["github.com", "docker.io"]);

/** github: flake owners that are always fine to mention. */
const BASE_FLAKE_OWNERS = ["NixOS", "nix-community"];

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

/** IPv6: require '::' or ≥2 colons so digests like sha256:abc are untouched. */
const IPV6 =
  /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const HOME_PATH = /\/home\/[A-Za-z0-9._-]+/g;

const URL_LIKE =
  /\b(?:github:[^\s`'"]+|git\+https:\/\/[^\s`'"]+|git\+ssh:\/\/[^\s`'"]+|https?:\/\/[^\s`'"]+)/gi;

const FQDN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

const splitList = (v, re) =>
  [...new Set(String(v || "").split(",").map((x) => x.trim()).filter((x) => x && re.test(x)))];

/**
 * Compile OPS_REDACT_PATTERNS: whole-token, case-sensitive. Patterns that do
 * not compile or match the empty string are ignored (logged once).
 */
export function compilePatterns(raw) {
  const out = [];
  for (const p of String(raw || "").split(/\s+/).filter(Boolean)) {
    if (p.length > 200) continue;
    try {
      const re = new RegExp(`\\b(?:${p})\\b`, "g");
      if (new RegExp(`^(?:${p})$`).test("")) throw new Error("matches empty");
      out.push(re);
    } catch (err) {
      if (!warnedPatterns.has(p)) {
        warnedPatterns.add(p);
        console.error(`redact: ignoring OPS_REDACT_PATTERNS entry (${err.message})`);
      }
    }
  }
  return out;
}
const warnedPatterns = new Set();

let cached = { key: null, cfg: null };

/** Host-specific redaction settings from the environment (cached per value). */
export function redactConfig(env = process.env) {
  const key = [env.OPS_REDACT_HOSTNAMES, env.OPS_REDACT_PATTERNS, env.OPS_PUBLIC_OWNERS].map((v) => v || "").join("\u0000");
  if (cached.key === key) return cached.cfg;
  const owners = splitList(env.OPS_PUBLIC_OWNERS, OWNER_RE);
  const ownersAlt = owners.map(escapeRegExp).join("|");
  const flakeAlt = [...BASE_FLAKE_OWNERS, ...owners].map(escapeRegExp).join("|");
  const cfg = {
    hostnames: splitList(env.OPS_REDACT_HOSTNAMES, HOST_RE),
    patterns: compilePatterns(env.OPS_REDACT_PATTERNS),
    publicOwners: owners,
    /** owner/repo of the public GitHub accounts the autofix loop works with. */
    publicRepo: owners.length ? new RegExp(`(?<![A-Za-z0-9_.-])(?:${ownersAlt})\\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?<![.])`, "g") : null,
    /** github:owner/repo flake refs we keep; everything else goes. */
    flakeAllow: new RegExp(`^github:(?:${flakeAlt})\\/[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)?$`),
  };
  cached = { key, cfg };
  return cfg;
}

function matchesPattern(cfg, s) {
  return cfg.patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 * @returns {string}
 */
export function redactIdentifyingDetails(text, opts = {}) {
  let out = text == null ? "" : String(text);
  const known = Array.isArray(opts.knownSlugs) ? opts.knownSlugs : [];
  const cfg = redactConfig();

  for (const slug of known) {
    const s = String(slug || "").trim();
    if (!s) continue;
    out = out.replace(new RegExp(escapeRegExp(s), "gi"), "[redacted-slug]");
  }

  // Patterns are case-sensitive (e.g. lowercase hex SHAs vs. [A-Z0-9]{10}).
  for (const re of cfg.patterns) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted-slug]");
  }

  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(IPV4, "[redacted-ip]");
  out = out.replace(IPV6, "[redacted-ip]");
  out = out.replace(HOME_PATH, "/home/[redacted-user]");

  for (const host of cfg.hostnames) {
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(host)}\\b`, "gi"),
      "[redacted-host]",
    );
  }

  out = out.replace(URL_LIKE, (match) => {
    if (match.startsWith("github:")) {
      // Drop query/trailing punctuation sometimes attached
      const trimmed = match.replace(/[),.;]+$/, "");
      if (cfg.flakeAllow.test(trimmed) && !matchesPattern(cfg, trimmed)) {
        return match;
      }
      return "[redacted-url]";
    }
    try {
      const raw = match.replace(/^git\+/, "");
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!DOMAIN_ALLOWLIST.has(host)) return "[redacted-url]";
      if (
        matchesPattern(cfg, u.pathname) ||
        known.some((s) => s && u.href.toLowerCase().includes(String(s).toLowerCase()))
      ) {
        return "[redacted-url]";
      }
      return match;
    } catch {
      return "[redacted-url]";
    }
  });

  // Repo names of the public upstreams / forks (example-upstream/plugin.neo)
  // are not host names: keep "<owner>/<repo>" intact through the FQDN rule.
  const keptRepos = [];
  if (cfg.publicRepo) {
    out = out.replace(cfg.publicRepo, (m) => {
      keptRepos.push(m);
      return `\uE002${keptRepos.length - 1}\uE002`;
    });
  }
  out = out.replace(FQDN, (match) => {
    const lower = match.toLowerCase();
    if (DOMAIN_ALLOWLIST.has(lower)) return match;
    const labels = lower.split(".");
    if (labels.length >= 2) {
      const root = labels.slice(-2).join(".");
      if (DOMAIN_ALLOWLIST.has(root)) return match;
    }
    return "[redacted-host]";
  });
  out = out.replace(/\uE002(\d+)\uE002/g, (_, i) => keptRepos[Number(i)] ?? "");

  return out;
}

/**
 * @param {string[]} fromDb
 * @param {...(string|null|undefined)} extras
 */
export function mergeKnownSlugs(fromDb = [], ...extras) {
  const set = new Set();
  for (const s of [...fromDb, ...extras]) {
    const v = s != null ? String(s).trim() : "";
    if (v) set.add(v);
  }
  return [...set];
}

/**
 * Extra burned / rotated slugs that must stay redacted even if DB rows change.
 * Comma-separated via OPS_REDACT_EXTRA_SLUGS.
 * @returns {string[]}
 */
export function getExtraRedactSlugs() {
  const raw = process.env.OPS_REDACT_EXTRA_SLUGS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return list of hit descriptions if text still contains identifiers after redaction
 * would leave them (or raw known slugs / slug-shape tokens).
 * Used for fail-closed push gates.
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 * @returns {string[]}
 */
export function findIdentifierHits(text, opts = {}) {
  const raw = text == null ? "" : String(text);
  const hits = [];
  const known = Array.isArray(opts.knownSlugs) ? opts.knownSlugs : [];
  for (const slug of known) {
    const s = String(slug || "").trim();
    // Case-insensitive: a lower-cased slug in a path/branch must still fail closed.
    if (s && raw.toLowerCase().includes(s.toLowerCase())) {
      hits.push(`known_slug:${s.slice(0, 2)}…`);
    }
  }
  const cfg = redactConfig();
  // Configured id shapes still present (fail closed on any).
  for (const re of cfg.patterns) {
    re.lastIndex = 0;
    for (const m of raw.match(re) || []) hits.push(`slug_shape:${m.slice(0, 2)}…`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(raw)) hits.push("ipv4");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(raw)) hits.push("email");
  if (/\/home\/[A-Za-z0-9._-]+/.test(raw)) hits.push("home_path");
  for (const host of cfg.hostnames) {
    if (new RegExp(`\\b${escapeRegExp(host)}\\b`, "i").test(raw)) hits.push(`lab_host:${host.slice(0, 2)}…`);
  }
  return hits;
}

/**
 * @param {string} text
 * @param {{ knownSlugs?: string[] }} [opts]
 */
export function assertNoIdentifyingDetails(text, opts = {}) {
  const hits = findIdentifierHits(text, opts);
  if (hits.length) {
    const err = new Error(`redaction_fail_closed:${hits.join(",")}`);
    err.hits = hits;
    err.status = 422;
    throw err;
  }
  return true;
}
