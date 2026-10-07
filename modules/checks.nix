# nix flake check: the token scripts and NixOS evaluation tests with Neo (namespace,
# assertions). The app/worker suite needs a normal
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
    swagExtra = n: lib.splitString "," (n.config.virtualisation.oci-containers.containers.swag.environment.EXTRA_DOMAINS or "");
    off = mkHost base;
    bad = settings: mkHost (lib.recursiveUpdate base settings);
    failed = n: lib.filter (a: !a.assertion) n.config.assertions;
    envOf = n: n.config.virtualisation.oci-containers.containers.autofix.environment;
    unitEnv = n: u: n.config.systemd.services.${u}.serviceConfig.Environment;
    hasEnv = n: u: e: lib.elem e (unitEnv n u);
    oc = on.config;
    onEnv = envOf on;
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
      [
        "on: worker-env.json = unit env, unquoted"
        (let
          j = builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile oc.environment.etc."neo-autofix/worker-env.json".source));
        in
          j.OPS_AUTOFIX_PR == "1" && j.OPS_REDACT_PATTERNS == "ZZ[0-9]{8}" && j.OPS_DATA_DIR == "/var/neo/DATA/AppData/autofix" && j.OPS_PR_REVIEWERS == "example-upstream" && !(lib.any (k: lib.hasInfix "TOKEN=" k) (lib.attrNames j)))
      ]
      ["on: neo-autofix-check installed" (lib.any (p: (p.name or "") == "neo-autofix-check") oc.environment.systemPackages)]
      # --- off
      ["off: no container" (!(off.config.virtualisation.oci-containers.containers ? autofix))]
      ["off: no worker" (!(off.config.systemd.services ? neo-autofix-worker))]
      ["off: no token unit" (!(off.config.systemd.services ? neo-autofix-token))]
      ["off: no worker-env.json" (!(off.config.environment.etc ? "neo-autofix/worker-env.json"))]
      ["off: no failed assertions" (failed off == [])]
      # --- assertions
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
    allExpect = expect;
    badExpect = lib.filter (e: !(builtins.elemAt e 1)) allExpect;
    tokenPkgs = import ../scripts/token/package.nix {
      inherit pkgs lib;
      forkOwner = "example-bot";
      checkRepo = "example-bot/neo";
    };
  in {
    checks = {
      eval =
        if badExpect == []
        then pkgs.runCommand "autofix-eval-tests" {} "echo ${toString (builtins.length allExpect)} expectations ok > $out"
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
