# Host-side autofix worker (Node). Opt-in via neo.services.autofix.autofix.enable.
{
  lib,
  self,
  ...
}: {
  perSystem = {pkgs, ...}: let
    workerSrc = pkgs.runCommand "neo-autofix-worker-src" {} ''
      mkdir -p $out
      cp ${../../scripts/autofix/worker.mjs} $out/worker.mjs
      cp ${../../app/lib/redact.js} $out/redact.js
      cp ${../../app/lib/compare.js} $out/compare.js
      cp ${../../app/lib/queue-control.js} $out/queue-control.js
      cp ${../../app/lib/lab-checks.js} $out/lab-checks.js
      cp ${../../scripts/autofix/labtest.mjs} $out/labtest.mjs
      cp ${../../app/lib/targets.js} $out/targets.js
      cp ${../../scripts/autofix/pr.mjs} $out/pr.mjs
      cp ${../../scripts/autofix/pr-wrapper.mjs} $out/pr-wrapper.mjs
      cp ${../../scripts/autofix/push-guard.mjs} $out/push-guard.mjs
    '';
    worker = pkgs.writeShellApplication {
      name = "neo-autofix-worker";
      runtimeInputs = [pkgs.nodejs_22 pkgs.git pkgs.bash pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/worker.mjs "$@"
      '';
    };
    # Root lab runner (neo-autofix-labtest@<job>.service only). node + the
    # script are store paths, so its rollback watchdog does not depend on the
    # system being tested.
    labtest = pkgs.writeShellApplication {
      name = "neo-autofix-labtest";
      runtimeInputs = [pkgs.nodejs_22 pkgs.util-linux pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/labtest.mjs "$@"
      '';
    };
    # The only code that hands the GitHub token to the REST API (whitelisted
    # PR / comment / read calls on allowlisted upstreams; --check verifies it).
    prWrapper = pkgs.writeShellApplication {
      name = "neo-autofix-pr";
      runtimeInputs = [pkgs.nodejs_22];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/pr-wrapper.mjs "$@"
      '';
    };
    neo-autofix-worker = pkgs.symlinkJoin {
      name = "neo-autofix-worker";
      paths = [worker labtest prWrapper];
    };
  in {
    packages = {
      inherit neo-autofix-worker;
    };
  };
}
