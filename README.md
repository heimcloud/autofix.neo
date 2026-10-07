# autofix.neo

A [Neo](https://github.com/madebydamo/neo) plugin: an **incident desk** for Neo
hosts plus an opt-in **autofix loop**.

- **Ingest** `POST /api/incidents` (shared secret), SQLite WAL, idempotent on `report_hash`.
- **Admin board** at `/admin` (kanban, live updates, queue panel), Tinyauth-gated through SWAG.
- **Autofix loop** (default off): local Hermes triages an incident, codes a fix on a
  branch of your **fork** of the target repo, the worker pushes it, a root runner
  **lab-tests it on this host** (activate → checks → always roll back), and the loop
  opens the **upstream PR**, requests the reviewers and revises the branch on their
  review comments. **It never merges.**

Machines report incidents with the companion plugin
[reporter.neo](https://github.com/heimcloud/reporter.neo) (Hermes skill + helper).

Design and safety model: [`docs/AUTOFIX_DESIGN.md`](docs/AUTOFIX_DESIGN.md).

## Install

Add the plugin to `core.plugins` in your Neo `settings.toml` (Neo imports its
`nixosModules.default`):

```toml
[core]
plugins = ["github:heimcloud/autofix.neo"]

[services.autofix]
enabled = true
ingestSecretFile = "/var/neo/DATA/AppData/autofix/private/ingest.secret"  # or ingestSecret = "…"
# subdomain = "autofix"     # → https://autofix.<your domain>
# admin.auth = true         # Tinyauth on /admin (when tinyauth is enabled)
```

Data lives in `/var/neo/DATA/AppData/autofix` (SQLite, queue, results, state);
the container is `docker-autofix`.

## Autofix loop

Requirements: `[services.hermes] enabled = true`, a GitHub account that owns the
forks (the "bot" account), and a fork of every target repo under that account.

```toml
[services.autofix.github]
tokenFile = "/var/neo/DATA/AppData/autofix/private/github.token"   # root-readable, first line
# token = "…"   # alternative: read from settings.toml at activation, never put in the Nix store

[services.autofix.redact]
termsFile = "/var/neo/DATA/AppData/autofix/redact-extra.env"  # OPS_REDACT_EXTRA_SLUGS=term1,term2 (0600)
hostnames = ["labhost-b", "labhost-c"]                          # this host's name is always added
patterns = ["[A-Z0-9]{10}"]                                     # e.g. the shape of your customer ids

[services.autofix.autofix]
enable = true
triage.enable = true
# triage.autoEnqueue = true
fix.enable = true
lab.enable = true            # automated lab test on this host
pr.enable = true             # open + revise upstream PRs
pr.reviewers = ["example-upstream"]   # optional, see "Reviewers"

[[services.autofix.targets]]
upstream = "example-upstream/neo"
fork = "example-bot/neo"
flakeInput = "neo"                       # host flake input the lab overrides
# baseRef = "master"                     # default: the upstream's default branch
protectedPaths = ["nix/services/hermes", "nix/services/swag", "nix/modules/core"]
basePaths = ["nix/modules/core"]

[[services.autofix.targets]]
upstream = "example-upstream/example.neo"
fork = "example-bot/example.neo"
units = ["docker-example*"]              # routing hints for triage
# lab = "none"                           # no automated lab test for this repo
# reviewers = ["example-maintainer"]     # per-target reviewers win over pr.reviewers
```

**Token.** One classic personal access token of the fork owner with scope
`public_repo`: it pushes `fix/*` / `ops/*` branches to the forks (through
`neo-autofix-env`, a per-process git credential helper scoped to
`https://github.com/<fork owner>/`) and opens / comments on upstream PRs
(through `neo-autofix-pr`, an allowlisted REST wrapper). A fine-grained token can
push to the forks but cannot open upstream PRs: the PR loop then stays off and
the board shows compare links. Activation copies the token to
`/run/neo-autofix/github-token` (tmpfs, hermes, 0400); it never enters the Nix
store. All forks must belong to the same account.

**Reviewers.** Only reviews and comments of the resolved reviewers drive a
revision. Order: the target's `reviewers` → `pr.reviewers` → `CODEOWNERS` of
the upstream (users; teams via their members) → collaborators with
maintain/admin (skipped when the token may not list them) → the repo owner when
it is a user. Each reviewer's numeric GitHub id is pinned on first use; if a
login later maps to another id the loop stops on that PR. The worker requests
the review when it opens a PR; when GitHub refuses that (fork accounts usually
may not request reviewers upstream) it posts one comment mentioning them.

**Lab test.** With `lab.enable` a root unit `neo-autofix-labtest@` builds this
host's config flake (`neo-cli.server.configPath`) with only the target's flake
input overridden to the pushed commit, activates it with
`switch-to-configuration test`, runs generic and Hermes-planned checks, and
always switches back (independent watchdog timer). Fixes touching a target's
`protectedPaths` wait for **Approve lab test** on the board.

**Redaction.** Everything that leaves the host for GitHub (branches, commits,
PR text, replies) passes a fail-closed gate: e-mails, IPs, home paths, foreign
URLs, configured host names, terms from `termsFile` and `patterns` are removed or
block the push.

Checks after activation:

```bash
sudo neo-autofix-check     # token kind, push + PR access, with the worker unit's user/env/PATH
neo-autofix-pr --check     # as hermes only; other users get a hint to use sudo neo-autofix-check
systemctl list-timers | grep neo-autofix
curl -fsS https://autofix.<your domain>/health
```

## Coming from `[services.ops]`

The `[services.ops]` alias of v0.1.x is gone in v0.2.0, and so is the old
`services.credentials.ops.autofixForkPushToken` token key. Move every setting
to `[services.autofix]` before upgrading (the subdomain is `autofix` unless you
set `subdomain`; keep an old host name with `customDomains`), set the token in
`github.token` / `github.tokenFile`, and move `AppData/ops` to
`AppData/autofix` (or set `appdata`). With v0.1.x installed, 0 evaluation
warnings means nothing is left to move. A leftover `[services.ops]` table is
no longer read at all.

## Schema

### `incidents`

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK |
| `report_hash` | TEXT UNIQUE — idempotent ingest key |
| `neo_version`, `plugin_urls`, `unit`, `logs_excerpt` | TEXT |
| `customer_repo_slug`, `severity`, `target_hint`, `target_repo` | TEXT |
| `status` | `open` \| `triaged` \| `fixing` \| `testing` \| `needs_human` \| `pr_opened` \| `resolved` \| `closed` |
| `class` | `software` \| `human_config` \| `unknown` |
| `draft_pr_url`, `draft_pr_number`, `draft_branch` | tested branch / PR preparation metadata |
| `created_at`, `updated_at` | ISO text |

### `incident_events`

| Column | Notes |
|--------|--------|
| `id` | INTEGER PK |
| `incident_id` | FK → incidents |
| `kind`, `message`, `meta_json` | audit trail |
| `created_at` | ISO text |

## Example ingest

```bash
curl -sS -X POST "http://localhost:3000/api/incidents" \
  -H "Content-Type: application/json" \
  -H "X-Ops-Secret: $OPS_INGEST_SECRET" \
  -d '{
    "report_hash": "abc123deadbeef",
    "neo_version": "0.9.0",
    "plugin_urls": ["github:example-org/example.neo"],
    "unit": "docker-example.service",
    "logs_excerpt": "Error: connection refused",
    "reporter_id": "host-0001",
    "severity": "high",
    "target_hint": "example-upstream/neo"
  }'
```

Bearer also works: `-H "Authorization: Bearer $OPS_INGEST_SECRET"`.

## Admin board

`/admin` is a server-rendered kanban board, progressively enhanced by `app/public/js/board.js` (vanilla JS, no framework, no CDN/fonts; CSS in `app/public/css/board.css`, light + dark via `prefers-color-scheme`). Without JS every card still has working forms.

**Columns** (= lifecycle status): Open · Triaged · Fixing · Testing · Needs human · PR open (`pr_opened`) · Done (`resolved` + `closed`, tagged on the card). Column headers carry the per-status counts that used to be tiles, plus how many cards in the column need input. Fixing/Testing are marked worker-owned.

**Moving cards**: drag and drop (native HTML5) or the **Move to…** select on each card/drawer (keyboard + touch). Moves are optimistic and roll back on error. They go through the existing update path `POST /admin/incidents/:id` (form, or JSON with `Content-Type: application/json`), which checks the transition table below (409 + message otherwise), refuses stale moves (`expect_from`), and always writes an `admin_update` event `status X -> Y` with `meta.from` / `meta.to`. All admin POSTs require same-origin (`Sec-Fetch-Site`, or `Origin` = Host when that header is missing). `ADMIN_READ_ONLY` removes drag handles, menus and buttons, and the server answers 403.

| From | Allowed manual targets |
|------|------------------------|
| open | triaged, needs_human, resolved, closed |
| triaged | open, needs_human, resolved, closed |
| fixing | needs_human (unstick a dead job) |
| testing | pr_opened (manual lab test passed), needs_human, triaged, resolved, closed |
| needs_human | triaged, resolved, closed |
| pr_opened | triaged, needs_human, resolved, closed |
| resolved | open, triaged, closed |
| closed | open, triaged, resolved |

Nothing can be moved *into* `fixing` / `testing` by hand: **Start fix** and the worker results set those.

**Needs my input** (`needsHumanInput()` in `app/lib/board.js`, pure + unit-tested) uses only the incident row, its latest `triage_result` / `fix_result` payloads, `*_enqueued` events and `fix_attempts`. Nothing is flagged while a triage/fix/push job queued after the last result is still pending.

| Status | Condition | Badge → action |
|--------|-----------|----------------|
| open | no triage result / `triage_failed` | Not triaged yet / Triage failed → Start triage |
| open, triaged | triage `verdict` `uncertain`, or `confidence` < 0.6 | Triage unsure → Start fix / Mark config error & close |
| open, triaged | verdict `config_error` / `not_actionable` / `code_fix` | Mark config error & close / Close / Start fix |
| triaged | latest fix result `ready_no_token` / `push_failed` | Push pending / Push failed → Retry push |
| testing | no `passed`/`failed` lab result (lab skipped, or automated lab off) — **no badge** while an automated lab job is queued/running (`OPS_AUTOFIX_LAB`) | Lab test needed → Open compare link |
| testing | automated lab `lab_error` / lab job cancelled | Lab test error / Lab test cancelled → Retry lab |
| needs_human | lab rollback not verified | Lab rollback NOT verified: check the host |
| needs_human | latest fix result `lab_approval_needed` (protected path of the target while the lab shares this host); stays until acted on | Protected path (hermes): approve lab test → **Approve lab test** (base system: "Approve lab test (base system!)", stronger confirm) / **Skip lab, open compare link** / Close |
| needs_human | protected lab run: app / Hermes still down after rollback + restart | still down after the lab rollback: check the host |
| needs_human | `lab: failed` / `redaction_blocked` / `denied` (legacy) / Hermes gave up after retries / other | reason + worker summary → Start fix / Close |
| testing | `lab_approved` event after the last result (approved protected lab job queued/running) | **no badge** |
| pr_opened | `compare_url` set, lab skipped by the admin (`lab_skipped` after the last fix result) | Open the PR from the compare link (NOT lab-tested) → Open compare link / Mark resolved; card chip "NOT lab-tested" |
| pr_opened | `compare_url` set | Open the PR from the compare link → Open compare link / Mark resolved |

Old triage results without `verdict` are mapped from `class` + `fixable` (human_config → config_error, software+fixable → code_fix, software+!fixable → not_actionable, unknown → uncertain).

**Filters**: column visibility, severity, class, unit, target repo, *Needs my input*, and free-text search (over redacted fields only). State lives in the URL query (wins) and `localStorage`. **Drawer**: click a card (`#incident-13` is linkable) for the redacted summary, events timeline (newest first, in the host time zone), fix attempts, lab result, compare link, draft branch and actions. The older per-incident page (`/admin/incidents/:id`, raw staff view with class/target edit) is still linked from the drawer.

**Anonymization**: every displayed text field on the board, drawer and `board.json` goes through `app/lib/redact.js` with the DB slugs + `OPS_REDACT_EXTRA_SLUGS`, plus a display-only username rule. Unit suffixes like `.service` stay readable. The reporter id (`customer_repo_slug`) and `plugin_urls` are never rendered there. Links are only shown for `https://github.com/…` URLs that come through redaction unchanged. `app/test/board-admin.test.js` seeds synthetic identifiers and asserts that none of them reach the HTML or the JSON.

### Live updates, worker panel, queue

**Live updates** (`app/lib/live.js`, `app/public/js/live.js`). The server computes a revision from DB watermarks (max event / fix-attempt / `updated_at` / count) plus an fs signature of the queue dirs, `queue/control/*`, `queue/worker-status.json` and `queue/systemd-status.json`.
- `GET /admin/events` (SSE) sends `retry: 3000`, then a `hello` (or a catch-up `change` when `Last-Event-ID` is stale).
- It sends `event: change` with the changed incident ids and `worker: true|false` whenever the revision moves (checked every `OPS_LIVE_TICK_MS`, default 1.5 s, one shared ticker).
- It also sends a `: hb` comment plus `event: ping` every `OPS_LIVE_HEARTBEAT_MS` (15 s).
- Headers: `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, so nginx/SWAG do not buffer the stream. The 15 s heartbeat stays well below SWAG's `proxy_read_timeout` (240 s).
- The client falls back to polling `GET /admin/live.json` every 5 s (15 s in a hidden tab) with `If-None-Match` (304 when unchanged) when EventSource is missing, errors 4×, or goes silent. It retries SSE every 2 min.
- On a change it fetches `/admin/cards?ids=…` and `/admin/worker.json` and patches the page. It never replaces a card being dragged or with a pending move/focused control (those are flushed after `dragend`/blur). An open drawer is refreshed in place, keeping its scroll position, open `<details>` and `<pre>` scroll.
- The header shows **Live** / **Reconnecting** / **Polling**.

**Worker panel** (board strip + `/admin/queue`) reads `queue/worker-status.json` (written atomically by the host worker at every stage transition and every `OPS_AUTOFIX_HEARTBEAT_SEC`, default 30 s, while Hermes runs). It shows:
- the state: Running / Idle / Paused / **Stale** (running but heartbeat older than `OPS_WORKER_STALE_SEC`, default 300 s) / Not reporting;
- the current job: kind, incident, stage `cloning`/`hermes n/m`/`checks`/`push`/`lab`, started + elapsed, claims, cancel requested;
- the last run result + time, fork-push token (bool), Hermes/lab timeouts;
- systemd health from `queue/systemd-status.json`, written by the root `neo-autofix-worker-kick` timer: the path unit is watching, service state, start-limit-hit / failed, stale report, last watchdog action;
- recent worker issues (poison quarantine, requeue after crash, stale lock, Hermes timeout, unwritable results, malformed job, cancelled).

**Queue** (`/admin/queue`, `/admin/queue.json`). Pending jobs are shown in claim order: priority (high/normal/low) → manual order → kind (push › triage › fix) → enqueue time. Processing, recent failed (with reason) and recent done (with result) are listed too. Controls (JSON or form POSTs, same-origin, 403 under `ADMIN_READ_ONLY`):

| Action | Effect | Event |
|--------|--------|-------|
| Priority select / ⤒ ↑ ↓ | writes `queue/control/priority.json` atomically; the worker re-reads it before every claim | `job_priority` / `job_reordered` |
| Cancel (pending) | renames the job to `queue/failed/` + `*.reason.json`; a pending fix returns the incident `fixing → triaged` | `job_cancelled` |
| Cancel running job | writes `queue/control/cancel-<job>`; the worker checks it between stages and its supervisor polls it during clone/Hermes/lab, then SIGTERM → SIGKILL to the child's process group; incident gets a `cancelled` / `triage_cancelled` result (fix → `triaged`) | `job_cancel_requested`, then the result |
| Retry (failed) | re-enqueues a fresh job of the same kind (refused for resolved/closed incidents); the failed file is marked retried | `{kind}_enqueued` "retry of failed job …" |
| Pause / Resume | `queue/control/paused.json`; the worker checks it between jobs and never kills a running job | — |

## Run locally

```bash
cd app
npm ci
OPS_DB_PATH=./data/ops.sqlite OPS_INGEST_SECRET=devsecret \
  OPS_TARGETS='[{"upstream":"example-upstream/neo","fork":"example-bot/neo"}]' npm start
# Admin: http://localhost:3000/admin   Health: http://localhost:3000/health
npm test
```

`npm test` runs the app/worker suite (the full suite, synthetic data only; it needs
loopback HTTP, so it is not part of the sandboxed flake checks). `nix flake
check` builds the npm-deps fixed-output derivation and the app (`checks.npm-deps`,
`checks.app-build`; a version bump in `app/package.json` / `package-lock.json` needs a new
`npmDepsHash` in `modules/packages/image.nix`), and runs the token-script tests and NixOS evaluation tests (namespace,
assertions).

Environment of the container (rendered by the module): `OPS_INGEST_SECRET` /
`OPS_INGEST_SECRET_FILE`, `OPS_DB_PATH`, `OPS_DATA_DIR`, `OPS_TARGETS`,
`OPS_TIME_ZONE`, `OPS_REDACT_HOSTNAMES`, `OPS_REDACT_PATTERNS`,
`OPS_PUBLIC_OWNERS`, `OPS_REDACT_EXTRA_SLUGS` (EnvironmentFile), `OPS_AUTOFIX_*`
feature flags, `ADMIN_*`.
