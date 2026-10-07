# Autofix service implementation: the incident desk container (OCI image from
# this flake's packages) and the exchange dirs it shares with the host worker.
{self, ...}: {
  flake.modules.nixos.autofix = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.autofix;
      # Host data dir (internal option `appdata`).
      opsAppdata = cfg.appdata;
      appImage = self.packages.${pkgs.stdenv.hostPlatform.system}.neo-autofix;
      # The container runs as the Neo core user, the uid/gid every other Neo
      # container uses. Never hardcode the numbers.
      uid = toString config.neo.core.uid;
      gid = toString config.neo.core.gid;
      af = cfg.autofix;
      autofixOn = af.enable;
      triageOn = autofixOn && af.triage.enable;
      fixOn = autofixOn && af.fix.enable;
      prOn = fixOn && af.pr.enable;
      autoTriage = triageOn && af.triage.autoEnqueue;
      boolStr = b:
        if b
        then "true"
        else "false";
      adminPath = let
        p = cfg.admin.path or "/admin";
      in
        if lib.hasSuffix "/" p && p != "/"
        then lib.removeSuffix "/" p
        else p;
      targets = import ../../../lib/targets.nix {inherit lib cfg;};
      env = import ../../../lib/env.nix {inherit lib config cfg targets;};
      # Only whether a token is configured (never its value). The worker's
      # runtime check (queue/worker-status.json) overrides this hint.
      tokenConfigured = env.tokenConfigured;
      ingestSecretMount = "/run/autofix/ingest-secret";

      # Shared exchange dirs (host side of the container's /data/queue,
      # /data/results, /data/state). Owner = Neo core uid, group = core gid, 2770:
      #  - the container (core uid:gid, no supplementary groups) writes jobs as owner;
      #  - the hermes worker gets rwx via membership in the core group (autofix.nix);
      #  - setgid keeps every file/subdir in the core group no matter who creates it.
      # Created even with autofix off so the app never hits EACCES.
      exchangeDirs = map (d: "${opsAppdata}/${d}") [
        "queue"
        "queue/triage"
        "queue/fix"
        "queue/push"
        "queue/lab"
        "queue/pr"
        "queue/processing"
        "queue/done"
        "queue/failed"
        "queue/control"
        "results"
        "state"
      ];
      ensureExchangeDirs = pkgs.writeShellScript "neo-autofix-ensure-dirs" ''
        set -eu
        ${pkgs.coreutils}/bin/install -d -m 2770 -o ${uid} -g ${gid} ${concatStringsSep " " exchangeDirs}
      '';
    in {
      config = mkIf cfg.enabled {
        assertions = [
          {
            assertion = length (unique (map (t: toLower (head (splitString "/" t.fork))) cfg.targets)) <= 1;
            message = "neo.services.autofix.targets: every fork must belong to the same GitHub account (the token's owner).";
          }
          {
            assertion = !(fixOn || triageOn) || cfg.targets != [];
            message = "neo.services.autofix.autofix: triage/fix need at least one entry in neo.services.autofix.targets.";
          }
        ];

        # Boot/activation-time creation + ownership repair (tmpfiles "d" adjusts
        # mode/owner of existing dirs, not their contents).
        systemd.tmpfiles.rules = map (d: "d ${d} 2770 ${uid} ${gid} -") exchangeDirs;

        # Belt and braces on every container (re)start: fixes dirs left root-owned.
        systemd.services."${config.virtualisation.oci-containers.backend}-autofix".preStart =
          (lib.neo.mkEnsureDirs config [opsAppdata])
          + ''
            ${ensureExchangeDirs}
          '';

        virtualisation.oci-containers.containers.autofix = {
          environment =
            filterAttrs (_: v: v != null && v != "") {
              OPS_INGEST_SECRET =
                if cfg.ingestSecretFile == null
                then cfg.ingestSecret
                else null;
              OPS_INGEST_SECRET_FILE =
                if cfg.ingestSecretFile != null
                then ingestSecretMount
                else null;
            }
            // env.redactEnv
            // {
              TZ = env.timeZone;
              OPS_TIME_ZONE = env.timeZone;
              PORT = "3000";
              NODE_ENV = "production";
              OPS_DB_PATH = "/data/ops.sqlite";
              OPS_DATA_DIR = "/data";
              OPS_AUTOTRIAGE = boolStr autoTriage;
              # Gate the admin "Start fix"/triage buttons: without a host worker a
              # queued job would never be picked up.
              OPS_AUTOFIX_FIX = boolStr fixOn;
              OPS_AUTOFIX_TRIAGE = boolStr triageOn;
              # Automated lab stage: queued/running lab tests are worker progress, not a human task.
              OPS_AUTOFIX_LAB = boolStr (fixOn && af.lab.enable);
              # Shown in the "Approve lab test" confirm (protected-path fixes).
              OPS_LAB_PROTECTED_WATCHDOG_SEC = toString af.lab.protectedWatchdogSec;
              OPS_AUTOFIX_TOKEN_CONFIGURED = boolStr tokenConfigured;
              OPS_TARGETS = builtins.toJSON targets;
              # PR loop: "Skip lab" queues a draft PR, "Open the PR now", validation button.
              OPS_AUTOFIX_PR = boolStr prOn;
              ADMIN_ENABLED = boolStr cfg.admin.enabled;
              ADMIN_PATH = adminPath;
              ADMIN_READ_ONLY = boolStr cfg.admin.readOnly;
              OPS_PUBLIC_REPORTS = boolStr cfg.publicReports.enable;
            };
          # Host EnvironmentFile → container env (OPS_REDACT_EXTRA_SLUGS). The file
          # must exist when set, or docker --env-file fails.
          environmentFiles = lib.optional (cfg.redact.termsFile != null) cfg.redact.termsFile;
          image = cfg.containers.autofix;
          imageFile = appImage;
          user = "${uid}:${gid}";
          autoStart = true;
          volumes =
            [
              "${opsAppdata}:/data"
            ]
            ++ optional (cfg.ingestSecretFile != null) "${cfg.ingestSecretFile}:${ingestSecretMount}:ro";
          networks = ["internal"];
        };
      };
    };
}
