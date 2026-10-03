# nix flake check: the token scripts and NixOS evaluation tests with Neo (new
# namespace, legacy alias, assertions). The app/worker suite needs a normal
# host (loopback HTTP, file ownership, /usr/bin/env): `cd app && npm ci && npm test`.
{
  inputs,
  self,
  ...
}: {
  perSystem = {
    pkgs,
    lib,
    system,
    ...
  }: let
    mkHost = neo:
      inputs.nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs.lib = inputs.neo.lib;
        modules = [
          inputs.neo.nixosModules.default
          inputs.neo.nixosModules.base
          self.nixosModules.default
          {
            inherit neo;
            fileSystems."/" = {
              device = "none";
              fsType = "tmpfs";
            };
            boot.loader.grub.devices = ["nodev"];
          }
        ];
      };
    base = {
      core.hostname = "labhost-a";
      services.swag.domain = "example.net";
      services.hermes = {
        enabled = true;
        dashboardPassword = "test-only-not-a-secret";
      };
    };
    neoTarget = {
      upstream = "example-upstream/neo";
      fork = "example-bot/neo";
      flakeInput = "neo";
      protectedPaths = ["nix/services/hermes" "nix/modules/core"];
      basePaths = ["nix/modules/core"];
    };
    pluginTarget = {
      upstream = "example-upstream/example.neo";
      fork = "example-bot/example.neo";
      baseRef = "main";
      reviewers = ["example-maintainer"];
    };
    allOn = {
      enable = true;
      triage = {
        enable = true;
        autoEnqueue = true;
      };
      fix.enable = true;
      lab.enable = true;
      pr = {
        enable = true;
        reviewers = ["example-upstream"];
      };
    };
    on = mkHost (lib.recursiveUpdate base {
      services.autofix = {
        enabled = true;
        ingestSecretFile = "/var/lib/autofix-test/ingest.secret";
        github.tokenFile = "/var/lib/autofix-test/github.token";
        targets = [neoTarget pluginTarget];
        redact = {
          termsFile = "/var/lib/autofix-test/redact.env";
          hostnames = ["labhost-b"];
          patterns = ["ZZ[0-9]{8}"];
        };
        autofix = allOn;
      };
    });
    legacy = mkHost (lib.recursiveUpdate base {
      services.ops = {
        enabled = true;
        ingestSecret = "test-only";
        siteUrl = "https://ops.example.net";
        targets = [
          {
            upstream = "example-upstream/neo";
            fork = "example-bot/neo";
          }
          pluginTarget
        ];
        autofix =
          allOn
          // {
            neoBaseRef = "dev";
            pr = {
              enable = true;
              reviewerLogin = "example-upstream";
              reviewerId = 12345678;
            };
          };
      };
    });
    off = mkHost base;
    bad = settings: mkHost (lib.recursiveUpdate base settings);
    failed = n: lib.filter (a: !a.assertion) n.config.assertions;
    envOf = n: n.config.virtualisation.oci-containers.containers.autofix.environment;
    unitEnv = n: u: n.config.systemd.services.${u}.serviceConfig.Environment;
    hasEnv = n: u: e: lib.elem e (unitEnv n u);
    oc = on.config;
    lc = legacy.config;
    onEnv = envOf on;
    lEnv = envOf legacy;
    lTargets = builtins.fromJSON lEnv.OPS_TARGETS;
    expect = [
      # --- new namespace
      ["on: no failed assertions" (failed on == [])]
      ["on: targets carry fork + paths" (let t = builtins.head (builtins.fromJSON onEnv.OPS_TARGETS); in t.fork == "example-bot/neo" && t.protectedPaths == neoTarget.protectedPaths && !(t ? baseRef))]
      ["on: public owners" (onEnv.OPS_PUBLIC_OWNERS == "example-upstream,example-bot")]
      ["on: redact hostnames incl. own" (onEnv.OPS_REDACT_HOSTNAMES == "labhost-a,labhost-b")]
      ["on: redact patterns" (onEnv.OPS_REDACT_PATTERNS == "ZZ[0-9]{8}")]
      ["on: ingest secret file mounted" (onEnv.OPS_INGEST_SECRET_FILE == "/run/autofix/ingest-secret" && lib.elem "/var/lib/autofix-test/ingest.secret:/run/autofix/ingest-secret:ro" oc.virtualisation.oci-containers.containers.autofix.volumes)]
      ["on: data dir" (lib.elem "/var/neo/DATA/AppData/autofix:/data" oc.virtualisation.oci-containers.containers.autofix.volumes)]
      ["on: terms file" (oc.virtualisation.oci-containers.containers.autofix.environmentFiles == ["/var/lib/autofix-test/redact.env"])]
      ["on: token configured hint" (onEnv.OPS_AUTOFIX_TOKEN_CONFIGURED == "true")]
      ["on: time zone" (onEnv.OPS_TIME_ZONE != "")]
      ["on: subdomain" (oc.neo.services.autofix.subdomain == "autofix")]
      ["on: proxy upstream" (lib.hasInfix "set $upstream_app autofix;" oc.neo.services.autofix.proxyConf && lib.hasInfix "server_name autofix.*;" oc.neo.services.autofix.proxyConf)]
      ["on: worker reviewers" (hasEnv on "neo-autofix-worker" "OPS_PR_REVIEWERS=example-upstream")]
      ["on: worker bot login = fork owner" (hasEnv on "neo-autofix-worker" "OPS_PR_BOT_LOGIN=example-bot")]
      ["on: worker redact env" (hasEnv on "neo-autofix-worker" "\"OPS_REDACT_PATTERNS=ZZ[0-9]{8}\"")]
      ["on: worker base-refs cache" (hasEnv on "neo-autofix-worker" "OPS_BASE_REFS_FILE=/var/neo/DATA/AppData/autofix/state/base-refs.json")]
      ["on: lab unit name" (hasEnv on "neo-autofix-labtest@" "LABTEST_OPS_UNIT=docker-autofix.service")]
      ["on: lab has no single-target hooks" (!(lib.any (e: lib.hasPrefix "LABTEST_INPUT=" e || lib.hasPrefix "LABTEST_PROTECTED_PATHS=" e) (unitEnv on "neo-autofix-labtest@")))]
      ["on: token unit" (oc.systemd.services ? neo-autofix-token)]
      ["on: worker wants token unit" (lib.elem "neo-autofix-token.service" oc.systemd.services.neo-autofix-worker.wants)]
      ["on: token activation" (oc.system.activationScripts ? neo-autofix-token)]
      ["on: polkit rule" (lib.hasInfix "neo-autofix-labtest@lab-" oc.security.polkit.extraConfig)]
      ["on: ops stub disabled" (oc.neo.services.ops.enabled == false)]
      ["on: no legacy warning" (!(lib.any (w: lib.hasInfix "[services.ops]" w) oc.warnings))]
      # --- legacy alias
      ["legacy: no failed assertions" (failed legacy == [])]
      ["legacy: enabled via alias" (lc.neo.services.autofix.enabled && lc.neo.services.autofix.autofix.pr.enable)]
      ["legacy: stub disabled" (lc.neo.services.ops.enabled == false)]
      ["legacy: subdomain ops" (lc.neo.services.autofix.subdomain == "ops")]
      ["legacy: data stays in ops" (lib.elem "/var/neo/DATA/AppData/ops:/data" lc.virtualisation.oci-containers.containers.autofix.volumes)]
      ["legacy: worker data dir" (hasEnv legacy "neo-autofix-worker" "OPS_DATA_DIR=/var/neo/DATA/AppData/ops")]
      ["legacy: terms file default" (lc.virtualisation.oci-containers.containers.autofix.environmentFiles == ["/var/neo/DATA/AppData/ops/redact-extra.env"])]
      ["legacy: id pattern" (lEnv.OPS_REDACT_PATTERNS == "[A-Z0-9]{10}")]
      ["legacy: neo target baseRef/input/paths" (let t = builtins.head lTargets; in t.baseRef == "dev" && t.flakeInput == "neo" && lib.elem "nix/services/ops" t.protectedPaths && t.basePaths == ["nix/modules/core"])]
      ["legacy: plugin target untouched" (let t = builtins.elemAt lTargets 1; in t.baseRef == "main" && t.protectedPaths == [] && t.reviewers == ["example-maintainer"])]
      ["legacy: reviewer + pinned id" (hasEnv legacy "neo-autofix-worker" "OPS_PR_REVIEWERS=example-upstream" && hasEnv legacy "neo-autofix-worker" "OPS_PR_PINNED_REVIEWER_IDS=example-upstream:12345678")]
      ["legacy: deprecation warning" (lib.any (w: lib.hasInfix "[services.ops] is deprecated" w) lc.warnings)]
      ["legacy: ignored keys warning" (lib.any (w: lib.hasInfix "siteUrl" w) lc.warnings)]
      [
        "legacy: explicit [services.autofix] key wins"
        (let
          n = bad {
            services.ops = {
              enabled = true;
              subdomain = "ops";
            };
            services.autofix.subdomain = "desk";
          };
        in
          n.config.neo.services.autofix.subdomain == "desk" && n.config.neo.services.autofix.enabled)
      ]
      # --- off
      ["off: no container" (!(off.config.virtualisation.oci-containers.containers ? autofix))]
      ["off: no worker" (!(off.config.systemd.services ? neo-autofix-worker))]
      ["off: no token unit" (!(off.config.systemd.services ? neo-autofix-token))]
      ["off: no failed assertions" (failed off == [])]
      # --- assertions
      [
        "legacy target without fork fails"
        (failed (bad {
            services.ops = {
              enabled = true;
              targets = [{upstream = "example-upstream/neo";}];
            };
          })
          != [])
      ]
      [
        "forks of two owners fail"
        (failed (bad {
            services.autofix = {
              enabled = true;
              targets = [
                neoTarget
                (pluginTarget // {fork = "someone-else/example.neo";})
              ];
            };
          })
          != [])
      ]
      [
        "fix without targets fails"
        (failed (bad {
            services.autofix = {
              enabled = true;
              autofix = {
                enable = true;
                fix.enable = true;
              };
            };
          })
          != [])
      ]
    ];
    badExpect = lib.filter (e: !(builtins.elemAt e 1)) expect;
    tokenPkgs = import ../scripts/token/package.nix {
      inherit pkgs lib;
      forkOwner = "example-bot";
      checkRepo = "example-bot/neo";
    };
  in {
    checks = {
      eval =
        if badExpect == []
        then pkgs.runCommand "autofix-eval-tests" {} "echo ${toString (builtins.length expect)} expectations ok > $out"
        else throw "autofix eval tests failed: ${lib.concatMapStringsSep ", " builtins.head badExpect}";
      token-scripts =
        pkgs.runCommand "autofix-token-tests" {
          nativeBuildInputs = [pkgs.bash pkgs.git pkgs.python3 pkgs.coreutils pkgs.gnugrep pkgs.gnused pkgs.openssl pkgs.iproute2 pkgs.util-linux pkgs.shellcheck pkgs.getent];
        } ''
          cp -r ${self} src
          chmod -R u+w src
          cd src
          patchShebangs scripts/token
          shellcheck -S warning scripts/token/*.sh
          bash scripts/token/test-local.sh
          # The shipped (built) scripts carry no placeholder.
          ! grep -qE '@(helper|git|forkOwner|checkRepo|extract|owner|group|source)@' \
            ${tokenPkgs.envWrapper}/bin/neo-autofix-env ${tokenPkgs.helper}/bin/neo-autofix-git-credential ${tokenPkgs.materialize}
          touch $out
        '';
    };
  };
}
