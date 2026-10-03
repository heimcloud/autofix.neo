# One-release alias: settings written for the older plugin that declared
# neo.services.ops (same app, previous namespace). Every [services.ops] key
# is mapped onto neo.services.autofix with mkDefault (explicit
# [services.autofix] settings win), data stays in <appdata>/ops and the
# subdomain stays "ops", so swapping the plugin URL alone changes no data path.
#
# config.neo.services.ops itself only reads as a disabled stub: Neo iterates
# config.neo.services and must not see a second (raw) service there.
#
# Never install this plugin next to the older one: both declare
# neo.services.ops and evaluation fails (on purpose).
{...}: {
  flake.modules.nixos.autofix-legacy = {
    config,
    lib,
    options,
    ...
  }:
    with lib; let
      opt = options.neo.services.ops;
      defs = opt.definitions or [];
      raw = foldl' recursiveUpdate {} (filter isAttrs defs);
      used = defs != [] && raw != {};
      on = used && (raw.enabled or false);
      r = raw;
      a = r.autofix or {};
      lab = a.lab or {};
      pr = a.pr or {};
      appdataRoot = config.neo.core.volumes.appdata;
      pick = keys: set: filterAttrs (n: _: elem n keys) set;
      # Defaults of the older plugin for the neo framework target.
      legacyDenyPaths = a.denyPaths or ["nix/services/ops" "nix/services/hermes" "nix/services/swag" "nix/modules/core"];
      legacyBasePaths = a.basePaths or ["nix/modules/core"];
      isNeo = t: let
        parts = splitString "/" (t.upstream or "");
      in
        length parts == 2 && toLower (elemAt parts 1) == "neo";
      mapTarget = t:
        removeAttrs t ["fork"]
        // optionalAttrs (t ? fork && t.fork != null) {inherit (t) fork;}
        // optionalAttrs (isNeo t) (
          optionalAttrs ((t.baseRef or null) == null && a ? neoBaseRef) {baseRef = a.neoBaseRef;}
          // optionalAttrs ((t.flakeInput or null) == null) {flakeInput = lab.input or "neo";}
          // optionalAttrs ((t.flakeUrl or null) == null && lab ? flakeUrl) {inherit (lab) flakeUrl;}
          // optionalAttrs ((t.protectedPaths or null) == null) {protectedPaths = legacyDenyPaths;}
          // optionalAttrs ((t.basePaths or null) == null) {basePaths = legacyBasePaths;}
        )
        // optionalAttrs (!(isNeo t) && (t.protectedPaths or null) == null) {protectedPaths = [];};
      legacyTargets = map mapTarget (r.targets or []);
      reviewers = optional (pr ? reviewerLogin) pr.reviewerLogin;
      pins = optionalAttrs (pr ? reviewerLogin && pr ? reviewerId) {${pr.reviewerLogin} = pr.reviewerId;};
      termsFile =
        a.redactExtraSlugsFile or (r.redactExtraSlugsFile or "${appdataRoot}/ops/redact-extra.env");
      # mkDefault on every leaf (lists count as leaves), so a single explicit
      # [services.autofix] key overrides just that key.
      deepDefault = v:
        if isAttrs v && !isDerivation v
        then mapAttrs (_: deepDefault) v
        else mkDefault v;
      ignored = filter (k: r ? ${k}) ["githubToken" "siteUrl" "targetAllowlist" "containers"];
    in {
      options.neo.services.ops = mkOption {
        type = types.attrsOf types.anything;
        default = {};
        internal = true;
        visible = false;
        description = "Deprecated alias of neo.services.autofix (one release).";
        apply = _: {
          enabled = false;
          meta = {
            icon = null;
            description = "Deprecated: use [services.autofix].";
            projectUrl = null;
            githubUrl = null;
            releaseUrl = null;
            screenshots = [];
            rank = null;
            iframeCompatible = true;
            category = "Other";
          };
        };
      };

      config = {
        neo.services.autofix = mkIf used (deepDefault (
          pick ["enabled" "ingestSecret" "subdomain" "auth" "vpn"] r
          // {
            subdomain = r.subdomain or "ops";
            appdata = "${appdataRoot}/ops";
            redact = {
              inherit termsFile;
              # The older plugin always redacted 10-character upper-case ids.
              patterns = ["[A-Z0-9]{10}"];
            };
          }
          // optionalAttrs (r ? admin) {admin = r.admin;}
          // optionalAttrs (r ? targets) {targets = legacyTargets;}
          // optionalAttrs (r ? autofix) {
            autofix =
              pick ["enable" "triage" "fix" "maxAttempts" "labSharesOpsHost" "hermesTimeoutSec"] a
              // optionalAttrs (a ? lab) {
                lab = removeAttrs lab ["input" "flakeUrl"];
              }
              // optionalAttrs (a ? pr) {
                pr =
                  pick ["enable" "pollMinutes" "botLogin" "maxRounds" "stopPhrase" "draft"] pr
                  // optionalAttrs (reviewers != []) {inherit reviewers;}
                  // optionalAttrs (pins != {}) {pinnedReviewerIds = pins;};
              };
          }
        ));

        assertions = optional on {
          assertion = all (t: t ? fork && t.fork != null) (r.targets or []);
          message = "[services.ops] (deprecated alias): every [[services.ops.targets]] entry now needs `fork = \"<owner>/<repo>\"`.";
        };

        warnings =
          optional used "[services.ops] is deprecated: move the settings to [services.autofix] (this alias goes away in the next release)."
          ++ optional (used && ignored != []) "[services.ops]: ignored keys ${concatStringsSep ", " ignored} (no longer used)."
          ++ optional (on && (a.enable or false) && !(any isNeo (r.targets or [])))
          "[services.ops]: there is no built-in neo target any more; add a [[services.ops.targets]] entry for it (upstream + fork) if fixes should go to neo.";
      };
    };
}
