# GitHub token of the autofix loop → tmpfs (/run/neo-autofix/github-token).
#
# Source: github.tokenFile (copied), else services.autofix.github.token read
# from the live settings.toml at activation time (one release: also the old
# services.credentials.ops.autofixForkPushToken key, with a warning). The value
# is never interpolated into a derivation, Environment= or unit text.
#
# Ships neo-autofix-env (per-process git credential helper scoped to
# https://github.com/<fork owner>/ + GH_TOKEN for the child only) and
# neo-autofix-git-credential. Store scripts only: scripts/token/package.nix,
# shared with scripts/token/test-local.sh.
{...}: {
  flake.modules.nixos.autofix-token = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.autofix;
      af = cfg.autofix;
      on = cfg.enabled && af.enable && af.fix.enable && cfg.targets != [];
      targets = import ../../../lib/targets.nix {inherit lib cfg;};
      env = import ../../../lib/env.nix {inherit lib config cfg targets;};

      # Owner of the token dir + file: the Hermes gateway user/group.
      hermesUser = config.services.hermes-agent.user or "hermes";
      hermesGroup = config.services.hermes-agent.group or "hermes";
      # systemd-tmpfiles fails the whole run on an unknown user/group.
      hermesDeclared =
        (config.users.users ? ${hermesUser})
        && (config.users.groups ? ${hermesGroup});

      tokenPkgs = import ../../../scripts/token/package.nix {
        inherit pkgs lib;
        owner = hermesUser;
        group = hermesGroup;
        forkOwner =
          if env.forkOwner == null
          then "invalid-"
          else env.forkOwner;
        checkRepo =
          if env.checkRepo == null
          then "invalid-/repo"
          else env.checkRepo;
        tokenSource =
          if cfg.github.tokenFile == null
          then ""
          else cfg.github.tokenFile;
      };
      inherit (tokenPkgs) extract helper envWrapper materialize;
      tokenDir = "/run/neo-autofix";
    in {
      config = mkIf on {
        environment.systemPackages = [envWrapper helper extract];

        # `d` re-applies owner/mode at boot and on every switch and never touches
        # the dir contents (github-token, reserved pr-token).
        systemd.tmpfiles.rules = [
          (
            if hermesDeclared
            then "d ${tokenDir} 0700 ${hermesUser} ${hermesGroup} -"
            else "d ${tokenDir} 0700 root root -"
          )
        ];

        # Every switch/boot, so settings.toml / tokenFile edits are picked up
        # even when this text is unchanged.
        system.activationScripts.neo-autofix-token = {
          deps = ["users" "etc"];
          text = ''
            ${materialize}
          '';
        };

        # Same script as a oneshot: the worker units want it before each run, and
        # operators can `systemctl start neo-autofix-token` after a manual edit.
        systemd.services.neo-autofix-token = {
          description = "Materialize the autofix GitHub token to tmpfs";
          path = [pkgs.coreutils pkgs.getent];
          serviceConfig = {
            Type = "oneshot";
            ExecStart = "${materialize}";
          };
        };
      };
    };
}
