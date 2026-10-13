/** PR titles `<unit>/<fix|feat>: <summary>` (v0.3.4). Synthetic data only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrTitle, unitFromName, unitFromPaths, sanitizeSummary, PR_TITLE_MAX } from "../lib/pr-title.js";

const FORMAT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/(fix|feat): \S.*$/;

test("Hermes' summary from the diff, prefix stripped, unit from the incident", () => {
  const t = buildPrTitle({
    unit: "neo-web.service",
    paths: ["cli/src/commands/web/routes/changes.rs"],
    candidates: ["fix: Clear stale activation job after aborted CLI update."],
  });
  assert.equal(t, "web/fix: clear stale activation job after aborted CLI update");
  assert.match(t, FORMAT);
});

test("unit: systemd names, then the changed paths, then ops", () => {
  assert.equal(unitFromName("docker-nextcloud.service"), "nextcloud");
  assert.equal(unitFromName("tailscaled.service"), "tailscaled");
  assert.equal(unitFromName("hermes-agent.service"), "hermes-agent");
  assert.equal(unitFromName("neo-autofix-labtest@lab-1.service"), "autofix-labtest");
  assert.equal(unitFromName("neo-web.service"), "web");
  assert.equal(unitFromName("docker-swag.service"), "swag");
  assert.equal(unitFromName("[redacted-host]"), null);
  assert.equal(unitFromPaths(["nix/services/swag/default.nix", "nix/services/swag/x.nix", "cli/src/a.rs"]), "swag");
  assert.equal(unitFromPaths(["cli/src/commands/activate.rs"]), "cli");
  assert.equal(buildPrTitle({ unit: "", paths: ["cli/src/utils/locks.rs"], candidates: ["release the system lock when activation aborts"] }), "cli/fix: release the system lock when activation aborts");
  assert.match(buildPrTitle({ candidates: ["release the system lock when activation aborts"] }), /^ops\/fix: /);
});

test("feat only for admin feature requests", () => {
  assert.equal(
    buildPrTitle({ unit: "", paths: ["cli/src/commands/activate.rs"], requestType: "feature", candidates: [undefined, "", "Add a --lock-wait flag to neo activate"] }),
    "cli/feat: add a --lock-wait flag to neo activate",
  );
  assert.match(buildPrTitle({ unit: "docker-swag.service", requestType: "bug", candidates: ["renew certificates before they expire"] }), /^swag\/fix: /);
});

test("redaction: candidates with slugs, hosts, domains, IPs or emails are dropped, never shown", () => {
  const leaky = [
    "fix proxy on labhost-a.example.org",
    "allow 192.0.2.10 through the firewall",
    "notify alice@example.net about failures",
    "repair config of acme-corp tenant",
  ];
  const t = buildPrTitle({ unit: "docker-swag.service", paths: ["nix/services/swag/default.nix"], candidates: leaky, slugs: ["acme-corp"] });
  assert.equal(t, "swag/fix: adjust nix/services/swag");
  for (const bad of ["example.org", "192.0.2.10", "example.net", "acme-corp", "redacted"]) assert.equal(t.includes(bad), false, bad);
  for (const c of leaky) assert.equal(sanitizeSummary(c, ["acme-corp"]), null, c);
});

test("fallbacks: no incident ids, no generic text", () => {
  for (const c of ["ops: incident #47 (high)", "fix incident 47", "update", "fix", "Automated fix", "fixes #12 crash", "wip"]) assert.equal(sanitizeSummary(c), null, c);
  const t = buildPrTitle({ unit: "docker-searxng.service", paths: ["nix/services/searxng/default.nix"], candidates: ["ops: incident #47 (high)", "update"] });
  assert.equal(t, "searxng/fix: adjust nix/services/searxng");
  assert.equal(buildPrTitle({ unit: "docker-searxng.service" }), "searxng/fix: handle the reported searxng failure");
  assert.doesNotMatch(buildPrTitle({ unit: "x" }), /#\d|incident/);
});

test("length: at most 72 characters, cut at a clause or word boundary", () => {
  const t = buildPrTitle({ unit: "neo-web.service", candidates: ["clear the stale activation job after an aborted CLI update so that the next activation from the web UI is not blocked by a leftover lock"] });
  assert.ok(t.length <= PR_TITLE_MAX, t);
  assert.equal(t, "web/fix: clear the stale activation job after an aborted CLI update");
  const w = buildPrTitle({ unit: "neo-web.service", candidates: ["clear stale activation jobs and leftover locks and temporary state directories and caches everywhere"] });
  assert.ok(w.length <= PR_TITLE_MAX && !/\s$/.test(w), w);
  assert.match(w, FORMAT);
});

test("multi-word units stay whole (PR #22 read `auto/fix`)", () => {
  const c = ["restart the updater after a failed run"];
  assert.match(buildPrTitle({ unit: "neo-auto-update.service", candidates: c }), /^auto-update\/fix: /);
  assert.match(buildPrTitle({ unit: "neo-system-updater.service", candidates: c }), /^system-updater\/fix: /);
  assert.match(buildPrTitle({ unit: "neo-home-assistant.service", candidates: c }), /^home-assistant\/fix: /);
  assert.equal(buildPrTitle({ unit: "neo-auto-update.service", candidates: c }), "auto-update/fix: restart the updater after a failed run");
  // Path fallback unchanged.
  assert.equal(unitFromPaths(["nix/services/home-assistant/default.nix"]), "home");
});
