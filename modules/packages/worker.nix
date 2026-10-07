# Host-side autofix worker (Node). Opt-in via neo.services.autofix.autofix.enable.
{
  lib,
  self,
  ...
}: {
  perSystem = {pkgs, ...}: let
    # Same layout as the repo (scripts/autofix + app/lib), so the scripts'
    # relative imports (../../app/lib/*.js) resolve in the store too. No
    # symlinks: app/lib is the one copy of the shared modules.
    shared = ["redact.js" "compare.js" "queue-control.js" "lab-checks.js" "targets.js"];
    scripts = ["worker.mjs" "labtest.mjs" "pr.mjs" "pr-wrapper.mjs" "push-guard.mjs"];
    workerSrc = pkgs.runCommand "neo-autofix-worker-src" {} ''
      mkdir -p $out/scripts/autofix $out/app/lib
      ${lib.concatMapStrings (f: "cp ${../../scripts/autofix + "/${f}"} $out/scripts/autofix/${f}\n") scripts}
      ${lib.concatMapStrings (f: "cp ${../../app/lib + "/${f}"} $out/app/lib/${f}\n") shared}
      echo '{"type":"module"}' > $out/scripts/package.json
      echo '{"type":"module"}' > $out/app/package.json
      find $out -type l | grep . && { echo "symlink in worker src" >&2; exit 1; } || true
    '';
    worker = pkgs.writeShellApplication {
      name = "neo-autofix-worker";
      runtimeInputs = [pkgs.nodejs_22 pkgs.git pkgs.bash pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/scripts/autofix/worker.mjs "$@"
      '';
    };
    # Root lab runner (neo-autofix-labtest@<job>.service only). node + the
    # script are store paths, so its rollback watchdog does not depend on the
    # system being tested.
    labtest = pkgs.writeShellApplication {
      name = "neo-autofix-labtest";
      runtimeInputs = [pkgs.nodejs_22 pkgs.util-linux pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/scripts/autofix/labtest.mjs "$@"
      '';
    };
    # The only code that hands the GitHub token to the REST API (whitelisted
    # PR / comment / read calls on allowlisted upstreams; --check verifies it).
    prWrapper = pkgs.writeShellApplication {
      name = "neo-autofix-pr";
      runtimeInputs = [pkgs.nodejs_22];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/scripts/autofix/pr-wrapper.mjs "$@"
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
    # The built worker really runs: every script imports its app/lib modules
    # from the store copy (no symlinks), --help works, the PR wrapper answers.
    checks.worker-smoke = pkgs.runCommand "autofix-worker-smoke" {nativeBuildInputs = [pkgs.nodejs_22];} ''
      export HOME=$TMPDIR
      cd ${workerSrc}
      [ -z "$(find . -type l)" ]
      for f in scripts/autofix/*.mjs; do
        node --input-type=module -e "await import('${workerSrc}/$f')" </dev/null
      done
      set +e
      ${neo-autofix-worker}/bin/neo-autofix-worker --help > $TMPDIR/help.txt 2>&1
      grep -q "usage: neo-autofix-worker" $TMPDIR/help.txt || { cat $TMPDIR/help.txt; exit 1; }
      OPS_PR_TOKEN_FILE=$TMPDIR/none OPS_TARGETS='[]' ${neo-autofix-worker}/bin/neo-autofix-pr --check > $TMPDIR/out.json 2>&1
      rc=$?
      set -e
      cat $TMPDIR/out.json
      [ "$rc" = 4 ]
      grep -q "sudo neo-autofix-check" $TMPDIR/out.json
      echo ok > $out
    '';
  };
}
