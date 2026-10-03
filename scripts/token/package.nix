# neo-autofix token scripts (store derivations only; no secrets).
#
# Shared by modules/services/autofix/token.nix and scripts/token/test-local.sh,
# so the local test exercises exactly the build-time substitution that ships
# (a placeholder compared after replaceStrings once silently disabled the git
# credential helper).
#
#   nix-build scripts/token/package.nix --arg pkgs 'import <nixpkgs> {}' \
#     --argstr forkOwner example-bot --argstr checkRepo example-bot/neo -A envWrapper
{
  pkgs,
  lib ? pkgs.lib,
  # Owner of the token file (the Hermes user / group).
  owner ? "hermes",
  group ? "hermes",
  # GitHub account that owns the forks: the credential helper is scoped to
  # https://github.com/<forkOwner>/ only. checkRepo = one fork for --check.
  forkOwner,
  checkRepo ? "${forkOwner}/repo",
  # github.tokenFile (copied at activation), "" = settings.toml key.
  tokenSource ? "",
}: let
  # replaceStrings, plus a build-time guard that every placeholder was
  # substituted (a leftover "@name@" in shipped script text is a bug).
  substitute = name: from: to: file: let
    text = lib.replaceStrings from to (builtins.readFile file);
    leftover = builtins.filter (p: lib.hasInfix p text) from;
  in
    if leftover == []
    then text
    else throw "${name}: unsubstituted placeholder(s) ${toString leftover}";

  # Strip the repo shebang; pin python3 from pkgs so PATH is enough.
  extractBody = let
    raw = builtins.readFile ./extract-token.py;
    lines = lib.splitString "\n" raw;
  in
    if lines != [] && lib.hasPrefix "#!" (builtins.head lines)
    then lib.concatStringsSep "\n" (builtins.tail lines)
    else raw;

  extract = pkgs.writeScriptBin "neo-autofix-extract-token" ''
    #!${pkgs.python3}/bin/python3
    ${extractBody}
  '';

  helper = pkgs.writeShellScriptBin "neo-autofix-git-credential" (
    substitute "neo-autofix-git-credential" ["@forkOwner@"] [forkOwner] ./git-credential-helper.sh
  );

  helperBin = "${helper}/bin/neo-autofix-git-credential";

  # The wrapper injects the helper via GIT_CONFIG_COUNT/KEY/VALUE (see the
  # script). Only absolute store paths are substituted — never compared.
  envWrapper = pkgs.writeShellScriptBin "neo-autofix-env" (
    substitute "neo-autofix-env"
    ["@helper@" "@git@" "@forkOwner@" "@checkRepo@"]
    [helperBin "${pkgs.git}/bin/git" forkOwner checkRepo]
    ./neo-autofix-env.sh
  );

  materialize = pkgs.writeShellScript "neo-autofix-materialize" (
    substitute "neo-autofix-materialize"
    ["@extract@" "@owner@" "@group@" "@source@"]
    ["${extract}/bin/neo-autofix-extract-token" owner group tokenSource]
    ./materialize.sh
  );
in {
  inherit extract helper helperBin envWrapper materialize;
}
