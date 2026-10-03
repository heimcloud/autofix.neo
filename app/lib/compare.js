/**
 * Compare link (upstream base ... fork:branch), shown when no PR is opened.
 */

/**
 * @param {string} branch
 * @param {{ upstream?: string, forkOwner?: string, forkRepo?: string, base?: string }} [opts]
 */
export function buildCompareUrl(branch, opts = {}) {
  const b = String(branch || "").trim();
  if (!b) throw new Error("branch_required");
  if (!/^(fix|ops)\/[A-Za-z0-9._/-]+$/.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) {
    throw new Error("branch_name_rejected");
  }
  const upstream = String(opts.upstream || "");
  const forkOwner = String(opts.forkOwner || "");
  const forkRepo = String(opts.forkRepo || upstream.split("/")[1] || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(upstream) || !/^[A-Za-z0-9_.-]+$/.test(forkOwner) || !/^[A-Za-z0-9_.-]+$/.test(forkRepo)) {
    throw new Error("target_required");
  }
  const base = String(opts.base || "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) {
    throw new Error("base_ref_rejected");
  }
  return `https://github.com/${upstream}/compare/${encodeURIComponent(base).replace(/%2F/g, "/")}...${forkOwner}:${forkRepo}:${encodeURIComponent(b).replace(/%2F/g, "/")}?expand=1`;
}
