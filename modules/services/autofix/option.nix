# Options of the autofix service (neo.services.autofix): incident desk +
# opt-in host-side autofix loop (local Hermes, fork push, lab test, upstream PR).
{...}: {
  flake.modules.nixos.autofix-option = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib;
    with {inherit (lib.neo) mkOption mkEnableOption;}; let
      loginType = types.strMatching "[A-Za-z0-9](-?[A-Za-z0-9]){0,38}";
      slugType = types.strMatching "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
      pathList = description: rank:
        mkOption {
          type = types.listOf types.str;
          default = [];
          inherit description rank;
        };
    in {
      options.neo.services.autofix = mkOption {
        type = types.submodule {
          options =
            {
              enabled = mkEnableOption "Autofix incident desk" {rank = 0;};

              ingestSecret = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Shared secret for POST /api/incidents (Bearer or X-Ops-Secret). Prefer ingestSecretFile.";
                rank = 1;
              };

              ingestSecretFile = mkOption {
                type = types.nullOr types.str;
                default = null;
                example = "/var/neo/DATA/AppData/autofix/private/ingest.secret";
                description = "Host file with the ingest secret (first line), mounted read-only into the container. Must be readable by the Neo core user. Wins over ingestSecret.";
                rank = 2;
              };

              github = mkOption {
                type = types.submodule {
                  options = {
                    token = mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      description = ''
                        GitHub token of the fork owner (classic PAT with public_repo, so the
                        loop can push to the forks and open upstream PRs). Read from
                        settings.toml at activation time and written to tmpfs only; never
                        put into the Nix store. Prefer tokenFile.
                      '';
                      rank = 0;
                    };
                    tokenFile = mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      example = "/var/neo/DATA/AppData/autofix/private/github.token";
                      description = "Root-readable host file with the token (first line); copied to tmpfs at activation. Wins over token.";
                      rank = 10;
                    };
                  };
                };
                default = {};
                description = "GitHub credential of the autofix loop (fork push + upstream PRs).";
                rank = 5;
              };

              targets = mkOption {
                type = types.listOf (types.submodule {
                  options = {
                    upstream = mkOption {
                      type = slugType;
                      example = "example-upstream/neo";
                      description = "owner/repo the PR goes to (the incident's target repo).";
                      rank = 0;
                    };
                    fork = mkOption {
                      type = slugType;
                      example = "example-bot/neo";
                      description = "owner/repo of the fork the worker pushes fix/* and ops/* branches to. All targets share one fork owner (the token's account).";
                      rank = 1;
                    };
                    baseRef = mkOption {
                      type = types.nullOr (types.strMatching "[A-Za-z0-9._/-]+");
                      default = null;
                      description = "Base branch of fixes and PRs. null = the upstream's default branch (looked up and cached).";
                      rank = 2;
                    };
                    flakeInput = mkOption {
                      type = types.nullOr (types.strMatching "[A-Za-z0-9_-]+");
                      default = null;
                      description = ''
                        Host flake input the lab test overrides with the fork branch. null = the
                        one root input whose source is the upstream or the fork (a Neo plugin is
                        input plugin<N>, N = its index in core.plugins).
                      '';
                      rank = 3;
                    };
                    lab = mkOption {
                      type = types.enum ["flake-override" "none"];
                      default = "flake-override";
                      description = "Lab method: flake-override (automated lab test) or none (needs a human: test by hand, then Skip lab).";
                      rank = 4;
                    };
                    flakeUrl = mkOption {
                      type = types.nullOr (types.strMatching "[A-Za-z0-9:/._+?=-]*[{]branch[}][A-Za-z0-9:/._+?=&-]*");
                      default = null;
                      internal = true;
                      description = "Override URL with {branch} (default github:<fork>/{branch}).";
                    };
                    units = pathList "Routing hint for triage: systemd unit names / globs (docker-sonarr*)." 10;
                    paths = pathList "Routing hint: repo path prefixes." 11;
                    keywords = pathList "Routing hint: words in the logs." 12;
                    protectedPaths = pathList "Path prefixes whose lab test needs an admin approval (when the lab shares this host)." 20;
                    basePaths = pathList "Subset of protectedPaths shown as BASE SYSTEM (stronger warning on the approval button)." 21;
                    reviewers = mkOption {
                      type = types.nullOr (types.listOf loginType);
                      default = null;
                      description = "GitHub logins whose reviews drive revisions of this target's PRs. null = autofix.pr.reviewers, then CODEOWNERS, then collaborators, then the repo owner.";
                      rank = 30;
                    };
                  };
                });
                default = [];
                description = ''
                  Allowlisted upstream repos of the autofix loop ([[services.autofix.targets]]).
                  Triage picks one; fix, push, lab and PR use it; unknown repos go to a human.
                  There is no built-in target.
                '';
                rank = 9;
              };

              redact = mkOption {
                type = types.submodule {
                  options = {
                    termsFile = mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      example = "/var/neo/DATA/AppData/autofix/redact-extra.env";
                      description = ''
                        Host EnvironmentFile exporting OPS_REDACT_EXTRA_SLUGS=term1,term2 (customer
                        ids, lab host names, …; redacted case-insensitively before anything goes
                        to GitHub). Must exist (0600) when set: docker --env-file fails otherwise.
                      '';
                      rank = 0;
                    };
                    hostnames = pathList "Host names redacted as whole words (this host's networking.hostName is always added)." 10;
                    patterns = mkOption {
                      type = types.listOf types.str;
                      default = [];
                      example = ["[A-Z0-9]{10}"];
                      description = "Whole-token, case-sensitive JavaScript regexes redacted as ids (e.g. the shape of customer ids). No whitespace inside a pattern.";
                      rank = 20;
                    };
                  };
                };
                default = {};
                description = "Redaction of host- and customer-identifying details in everything posted to GitHub.";
                rank = 15;
              };

              admin = mkOption {
                type = types.submodule {
                  options = {
                    enabled = mkOption {
                      type = types.bool;
                      default = true;
                      internal = true;
                      description = "Enable the in-app admin UI (ADMIN_ENABLED).";
                    };
                    path = mkOption {
                      type = types.str;
                      default = "/admin";
                      internal = true;
                      description = "Admin URL path with no trailing slash (ADMIN_PATH).";
                    };
                    auth = mkOption {
                      type = types.bool;
                      default = true;
                      description = "When true (and Tinyauth is enabled), SWAG Tinyauth-protects the admin locations.";
                      rank = 20;
                    };
                    readOnly = mkOption {
                      type = types.bool;
                      default = false;
                      description = "Disable mutating admin forms (ADMIN_READ_ONLY).";
                      rank = 30;
                    };
                  };
                };
                default = {};
                description = "Admin UI for incidents. Gated by Tinyauth at the reverse-proxy edge when admin.auth is true; ingest stays shared-secret only.";
                rank = 10;
              };

              autofix = mkOption {
                type = types.submodule {
                  options = {
                    enable = mkOption {
                      type = types.bool;
                      default = false;
                      description = "Master switch of the host-side autofix runner (default off). When false, no path/worker units are installed.";
                      rank = 0;
                    };
                    triage = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Process triage jobs via local Hermes.";
                            rank = 0;
                          };
                          autoEnqueue = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Enqueue triage for every new incident (OPS_AUTOTRIAGE).";
                            rank = 10;
                          };
                        };
                      };
                      default = {};
                      description = "Triage worker controls.";
                      rank = 10;
                    };
                    fix = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Process fix jobs (Hermes + fork push through neo-autofix-env).";
                            rank = 0;
                          };
                        };
                      };
                      default = {};
                      description = "Fix worker controls.";
                      rank = 20;
                    };
                    maxAttempts = mkOption {
                      type = types.ints.positive;
                      default = 2;
                      internal = true;
                      description = "Max Hermes fix retries after a failed lab test.";
                    };
                    labSharesOpsHost = mkOption {
                      type = types.bool;
                      default = true;
                      description = ''
                        The lab host is this host: fixes that touch a target's protectedPaths are
                        still coded and pushed, but the automated lab test waits for an admin
                        "Approve lab test" on the board.
                      '';
                      rank = 40;
                    };
                    hermesTimeoutSec = mkOption {
                      type = types.ints.positive;
                      default = 2700;
                      internal = true;
                      description = "Per Hermes call timeout in seconds (fix runs up to 40 turns).";
                    };
                    extraPackages = mkOption {
                      type = types.listOf types.package;
                      # Rust toolchain for repos with a cargo workspace (e.g. a CLI).
                      default = with pkgs; [cargo rustc clippy rustfmt stdenv.cc pkg-config openssl openssl.dev gnumake];
                      defaultText = literalExpression "with pkgs; [cargo rustc clippy rustfmt stdenv.cc pkg-config openssl openssl.dev gnumake]";
                      internal = true;
                      description = "Extra tools on the worker/Hermes PATH (also installed for the hermes user so Hermes's terminal tool sees them).";
                    };
                    lab = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = ''
                              Automated lab stage (needs fix.enable). After a fix branch is pushed, a
                              root job builds this host's config with only the target's flake input
                              overridden to the fork branch, activates it (switch-to-configuration
                              test), runs generic + Hermes-planned checks and always rolls back.
                              Installs neo-autofix-labtest@ and a polkit rule that lets hermes start
                              exactly that unit.
                            '';
                            rank = 0;
                          };
                          flake = mkOption {
                            type = types.str;
                            default = config.neo.neo-cli.server.configPath or "/var/neo/DATA/AppData/configuration";
                            defaultText = literalExpression "config.neo.neo-cli.server.configPath";
                            internal = true;
                            description = "Host config flake the lab builds. Never modified; flake.lock/flake.nix/settings.toml are verified byte-identical afterwards.";
                          };
                          nixosConfiguration = mkOption {
                            type = types.strMatching "[A-Za-z0-9_-]+";
                            default = "neo";
                            internal = true;
                            description = "nixosConfigurations.<name> of that flake.";
                          };
                          opsHealth = mkOption {
                            type = types.str;
                            default = "container:autofix:3000/health";
                            internal = true;
                            description = "Health check of this app after activation: container:<docker name>:<port><path> or a loopback http:// URL.";
                          };
                          hermesUnit = mkOption {
                            type = types.str;
                            default = "hermes-agent.service";
                            internal = true;
                            description = "Hermes unit that must be active after activation.";
                          };
                          lockWaitSec = mkOption {
                            type = types.ints.unsigned;
                            default = 1800;
                            internal = true;
                            description = "Max wait for Neo's activation lock before the lab job errors.";
                          };
                          buildTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 3600;
                            internal = true;
                            description = "Build timeout (nothing is activated before the build succeeds).";
                          };
                          activateTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 900;
                            internal = true;
                            description = "switch-to-configuration timeout for the lab system and for the rollback.";
                          };
                          settleSec = mkOption {
                            type = types.ints.unsigned;
                            default = 30;
                            internal = true;
                            description = "Wait after activation before checks.";
                          };
                          checkTimeoutSec = mkOption {
                            type = types.ints.unsigned;
                            default = 60;
                            internal = true;
                            description = "Per-check retry window (unit active, HTTP status).";
                          };
                          planTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 600;
                            internal = true;
                            description = "Timeout of the Hermes call that plans the incident checks.";
                          };
                          protectedWatchdogSec = mkOption {
                            type = types.ints.between 60 3600;
                            default = 600;
                            internal = true;
                            description = "Rollback watchdog deadline of admin-approved protected lab runs.";
                          };
                        };
                      };
                      default = {};
                      description = "Automated lab test of pushed fix branches on this host (default off).";
                      rank = 70;
                    };
                    pr = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = ''
                              Open the upstream PR after a lab pass (draft + "NOT lab-tested" after
                              Skip lab), request the reviewers, poll it and revise the branch on
                              their review feedback. Never merges. Needs a classic PAT with
                              public_repo (github.token / tokenFile).
                            '';
                            rank = 0;
                          };
                          reviewers = mkOption {
                            type = types.listOf loginType;
                            default = [];
                            description = ''
                              GitHub logins whose comments / reviews drive a revision (a target's
                              own reviewers win). Empty = CODEOWNERS, then collaborators with
                              maintain/admin, then the repo owner when it is a user. Numeric ids are
                              pinned on first use; an id change stops the loop on that PR.
                            '';
                            rank = 10;
                          };
                          pinnedReviewerIds = mkOption {
                            type = types.attrsOf types.ints.positive;
                            default = {};
                            internal = true;
                            description = "login → numeric GitHub id pinned up front (otherwise pinned on first use).";
                          };
                          botLogin = mkOption {
                            type = types.nullOr loginType;
                            default = null;
                            internal = true;
                            description = "Account the token belongs to (PR author; its own comments are ignored). null = the fork owner.";
                          };
                          pollMinutes = mkOption {
                            type = types.ints.between 2 5;
                            default = 3;
                            internal = true;
                            description = "Poll interval for PR state and review feedback (minutes).";
                          };
                          maxRounds = mkOption {
                            type = types.ints.between 1 10;
                            default = 3;
                            internal = true;
                            description = "Revision rounds per PR; after that new feedback goes to a human.";
                          };
                          stopPhrase = mkOption {
                            type = types.str;
                            default = "/ops stop";
                            internal = true;
                            description = "A reviewer comment line equal to this stops the automation on that PR.";
                          };
                          draft = mkOption {
                            type = types.bool;
                            default = false;
                            internal = true;
                            description = "Open lab-passed PRs as drafts too (untested ones always are).";
                          };
                        };
                      };
                      default = {};
                      description = "Automatic upstream PR + review feedback loop (default off).";
                      rank = 75;
                    };
                  };
                };
                default = {};
                description = "Opt-in autofix loop (local Hermes + fork push). Default entirely off.";
                rank = 20;
              };
            }
            // lib.neo.mkReverseProxyOptions {
              subdomain = "autofix";
              auth.enabled = false;
            }
            // lib.neo.mkVpnOptions {
              containers = ["autofix"];
              networks = ["internal"];
              ports = [3000];
            }
            // lib.neo.mkContainerDefinitions {
              autofix = "neo-autofix:latest";
            }
            // lib.neo.mkAppdata "${config.neo.core.volumes.appdata}/autofix"
            // lib.neo.mkServiceMeta {
              category = "Monitoring";
              description = ''
                Incident desk for Neo hosts (secret-gated ingest, SQLite, Tinyauth-gated
                admin) with an opt-in autofix loop: local Hermes triages and fixes, pushes
                to a fork, lab-tests on this host with automatic rollback and opens an
                upstream PR for review. Never merges.
              '';
              projectUrl = "https://github.com/heimcloud/autofix.neo";
              githubUrl = "https://github.com/heimcloud/autofix.neo";
            };
        };
        default = {};
        description = "Autofix incident desk and autofix loop";
      };
    };
}
