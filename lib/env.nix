# Values shared by the container (default.nix) and the host units
# (autofix.nix): redaction env, time zone, token hint. No secrets: the token
# itself is never read here, only whether one is configured.
{
  lib,
  config,
  cfg,
  targets,
}: let
  owners = lib.unique (lib.concatMap (t: map (s: lib.head (lib.splitString "/" s)) [t.upstream t.fork]) targets);
  hostName = config.networking.hostName or "";
  hostnames = lib.unique (lib.filter (h: h != "") ([hostName] ++ cfg.redact.hostnames));
  legacyToken = let
    cred = config.neo.services.credentials or {};
    tok = cred.ops.autofixForkPushToken or null;
  in
    (cred.enabled or false) && tok != null && tok != "";
in {
  forkOwner =
    if targets == []
    then null
    else lib.head (lib.splitString "/" (lib.head targets).fork);
  checkRepo =
    if targets == []
    then null
    else (lib.head targets).fork;
  timeZone =
    if (config.time.timeZone or null) == null
    then "UTC"
    else config.time.timeZone;
  tokenConfigured =
    cfg.github.tokenFile
    != null
    || (cfg.github.token != null && cfg.github.token != "")
    || legacyToken;
  redactEnv = lib.filterAttrs (_: v: v != "") {
    OPS_PUBLIC_OWNERS = lib.concatStringsSep "," owners;
    OPS_REDACT_HOSTNAMES = lib.concatStringsSep "," hostnames;
    OPS_REDACT_PATTERNS = lib.concatStringsSep " " cfg.redact.patterns;
  };
}
