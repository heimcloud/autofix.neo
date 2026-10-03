# Opt-in host-side autofix runner (default OFF). Does not start unless enable=true.
#
# Exchange dirs (queue/*, results, state) are created by default.nix for every host
# (owner = Neo core uid, group = Neo core gid, 2770 setgid). Here we only:
#  - add hermes to the Neo core group so the worker can claim jobs / write results;
#  - install the path + oneshot worker units and the two Hermes skills;
#  - install the root kick timer (self-lockout watchdog, see below);
#  - with autofix.lab.enable: the root lab runner neo-autofix-labtest@ and a
#    polkit rule that lets hermes start exactly that unit (see below).
{self, ...}: {
  flake.modules.nixos.autofix-runner = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.autofix;
      af = cfg.autofix;
      enabled = cfg.enabled && af.enable;
      triageOn = enabled && af.triage.enable;
      fixOn = enabled && af.fix.enable;
      workerOn = triageOn || fixOn;
      lab = af.lab;
      labOn = fixOn && lab.enable;
      pr = af.pr;
      prOn = fixOn && pr.enable;
      # Store file, not an Environment= value: systemd strips the JSON quotes.
      targets = import ../../../lib/targets.nix {inherit lib cfg;};
      env = import ../../../lib/env.nix {inherit lib config cfg targets;};
      targetsFile = pkgs.writeText "neo-autofix-targets.json" (builtins.toJSON targets);
      # Environment= entry with spaces / quotes / backslashes kept intact
      # (and no systemd %-specifier expansion).
      envQ = s: "\"${lib.replaceStrings ["%"] ["%%"] (lib.escape ["\\" "\""] s)}\"";
      redactEnvList = mapAttrsToList (k: v: envQ "${k}=${v}") env.redactEnv;
      redactFile = cfg.redact.termsFile;
      pinsStr = concatStringsSep "," (mapAttrsToList (l: id: "${l}:${toString id}") pr.pinnedReviewerIds);
      botLogin =
        if pr.botLogin != null
        then pr.botLogin
        else env.forkOwner;
      # Upper bound of one lab run (lock wait + build + activation + settle +
      # generic/incident checks + rollback), used for unit timeouts / worker wait.
      labRunSec = lab.lockWaitSec + lab.buildTimeoutSec + lab.activateTimeoutSec + lab.settleSec + 180 + 20 * lab.checkTimeoutSec + lab.activateTimeoutSec + 300;
      labUnitRe = "^neo-autofix-labtest@lab-[0-9]{1,9}-[A-Za-z0-9-]{1,80}\\.service$";
      opsAppdata = cfg.appdata;
      queueRoot = "${opsAppdata}/queue";
      workerPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.neo-autofix-worker;
      hermesState = config.neo.services.hermes.stateDir or "${config.neo.core.volumes.appdata}/hermes";
      hermesHome = "${hermesState}/.hermes";
      uid = toString config.neo.core.uid;
      gid = config.neo.core.gid;

      # Neo core defines users.groups.homeserver.gid = neo.core.gid (the gid the
      # app container runs as). Literal name avoids evaluating users.groups inside
      # users.users (module-system recursion); the assertion checks the gid matches.
      coreGroup = "homeserver";

      triageSkill = ../../../skills/autofix-triage/SKILL.md;
      fixSkill = ../../../skills/autofix-fix/SKILL.md;
      labSkill = ../../../skills/autofix-labtest/SKILL.md;

      skillStore = pkgs.runCommand "neo-autofix-skills" {} ''
        mkdir -p $out/autofix-triage $out/autofix-fix $out/autofix-labtest
        cp ${triageSkill} $out/autofix-triage/SKILL.md
        cp ${fixSkill} $out/autofix-fix/SKILL.md
        cp ${labSkill} $out/autofix-labtest/SKILL.md
      '';

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
      # Runs as root (ExecStartPre=+) so a root-owned leftover never blocks the worker.
      ensureDirs = pkgs.writeShellScript "neo-autofix-worker-ensure-dirs" ''
        set -eu
        ${pkgs.coreutils}/bin/install -d -m 2770 -o ${uid} -g ${toString gid} ${concatStringsSep " " exchangeDirs}
      '';

      workerEnv =
        [
          "OPS_DATA_DIR=${opsAppdata}"
          "OPS_AUTOFIX_LOCK=/run/neo-autofix-worker/lock"
          "OPS_AUTOFIX_MAX_ATTEMPTS=${toString af.maxAttempts}"
          "OPS_AUTOFIX_LAB_SHARES_OPS_HOST=${
            if af.labSharesOpsHost
            then "true"
            else "false"
          }"
          "OPS_TARGETS_FILE=${targetsFile}"
          "OPS_BASE_REFS_FILE=${opsAppdata}/state/base-refs.json"
          (envQ "OPS_TIME_ZONE=${env.timeZone}")
          "OPS_AUTOFIX_HERMES_TIMEOUT_SEC=${toString af.hermesTimeoutSec}"
          "OPS_DB_PATH=${opsAppdata}/ops.sqlite"
          "HOME=${hermesState}"
          "HERMES_HOME=${hermesHome}"
          "HERMES_MANAGED=true"
          # Rust builds for neo cli changes: shared target dir outside the clone
          # (never committed), openssl-sys via pkg-config/explicit dirs.
          "CARGO_TARGET_DIR=${hermesState}/.cache/neo-autofix-cargo-target"
          "PKG_CONFIG_PATH=${pkgs.openssl.dev}/lib/pkgconfig"
          "OPENSSL_LIB_DIR=${getLib pkgs.openssl}/lib"
          "OPENSSL_INCLUDE_DIR=${pkgs.openssl.dev}/include"
        ]
        ++ redactEnvList
        ++ optional (botLogin != null) "OPS_PR_BOT_LOGIN=${botLogin}"
        ++ optional triageOn "OPS_AUTOFIX_TRIAGE=1"
        ++ optional fixOn "OPS_AUTOFIX_FIX=1"
        ++ optionals labOn [
          "OPS_AUTOFIX_LAB=1"
          "OPS_AUTOFIX_LAB_STATE_DIR=/var/lib/neo-autofix-labtest"
          "OPS_AUTOFIX_LAB_WAIT_SEC=${toString (labRunSec + 600)}"
          "OPS_AUTOFIX_LAB_PLAN_TIMEOUT_SEC=${toString lab.planTimeoutSec}"
          "OPS_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
        ]
        ++ optionals prOn [
          "OPS_AUTOFIX_PR=1"
          "OPS_AUTOFIX_PR_BIN=${workerPkg}/bin/neo-autofix-pr"
          # The one token (github.token / tokenFile, classic PAT), see token.nix.
          "OPS_PR_TOKEN_FILE=/run/neo-autofix/github-token"
          "OPS_AUTOFIX_PR_STATE_DIR=${hermesState}/workspace/autofix-pr"
          "OPS_PR_REVIEWERS=${concatStringsSep "," pr.reviewers}"
          "OPS_PR_PINNED_REVIEWER_IDS=${pinsStr}"
          "OPS_PR_MAX_ROUNDS=${toString pr.maxRounds}"
          (envQ "OPS_PR_STOP_PHRASE=${pr.stopPhrase}")
          "OPS_PR_POLL_MINUTES=${toString pr.pollMinutes}"
          "OPS_PR_DRAFT=${
            if pr.draft
            then "1"
            else "0"
          }"
        ];

      workerPath =
        [workerPkg pkgs.nodejs_22 pkgs.git pkgs.gh pkgs.openssh pkgs.sqlite pkgs.bash pkgs.coreutils pkgs.util-linux]
        ++ af.extraPackages
        ++ hermesUnitPath
        ++ ["/run/current-system/sw" "/etc/profiles/per-user/hermes"];

      hasMaterialize = config.systemd.services ? neo-autofix-token;
      hermesUnitPath = config.systemd.services.hermes-agent.path or [];
    in {
      config = mkIf enabled {
        assertions = [
          {
            assertion = config.neo.services.hermes.enabled or false;
            message = "neo.services.autofix.autofix.enable requires neo.services.hermes.enabled";
          }
          {
            assertion = !lab.enable || af.fix.enable;
            message = "neo.services.autofix.autofix.lab.enable requires autofix.fix.enable (lab jobs follow pushed fixes).";
          }
          {
            assertion = (config.users.groups.${coreGroup}.gid or null) == gid;
            message = "neo.services.autofix.autofix: users.groups.${coreGroup}.gid must equal neo.core.gid (the app container gid) so hermes can share the exchange dirs.";
          }
        ];

        # Shared group: the container runs as core uid:gid; hermes joins that gid.
        # hermes already has passwordless sudo on Neo, so this grants nothing new.
        users.users.hermes.extraGroups = [coreGroup];
        # Hermes's terminal tool rebuilds PATH from the NixOS profiles, so the
        # toolchain must be in the hermes user profile too (not only the unit PATH).
        users.users.hermes.packages = af.extraPackages;

        environment.systemPackages = [workerPkg];
        # Same allowlist for interactive checks (`sudo -u hermes neo-autofix-worker
        # --check-token`, `neo-autofix-pr --check`): default OPS_TARGETS_FILE.
        environment.etc."neo-autofix/targets.json".source = targetsFile;

        # Materialize autofix skills into HERMES_HOME/skills. Store path is not under
        # *-neo-hermes-skills, so hermes-neo-skills neither prunes nor shadows it.
        system.activationScripts.neo-autofix-skills = lib.stringAfter ["users" "hermes-agent-setup"] ''
          # Subshell: activation snippets share one shell; do not leak set -eu.
          (
            set -euo pipefail
            skills_dir="${hermesHome}/skills"
            mkdir -p "$skills_dir"
            # Drop links into older skill stores of this plugin (renamed skills of
            # earlier releases); everything else in the dir is left alone.
            for dest in "$skills_dir"/*; do
              [ -L "$dest" ] || continue
              t="$(readlink "$dest")"
              case "$t" in
                ${skillStore}/*) ;;
                /nix/store/*-autofix-skills/*) rm -f "$dest" ;;
              esac
            done
            for name in autofix-triage autofix-fix autofix-labtest; do
              dest="$skills_dir/$name"
              src="${skillStore}/$name"
              if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf "$dest"; fi
              ln -sfn "$src" "$dest"
              chown -h hermes:hermes "$dest" 2>/dev/null || true
            done
            chown hermes:hermes "$skills_dir" 2>/dev/null || true
          )
        '';

        # Container writes /data/queue/<kind>/*.json == ${queueRoot}/<kind>/*.json on the host.
        # Only watch enabled kinds; the worker also ignores disabled kinds.
        # PathChanged (edge: a job file appears) instead of PathExistsGlob (level):
        # with the queue paused, or a job the worker leaves pending, a level trigger
        # re-fires as soon as the oneshot exits and hits the start limit, which
        # fails the path unit too (self-lockout). The worker drains until empty;
        # neo-autofix-worker-kick.timer covers anything enqueued while it exits.
        systemd.paths.neo-autofix-worker = mkIf workerOn {
          description = "Watch the autofix queue";
          wantedBy = ["multi-user.target"];
          pathConfig = {
            PathChanged =
              optional triageOn "${queueRoot}/triage"
              ++ optionals fixOn ["${queueRoot}/fix" "${queueRoot}/push"]
              ++ optional labOn "${queueRoot}/lab"
              ++ optional prOn "${queueRoot}/pr";
            Unit = "neo-autofix-worker.service";
          };
        };

        systemd.services.neo-autofix-worker = mkIf workerOn {
          description = "Autofix worker (local Hermes, concurrency 1)";
          # Re-materialize the GitHub token before every run (token.nix).
          wants = optional hasMaterialize "neo-autofix-token.service";
          after = optional hasMaterialize "neo-autofix-token.service";
          # hermes CLI + agent tools (same PATH as the hermes-agent gateway), git/gh/node
          # for the worker, and the system profile for neo-autofix-env.
          path = workerPath;
          # A switch (Neo activation, or the lab test's own activation of a fix
          # branch that changes the Hermes PATH) must not kill a running job; the
          # next start picks up the new unit.
          restartIfChanged = false;
          stopIfChanged = false;
          unitConfig = {
            ConditionPathExists = [opsAppdata];
            # Default is 5 starts / 10 s: a burst of Start triage clicks against an
            # idle worker could trip it. The worker exits 0 on per-job errors, so
            # the unit only fails on real breakage; the kick timer resets it.
            StartLimitIntervalSec = 120;
            StartLimitBurst = 30;
          };
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            # Results must be group-readable by the container (core gid via setgid dirs).
            UMask = "0007";
            RuntimeDirectory = "neo-autofix-worker";
            RuntimeDirectoryMode = "0700";
            WorkingDirectory = "${hermesState}/workspace";
            TimeoutStartSec = "${toString (af.hermesTimeoutSec
              * (af.maxAttempts + 1)
              + 900
              + (
                if labOn
                then labRunSec + 600 + lab.planTimeoutSec
                else 0
              ))}";
            ExecStartPre = ["+${ensureDirs}"];
            ExecStart = "${workerPkg}/bin/neo-autofix-worker --once";
            Environment = workerEnv;
            # Required (fail-closed): without extra slugs the redaction gate is weaker.
            EnvironmentFile = mkIf (redactFile != null) [redactFile];
          };
        };

        # Self-lockout watchdog (root, every 2 min): reset-failed on a failed /
        # start-limited worker path or service while jobs are pending, restart the
        # path watch if it is down, start the worker when jobs wait and the queue is
        # not paused, and report unit health to queue/systemd-status.json for the
        # admin worker panel. Only systemctl + that one file; no job handling.
        systemd.services.neo-autofix-worker-kick = mkIf workerOn {
          description = "Autofix worker watchdog";
          path = [workerPkg pkgs.nodejs_22 config.systemd.package];
          unitConfig.ConditionPathExists = [opsAppdata];
          serviceConfig = {
            Type = "oneshot";
            UMask = "0027";
            NoNewPrivileges = true;
            PrivateTmp = true;
            ExecStart = "${workerPkg}/bin/neo-autofix-worker --kick";
            Environment =
              [
                "OPS_DATA_DIR=${opsAppdata}"
                "OPS_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
              ]
              ++ optional triageOn "OPS_AUTOFIX_TRIAGE=1"
              ++ optional fixOn "OPS_AUTOFIX_FIX=1"
              ++ optional labOn "OPS_AUTOFIX_LAB=1"
              ++ optional prOn "OPS_AUTOFIX_PR=1";
          };
        };

        # PR loop poller (hermes, every pollMinutes): PR state (merged / closed)
        # and review feedback from the configured reviewer (login + numeric id)
        # on the PRs the loop opened; feedback queues a revise fix job. Polling,
        # not a webhook: the host takes no inbound GitHub traffic and needs
        # no webhook secret; 2-5 min latency is fine for a human review loop.
        systemd.services.neo-autofix-pr-poll = mkIf prOn {
          description = "Autofix: poll upstream PRs for state and review feedback";
          wants = optional hasMaterialize "neo-autofix-token.service";
          after = optional hasMaterialize "neo-autofix-token.service";
          path = [workerPkg pkgs.nodejs_22 pkgs.sqlite pkgs.coreutils];
          unitConfig.ConditionPathExists = [opsAppdata];
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            UMask = "0007";
            WorkingDirectory = "${hermesState}/workspace";
            TimeoutStartSec = "600";
            ExecStart = "${workerPkg}/bin/neo-autofix-worker --pr-poll";
            Environment = workerEnv;
            EnvironmentFile = mkIf (redactFile != null) [redactFile];
          };
        };
        systemd.timers.neo-autofix-pr-poll = mkIf prOn {
          description = "Autofix PR poll";
          wantedBy = ["timers.target"];
          timerConfig = {
            OnBootSec = "3min";
            OnUnitActiveSec = "${toString pr.pollMinutes}min";
            AccuracySec = "20s";
          };
        };
        systemd.timers.neo-autofix-worker-kick = mkIf workerOn {
          description = "Autofix worker watchdog";
          wantedBy = ["timers.target"];
          timerConfig = {
            OnBootSec = "2min";
            OnUnitActiveSec = "2min";
            AccuracySec = "15s";
          };
        };

        # ---------------------------------------------------------------- lab
        # Root boundary of the automated lab stage. The worker (hermes) may only
        #   systemctl start neo-autofix-labtest@lab-<incident>-<stamp>.service
        # (polkit rule below: verb "start", that unit pattern, user hermes). The
        # runner re-validates the job spec it reads from queue/processing (branch
        # regex, whitelisted checks, no shell), takes a lab lock + Neo's activation
        # lock, builds the host flake with ONLY the neo input overridden to the
        # public fork branch, arms a transient root timer that rolls back on its
        # own, activates with switch-to-configuration test (no boot entry, no
        # profile generation), checks, ALWAYS switches back to the recorded
        # previous system, verifies it + byte-identical pins, then disarms.
        systemd.services."neo-autofix-labtest@" = mkIf labOn {
          description = "Autofix lab test %i (activates a fix branch, always rolls back)";
          # Never restarted/stopped by a switch: it is the thing switching.
          restartIfChanged = false;
          stopIfChanged = false;
          path = [config.nix.package pkgs.git pkgs.util-linux pkgs.coreutils pkgs.bash pkgs.sqlite config.systemd.package config.virtualisation.docker.package];
          unitConfig.ConditionPathExists = [opsAppdata];
          # Independent of the app / Hermes / the worker on purpose: no Requires /
          # BindsTo / PartOf / After on them, so a protected change that kills
          # any of them cannot stop the runner (or its watchdog) mid-rollback.
          serviceConfig = {
            Type = "oneshot";
            User = "root";
            # Results/status readable by the worker (hermes), nobody else.
            Group = "hermes";
            UMask = "0027";
            StateDirectory = "neo-autofix-labtest";
            StateDirectoryMode = "0750";
            ExecStart = "${workerPkg}/bin/neo-autofix-labtest --run %i";
            # SIGTERM only to the runner: it skips remaining checks and rolls back.
            KillMode = "mixed";
            TimeoutStartSec = "${toString labRunSec}";
            TimeoutStopSec = "${toString (lab.activateTimeoutSec + 120)}";
            Environment =
              [
                "LABTEST_OPS_DIR=${opsAppdata}"
                "LABTEST_STATE_DIR=/var/lib/neo-autofix-labtest"
                "LABTEST_FLAKE=${lab.flake}"
                "LABTEST_NIXOS_CONFIG=${lab.nixosConfiguration}"
                "LABTEST_LOCK_WAIT_SEC=${toString lab.lockWaitSec}"
                "LABTEST_BUILD_TIMEOUT_SEC=${toString lab.buildTimeoutSec}"
                "LABTEST_ACTIVATE_TIMEOUT_SEC=${toString lab.activateTimeoutSec}"
                "LABTEST_ROLLBACK_TIMEOUT_SEC=${toString lab.activateTimeoutSec}"
                "LABTEST_SETTLE_SEC=${toString lab.settleSec}"
                "LABTEST_CHECK_TIMEOUT_SEC=${toString lab.checkTimeoutSec}"
                "LABTEST_OPS_HEALTH=${lab.opsHealth}"
                "LABTEST_HERMES_UNIT=${lab.hermesUnit}"
                "LABTEST_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
                "LABTEST_SYSTEMD_RUN_BIN=${config.systemd.package}/bin/systemd-run"
                "LABTEST_JOURNALCTL_BIN=${config.systemd.package}/bin/journalctl"
                "LABTEST_FLOCK_BIN=${pkgs.util-linux}/bin/flock"
                "LABTEST_DOCKER_BIN=${config.virtualisation.docker.package}/bin/docker"
                "LABTEST_NIX_BIN=${config.nix.package}/bin/nix"
                # Protected paths (admin-approved runs only): the runner detects them
                # itself (deployed neo source vs the fork branch), verifies the app's
                # HMAC approval (key under ${opsAppdata}/private, owned by the app uid)
                # + the lab_approved DB event, and uses the short watchdog.
                "LABTEST_SHARES_OPS_HOST=${
                  if af.labSharesOpsHost
                  then "true"
                  else "false"
                }"
                # Allowlisted targets: flake input, override URL and protected / base
                # paths per target.
                "LABTEST_TARGETS_FILE=${targetsFile}"
                "LABTEST_PROTECTED_WATCHDOG_SEC=${toString lab.protectedWatchdogSec}"
                "LABTEST_OPS_UID=${uid}"
                "LABTEST_OPS_UNIT=${config.virtualisation.oci-containers.backend}-autofix.service"
                "LABTEST_DB_PATH=${opsAppdata}/ops.sqlite"
                "LABTEST_SQLITE_BIN=${pkgs.sqlite}/bin/sqlite3"
              ]
              ++ redactEnvList;
            # Evidence redaction uses the same extra slugs as the worker.
            EnvironmentFile = mkIf (redactFile != null) [redactFile];
          };
        };

        security.polkit.enable = mkIf labOn true;
        security.polkit.extraConfig = mkIf labOn ''
          // neo-autofix: the worker (user hermes) may START exactly
          // neo-autofix-labtest@lab-<incident>-<stamp>.service. Nothing else:
          // no stop/restart, no other unit, no other user.
          polkit.addRule(function(action, subject) {
            if (action.id == "org.freedesktop.systemd1.manage-units" &&
                subject.user == "hermes" &&
                action.lookup("verb") == "start" &&
                /${labUnitRe}/.test(action.lookup("unit") || "")) {
              return polkit.Result.YES;
            }
          });
        '';

        # Push a saved fix (ready_no_token / push_failed, or a legacy scratch clone
        # without push-pending.json) without a second Hermes run:
        #   systemctl start neo-autofix-worker-push@<job>.service
        # <job> = scratch dir name under ${hermesState}/workspace/autofix (fix-<id>-<ts>),
        # also shown as "job" in the incident event. Admin "Retry push" = queue/push.
        systemd.services."neo-autofix-worker-push@" = mkIf fixOn {
          description = "Autofix: push saved fix %i";
          wants = optional hasMaterialize "neo-autofix-token.service";
          after = optional hasMaterialize "neo-autofix-token.service";
          path = workerPath;
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            UMask = "0007";
            RuntimeDirectory = "neo-autofix-worker-push-%i";
            RuntimeDirectoryMode = "0700";
            WorkingDirectory = "${hermesState}/workspace";
            TimeoutStartSec = "3600";
            ExecStartPre = ["+${ensureDirs}"];
            ExecStart = "${workerPkg}/bin/neo-autofix-worker --push-pending ${hermesState}/workspace/autofix/%i";
            Environment = workerEnv ++ ["OPS_AUTOFIX_LOCK=/run/neo-autofix-worker-push-%i/lock"];
            EnvironmentFile = mkIf (redactFile != null) [redactFile];
          };
        };
      };
    };
}
