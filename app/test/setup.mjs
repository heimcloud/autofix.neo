/**
 * Synthetic host settings for the test suite (node --import ./test/setup.mjs).
 * Mirrors what the Nix module renders from settings.toml: one neo-like
 * target (example-upstream/neo → example-bot/neo) and a second plugin
 * target, redaction terms, the public owners and a pinned reviewer. Tests
 * may override any of these per case; nothing here is a real identifier.
 */
/** The synthetic neo-like target (overrides merged in). */
export function neoTarget(overrides = {}) {
  return {
    upstream: "example-upstream/neo",
    fork: "example-bot/neo",
    baseRef: "master",
    flakeInput: "neo",
    protectedPaths: ["nix/services/ops", "nix/services/hermes", "nix/services/swag", "nix/modules/core"],
    basePaths: ["nix/modules/core"],
    ...overrides,
  };
}

const defaults = {
  OPS_TARGETS: JSON.stringify([neoTarget()]),
  OPS_REDACT_PATTERNS: "[A-Z0-9]{10}",
  OPS_REDACT_HOSTNAMES: "labhost-a,labhost-b,labhost-c",
  OPS_PUBLIC_OWNERS: "example-upstream,example-bot",
  OPS_PR_REVIEWERS: "example-upstream",
  OPS_PR_PINNED_REVIEWER_IDS: "example-upstream:12345678",
  OPS_PR_BOT_LOGIN: "example-bot",
  // Fixed zone (CET/CEST) so the time-format tests do not depend on the box.
  OPS_TIME_ZONE: "Europe/Berlin",
};
defaults.LABTEST_TARGETS = defaults.OPS_TARGETS;
for (const [k, v] of Object.entries(defaults)) if (process.env[k] === undefined) process.env[k] = v;
