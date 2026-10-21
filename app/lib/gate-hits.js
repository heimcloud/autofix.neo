/**
 * Redaction-gate block details (v0.3.8): masked file:line locations of the
 * IPv4 literals that blocked a push. Values are masked by the worker
 * (10.x.x.x, x.x.x.x); everything here is re-sanitized before display or
 * before it goes back to Hermes in a gate retry.
 */
const SIDES = new Set(["added", "context", "removed", "header"]);
const SAFE_FILE = /^(?:[A-Za-z0-9_./@+ -]{1,160}|\[path withheld\])$/;
const MASKED = /^(?:10\.x\.x\.x|172\.x\.x\.x|192\.x\.x\.x|100\.x\.x\.x|169\.254\.x\.x|x\.x\.x\.x)$/;

export function sanitizeGateHits(hits) {
  if (!Array.isArray(hits)) return [];
  const out = [];
  for (const h of hits.slice(0, 10)) {
    if (!h || typeof h !== "object") continue;
    const masked = MASKED.test(String(h.masked || "")) ? h.masked : "x.x.x.x";
    out.push({
      scope: String(h.scope || "diff").replace(/[^a-z_]/g, "").slice(0, 20) || "diff",
      file: typeof h.file === "string" && SAFE_FILE.test(h.file) && !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(h.file) ? h.file : null,
      line: Math.max(0, Math.floor(Number(h.line) || 0)) || null,
      side: SIDES.has(h.side) ? h.side : null,
      cls: String(h.cls || "ipv4").replace(/[^a-z_]/g, "").slice(0, 20) || "ipv4",
      masked,
    });
  }
  return out;
}

/** Gate label + hits from a fix_result meta, or null when not an IPv4 gate block. */
export function ipv4GateBlock(meta) {
  if (!meta || meta.status !== "redaction_blocked") return null;
  const m = /redaction_fail_closed:([a-z_]+):([^\s]*)/.exec(String(meta.summary || ""));
  const hits = Array.isArray(meta.hits) ? meta.hits.map(String) : m ? m[2].split(",") : [];
  if (!hits.includes("ipv4")) return null;
  return { label: m ? m[1] : "diff", hits: sanitizeGateHits(meta.gate_hits) };
}

/** "nix/a.nix:42 (added, private 10.x.x.x); … +2 more". */
export function describeGateHits(hits, max = 3) {
  const one = (h) => `${h.file ? `${h.file}:${h.line ?? "?"}` : `${h.scope} line ${h.line ?? "?"}`} (${h.side ? `${h.side}, ` : ""}${h.cls} ${h.masked})`;
  return hits.slice(0, max).map(one).join("; ") + (hits.length > max ? `; +${hits.length - max} more` : "");
}

export const GATE_RETRY_HINT = "Retry the fix with the gate hint: Hermes is told the masked locations and to read IPs from config or use 192.0.2.x.";
