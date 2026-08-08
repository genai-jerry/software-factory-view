# 01 · Feature Inventory

Every feature the specification asks for, with a stable ID, its pillar, the
delivery phase it lands in, and — for anything that writes — **the GitHub object
it materialises as**. That last column is the enforcement mechanism for the
"never a second source of truth" invariant: a write feature with no GitHub
materialisation is a bug in the design, not a feature.

Legend for **Writes**: `—` read-only · `app` installation token · `user` acting
user's OAuth token · `native` Console-native data only (no GitHub equivalent
exists).

---

## A. Platform (`F-P*`) — the substrate

| ID | Feature | Phase | Writes | GitHub materialisation / notes |
|---|---|---|---|---|
| F-P1 | GitHub App registration, per-org installation, repo selection | 0 | app | App install; `installation` / `installation_repositories` webhooks |
| F-P2 | Webhook endpoint: HMAC verify → enqueue raw → 200 immediately | 0 | — | Never processes inline; verification precedes enqueue |
| F-P3 | Idempotency ledger (`webhook_deliveries`, delivery GUID + event id), 30-day raw retention | 0 | native | Replay/debug window, then dropped |
| F-P4 | Projection workers: idempotent upserts keyed by GitHub `node_id`, `gh_updated_at` last-writer-wins, order-tolerant | 0 | — | The rebuildability guarantee |
| F-P5 | Reconciler: nightly + on-demand API walk per estate, repairs drift | 0 | — | Makes "drop projections and rebuild" true, not aspirational |
| F-P6 | Artifact fetcher: Contents API at a specific ref, immutable cache keyed `(repo, path, commit_sha)` | 0 | — | No invalidation problem by construction; content encrypted at rest |
| F-P7 | Tenancy: `tenant_id` on every projection row, enforced centrally at the data layer | 0 | — | Not per-endpoint — a missed endpoint must not be a data leak |
| F-P8 | GitHub OAuth sign-in; user token encrypted at rest (per-tenant data key, envelope) | 0 | — | No password store, no identity mapping table |
| F-P9 | Dual-token GitHub client: installation token minted on demand (~1h, never persisted) vs user token for authority | 0/1 | app+user | The core design decision of §2.1 |
| F-P10 | Audit log: actor, capability, target, resulting GitHub operation (comment node id, merge SHA, PR number) | 1 | native | A convenience index — GitHub's own audit corroborates |
| F-P11 | Degradation posture: staleness banner past threshold, read-only-over-cache when GitHub is down, Q&A-only failure when insight is down | 0/2 | — | Each failure mode is a visible state, never a blank page |
| F-P12 | Invariant CI suite: no write endpoint mutates projection tables; every write endpoint declares its materialisation | 0 | — | Guards against two-sources-of-truth creep (spec §6 risk 1) |
| F-P13 | Marker conformance test: `console:*` markers never collide with `factory-agent` or exact-match `Approved` triggers | 1 | — | Mirrored upstream as a factory-side test |

## B. Read-model derivations (`F-R*`)

All computed from projections, all discardable.

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-R1 | Epic detection: carries a `factory:*` label **and** is not a sub-issue of another factory issue | 0 | `factory:fast-track` renders as a lightweight epic — no change folder, PR + CI only |
| F-R2 | Task detection: sub-issue of an epic; `task(...)` title convention | 0 | |
| F-R3 | Pipeline stage = the current `factory:*` label, verbatim. The Console computes nothing | 0 | Exactly one state label per issue (`FACTORY.md` §3) |
| F-R4 | `issue_state_history` from `labeled`/`unlabeled` events, append-only | 0 | Powers the timeline rail, cycle-time analytics, and the gate-latency baseline |
| F-R5 | PR kind derivation from branch naming: `factory/<n>-spec`, `factory/<n>-design`, `factory/<n>-<slug>`, `staging→main` | 0 | spec / design / task / promotion / other |
| F-R6 | Change folder discovery from spec-PR file lists → `changes`, `change_artifacts` | 0 | Tracks branch-tip **and** merged SHAs — the gate panel diffs these |
| F-R7 | Run projection with role parsing from workflow inputs/logs | 0 | So a workspace can say *which* agent acted and *why* |
| F-R8 | Task rollup + dependency graph from sub-issue relationships | 0 | n ready / in-review / in-test / done, blocked list |
| F-R9 | Attention queue — a **query, not a table** | 0 | Gates where I am an assigned approver and the epic is `*-ready`; `factory:blocked` in my estates; tasks awaiting an implementation `Approved` where I am on the implementation list; release trains awaiting my merge. Ordered by age |
| F-R10 | Comment classification: agent hand-offs (`<!-- factory-agent -->`), `Approved` comments, `console:*` markers, everything else → Inbox | 0 | |

## C. Mission control (`F-M*`) — pillar 4, estate home

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-M1 | Attention queue view with per-entry "why you" (which gate list put it here) and a deep link into the relevant workspace panel | 0 | **This query is the product's home page** |
| F-M2 | Pipeline board: epics as cards in columns matching the label state machine, one swim-lane per estate; task rollups, days-in-state, blocked badge | 0 | |
| F-M3 | Health strip: validation-suite status per repo, last webhook sync, recent run failures | 0 (skeleton) / 3 (full) | Full check set arrives with F-O7 |

## D. Epic workspace (`F-W*`) — pillar 4, the centrepiece

| ID | Feature | Phase | Writes | GitHub materialisation |
|---|---|---|---|---|
| F-W1 | Workspace shell: header, stage rail (label state machine drawn as a rail, current stage marked, my pending action highlighted), navigator / main pane / context rail | 0 | — | |
| F-W2 | `[≡ raw]` deep link on every element to the underlying GitHub object | 0 | — | Trust is built by never hiding the substrate |
| F-W3 | Freshness: which refs are rendered (branch tip vs merged) + last sync time | 0 | — | An approver must know whether they read the proposal *as it will merge* |
| F-W4 | Artifact reader: rendered `proposal.md`, `specs/`, `design.md`, `tasks.md`, with as-proposed ⇄ as-approved diff | 0 | — | |
| F-W5 | Timeline rail: state history + runs, clicking a past stage scrolls to that transition | 0 | — | |
| F-W6 | Tasks tab: board + dependency graph | 0 | — | |
| F-W7 | Threads (read): auto-created per artifact, per gate, per task sub-issue; classification of existing comments; Inbox thread; open/resolved status | 0 | — | Thread structure lives in comment markers, so it survives a rebuild |
| F-W8 | Thread posting round-trip | 1 | user | Real GitHub comment on the epic/task carrying `<!-- console:thread=<id> -->` |
| F-W9 | File an Inbox comment into a thread | 1 | native | Recorded as thread metadata — **no comment editing** |
| F-W10 | Private notes (`console_note`) — deliberately not posted | 1 | native | The only workspace content with no GitHub twin; degrades to loss-on-outage by design |
| F-W11 | Gate panel G1/G2 — "what you are approving": the exact document PR(s) **rendered**, not raw markdown in a diff viewer | 1 | — | |
| F-W12 | "What changed since you last looked": artifact diff against the reviewer's last visit or last rework round | 1 | native | Per-user last-viewed ref |
| F-W13 | Open-questions guard: unresolved threads on this gate's artifacts listed beside the approve control; approving anyway requires an explicit recorded acknowledgement | 1 | native | |
| F-W14 | **Approve** — one button per approver | 1 | user | Posts the literal string `Approved` via the user's OAuth token; the existing router does the merge + label flip + next-stage chain untouched |
| F-W15 | **Request changes** | 1 | user | An ordinary comment — by factory semantics that is exactly what it is |
| F-W16 | Manual path for users with repo rights: merge PR + flip label | 1 | user | |
| F-W17 | G2 cross-repo contract check: all design PRs side by side, shared contract snippet diffed across repos, ✓/✗ | 1 | — | Mechanises the `FACTORY.md` §7 "must be identical" invariant |
| F-W18 | G3 release panel: Release Manager's merge order, per-PR merge buttons | 1 | user | The merge button *is* the gate — the Console relocates the button, not the authority. App token is **never** used to merge |
| F-W19 | Blocked inbox + reply | 1 | user | An ordinary human comment on the `factory:blocked` issue; clears the state via the factory's own comment-trigger path. **No special unblock API** |
| F-W20 | Decision capture: from a thread, a Q&A answer, or scratch — title, context, options, choice, consequences, decider | 1 | user | Structured comment on the epic carrying `<!-- console:decision=<id> -->` |
| F-W21 | Decisions tab + org-wide decision search | 1 | native | Index only; the comment is the record |
| F-W22 | Supersede chain — linked, never edited in place | 1 | user | New comment linking the superseded decision |
| F-W23 | Gate approvals auto-recorded as decisions ("G1 approved by @alice", context = artifact SHAs) | 1 | native | Completeness without extra ceremony |
| F-W24 | Notifications: in-app inbox + email; sources = attention-queue entries, thread mentions, decisions on epics you participate in, canary/validation regressions | 1 | native | Default policy deliberately quiet: actionable-only on email. GitHub's own @-mentions are neither suppressed nor duplicated; emails link to both |
| F-W25 | Slack / outgoing webhook channel | 4 | native | Fast-follow per spec |

## E. Insight service (`F-I*`) — pillar 4, Q&A

Hard constraints on every feature here: **grounded, cited, bounded, read-only,
no cross-tenant retrieval, ever.** The service holds no write credentials.

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-I1 | Context assembly bounded to the epic's own surfaces: change folder at both refs, epic + task threads, PR diffs and reviews, run logs, `FACTORY.md`, the repo profile | 2 | |
| F-I2 | Model routing mirroring `factory-models.json` philosophy: cheap model for summarisation/digests, top-tier for gate analysis; configurable per org with a sane default chain | 2 | |
| F-I3 | Per-org token budget + per-question cost display | 2 | "Cost transparency is a feature, not a footnote" |
| F-I4 | Q&A panel with source chips (`file@sha`, comment, PR line) that open the source in place | 2 | An answer needing outside knowledge **says so** rather than improvising |
| F-I5 | Private (default) / shared visibility modes | 2 | Private is a thinking tool visible to the asker only |
| F-I6 | Promote an answer → thread comment or decision draft | 2 | Round-trips to GitHub attributed to the promoting user with a "drafted with assistance" footer |
| F-I7 | Thread digests: pinned model-generated summary for threads over *n* entries, per-claim citations, regenerated on new entries, clearly labelled as generated | 2 | |
| F-I8 | Gate review brief: scope summary, notable risks, apparent gaps against the WHEN/THEN scenarios, open questions from touching threads — every line cited, cached per artifact SHA | 2 | Advisory, never a substitute; the panel always shows the full artifacts |
| F-I9 | Canned insights, one-click and cost-labelled: summarise for a stakeholder · riskiest parts of this design · which scenarios lack a mapped test · why is task #N not ready · what changed since I approved the spec | 2 | |
| F-I10 | Evidence-annotated repo-profile drafting (reads build files, CI config, README, test layout) | 3 | Consumed by F-O5 and F-C4 |

## F. Onboarding (`F-O*`) — pillar 1

Every step is idempotent and reports **found / created / fixed**. Wizard state
is persisted (`onboarding_runs`) so it is resumable and re-runnable.

| ID | Feature | Phase | Writes | GitHub materialisation |
|---|---|---|---|---|
| F-O1 | Step 0 — install App, select repos, create estate (name, member repos, coordination repo), pin the factory version (`v1` branch / tag / SHA), designate the `@main` canary repo | 3 | app | Installation + Console-native estate record |
| F-O2 | Step 1 — labels: create the 14 `factory:*` labels idempotently, report drift (wrong colour/description → offered fix) | 3 | app | Replaces `scripts/setup-labels.sh` |
| F-O3 | Step 2 — secrets: prompt for `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, write as a **repository** Actions secret | 3 | app | Eliminates the environment-secret failure mode by construction. Write-through: **never stored by the Console** |
| F-O4 | Step 2b — multi-repo: `FACTORY_CROSS_REPO_TOKEN`, explain the fine-grained PAT scopes (Issues, Contents, Pull requests on every estate repo), link the pre-filled creation page, **probe each repo before writing the secret** | 3 | app | |
| F-O5 | Step 3 — OpenSpec presence: check for `openspec/` and the `/opsx:*` command set; if missing, open a PR with the deterministic `openspec init --tools claude` output, or show the one command to run locally and re-check | 3 | app | Node version and `OPENSPEC_TELEMETRY=0` are handled by the stub workflow env, not the user |
| F-O6 | Step 4 — profile authoring: agent-assisted draft (F-I10), side-by-side form + JSON validated live against `templates/profile.schema.json`, **smoke-execution of `test`/`build`/`lint` via a throwaway workflow run** | 3 | app | A commit on the enablement PR — never a Console-side copy |
| F-O7 | Step 5 — stub files PR: both workflow caller stubs **with `permissions:` intact** (the `startup_failure` trap), `factory-models.json`, `factory-approvers.json` pre-filled from estate gate assignments, the issue template with the estate's repos as checkboxes, `.claude/settings.json` with the merge deny-list, and the step-4 profile. PR body explains every file in one line | 3 | app | Merging it is the human act that enables the factory — deliberately a merge, not a Console button, since workflow stubs only fire from the default branch |
| F-O8 | Step 6 — validation suite (9 checks, below), on demand + nightly + after config changes; each check green/red with a one-click or one-command fix | 3 | — | **Makes no writes on an already-healthy repo** |
| F-O9 | Step 7 — canary run: files a real labelled canary issue, watches it traverse intake → G1 → planner → architect → G2 → one trivial task → done, rendered live in the Console's own workspace | 3 | user | Doubles as the product tour — the user's first gate approval happens here. Expected wall-clock and token cost shown up front; canary deletable afterwards |
| F-O10 | Resumability: a failing step records the raw API error and stays resumable; **completed steps re-verify, not re-execute**, on resume | 3 | — | |
| F-O11 | Permission-gap messaging: when the App lacks a permission a step needs, name the permission and link the installation settings page | 3 | — | Never fail opaquely |
| F-O12 | Adopt existing install: run the same validation suite against a manually-enabled repo, import gate assignments from `factory-approvers.json`, require zero re-setup | 3 | — | |

**Validation suite checks (F-O8)** — each maps to a real, observed failure:

| Check | Catches |
|---|---|
| 14 labels present and exact | broken routing |
| Stubs on default branch, `permissions:` intact, refs in sync (`uses:` ↔ `factory_ref`) | `startup_failure`, version skew |
| Repository-level secret exists (presence only, via API) | the environment-secret trap |
| Cross-repo PAT probes all estate repos | blocked multi-repo epics |
| `profile.json` parses + validates against schema | hard-blocked roles |
| `factory-models.json` roles parse; models probed reachable with the repo's credential | silent model fallbacks |
| `factory-approvers.json` users are collaborators | unassignable gates |
| OpenSpec initialised | intake failure |
| Issue template present | no entry point |

## G. Configuration (`F-C*`) — pillar 2

The layering model: **org defaults** (Console-native) → **estate defaults**
(Console-native) → **repo files** (in the repo — authoritative). Agents and the
pipeline never read the Console.

| ID | Feature | Phase | Writes | GitHub materialisation |
|---|---|---|---|---|
| F-C1 | Config-as-PR lifecycle (`config_edits`): draft validated live → config PR opened by the App with a human-readable diff summary, base = default branch → human merge → validation suite re-runs → health strip updates | 3 | app | G3 discipline applies to config too |
| F-C2 | Concurrency: a second save rebases onto the first's PR or surfaces a conflict — **no lost updates** | 3 | app | |
| F-C3 | Model routing editor: role × preference chain, drag-to-reorder, per-repo or estate-wide | 3 | app | `.github/factory-models.json` |
| F-C4 | Live model reachability probe using the repo's actual credential (mirrors the pipeline's one-token ping) | 3 | — | Shows which chain entry will really run **before** merge |
| F-C5 | Cost hinting: rough per-run cost per role from recent run history | 3 | — | Retuning a chain shows its money consequence |
| F-C6 | Gate & approver editor: per gate (spec, design, implementation, release), user picker restricted to repo collaborators, empty-list semantics ("any collaborator") called out explicitly | 3 | app | `.github/factory-approvers.json` |
| F-C7 | Bi-directional sync between the approver file and Console `gate_assignments`; **the file wins on drift**, and the health strip notes it ("design gate approvers changed by @alice via direct commit") | 3 | app | Mirror flips only when the PR merges |
| F-C8 | Repo profile editor post-setup: schema validation, evidence-annotated agent redraft, command smoke-execution, diff against the live file | 3 | app | `.factory/profile.json` |
| F-C9 | Org/estate defaults compiled down into per-repo files; a default change opens a config PR per affected repo showing the exact diff. **Nothing takes effect until those PRs merge** | 3 | app | |
| F-C10 | Per-repo override marking + three-way merge (default ∙ current file ∙ new default); conflicts surface for a human | 3 | app | An org-default change never silently clobbers an override |
| F-C11 | Factory version pinning per estate; bumping the pin opens stub-update PRs across the estate **with both refs kept in sync** | 3 | app | Solves the `FACTORY.md` §10 skew trap structurally |
| F-C12 | Gate strictness toggles — **only** those mapping to documented factory behaviour. Where a policy has no factory-side enforcement hook, the Console must not invent one | 3+ | app | Ships only after the corresponding factory change |
| F-C13 | Notification policy: which events notify which roles on which channels | 1/3 | native | No repo file involved |
| F-C14 | Org settings: insight model routing, token budget, Q&A retention, plan/seats, allowed estates | 3/4 | native | |
| F-C15 | Outside edits are first-class: re-ingest on push, update the view, flag org-default drift — **never overwrite silently** | 3 | — | |
| F-C16 | Direct-commit path: org admins only, repos that allow it only, still recorded in `audit_log` and rendered as a commit like any other | 3 | app | |

## H. Users, roles and access (`F-U*`) — pillar 3

Principle: **GitHub authorises actions, the Console authorises views and
workflows — and the Console never grants an action GitHub would deny.**

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-U1 | GitHub OAuth sign-in only (v1); a Console user *is* a GitHub user | 0 | No separate password store, no mapping table to drift |
| F-U2 | Org membership by invitation (email or GitHub login) | 4 | |
| F-U3 | Auto-join rules ("members of GitHub org X may join as Viewer"); joiners land as Viewer and a notification invites an Admin to upgrade them | 4 | |
| F-U4 | Console roles: Owner / Admin / Member / Viewer | 4 (skeleton in 1) | **Gate authority is not a role — it is an assignment.** A Member with no gate assignments is a full participant who can approve nothing |
| F-U5 | Capability-matrix enforcement, server-side | 1 (gate subset) / 4 (full) | Console check = UX (don't show buttons that will fail); GitHub/router check = security. Both always present for authoritative actions |
| F-U6 | `gate_assignments` mirror imported on estate connect and on every push touching `factory-approvers.json` | 0/1 | Needed to route notifications and build the attention queue before touching any repo |
| F-U7 | Approver validation: assignees must be Console org members **and** repo collaborators; the editor blocks otherwise | 3 | Closes the current silent failure |
| F-U8 | Estate scoping: Admins may restrict an estate to a member subset; restriction hides projections, artifacts, Q&A and notifications — enforced at the tenant-scoped query layer, not per page | 4 | |
| F-U9 | Repo visibility floor: artifact content is never served from a repo the user's GitHub identity cannot read; checked at grant time and re-checked daily | 4 | The Console must not be a side-channel around private-repo access |
| F-U10 | Membership lifecycle: removal invalidates sessions, deletes the OAuth token, and surfaces their gate assignments as **vacancies** on the health strip, prompting an Admin to open the approver-edit PR | 4 | The router-side file still lists them until that PR merges — the plan states this honestly rather than pretending otherwise |
| F-U11 | Revoked repo access lapses Console access at the next daily re-check or next action, whichever comes first | 4 | |
| F-U12 | Audit log surface + export | 4 | |
| F-U13 | SSO / SAML | later (enterprise) | Fronts the same GitHub-linked identity |

**Capability matrix (the enforcement contract)**

| Capability | Enforced by | Console check | GitHub check |
|---|---|---|---|
| View workspace / artifacts | Console | role ≥ Viewer + estate access | App installation covers repo |
| Post thread comment | both | role ≥ Member | user token can comment |
| Approve G1/G2 | GitHub + factory router | show only to assigned approvers | router honours only listed users; merge needs repo write |
| Start implementer (`Approved` on task) | GitHub + router | show to implementation assignees | same |
| G3 merges (staging→main, task PRs) | GitHub | show to release assignees | user token must have merge rights; **App token is never used to merge** |
| Reply to `factory:blocked` | GitHub | role ≥ Member | user token comments |
| Onboarding / config PRs | both | role ≥ Admin | App contents permission; merge still human |
| Manage members / billing | Console | Owner / Admin | — |

## I. Commercialisation (`F-B*`)

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-B1 | Stripe: per-seat tiers + metered insight tokens | 4 | Insight usage is the marginal cost — metered transparently, not hidden in seat price |
| F-B2 | Plan limits: allowed estates per plan (Solo 1 estate / 2 repos → Team → Business → Enterprise) | 4 | Pricing is a beta-validated sketch, not a commitment |
| F-B3 | Self-host packaging: identical images against the customer's Postgres/Redis and their **own GitHub App registration**, no phone-home except licence validation | 4 | |
| F-B4 | BYO Anthropic key | 4 | The pattern is established — factory agents already run on the customer's key |
| F-B5 | Private-beta onboarding of first external orgs | 4 | |

## J. Deployment & testing (`F-D*`) — pillar 5

Extends the workspace to the right of G3.

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-D0 | **Factory-side prerequisites** (land in the MIT repo, benefit non-Console users): standardised deployment-event emission in the deploy workflows, and a machine-parsable QA report format | 5 (upstream, can start earlier) | Blocks F-D1 and F-D4 |
| F-D1 | Environment registry per repo (staging/production), fed by `deployment` / `deployment_status` / `workflow_run` webhooks plus the profile's `deploy.health_checks` | 5 | Adds Deployments (R) to the App permission set |
| F-D2 | Release train view: merge order as a live board — per-repo staging status, CI, health-check results, with the F-W18 merge buttons now carrying environment context | 5 | |
| F-D3 | Staging watch: soak status, health-check history, `factory:incident` issues with rollback context, ops-stage archive/closure visible | 5 | |
| F-D4 | Test intelligence: QA-report parsing into a scenario→test coverage matrix per epic ("every WHEN/THEN mapped to a green test?"), rendered in the gate panel and a QA tab | 5 | |
| F-D5 | Later: ephemeral preview environments per task PR (needs factory-side workflow support first), synthetic checks, deploy annotations on the timeline | later | |

## K. Cross-cutting operations (`F-X*`)

| ID | Feature | Phase | Notes |
|---|---|---|---|
| F-X1 | Rate-limit posture: per-estate installation-token budgets, conditional requests (ETags), SHA-keyed artifact cache, reconciler backoff | 0 | |
| F-X2 | Retention & deletion: uninstall or estate deletion hard-deletes projections + artifact cache within 24h; Console-native data is export-then-delete on org request (GDPR-shaped); Q&A auto-expiry default 12 months; `audit_log` retained for the life of the org | 2/4 | |
| F-X3 | Metrics instrumentation: gate latency (`*-ready` → approval), blocked dwell time, onboarding conversion, workspace dwell vs `[≡ raw]` click-through, Q&A citation-follow rate | 0 (baseline) | **Baseline the historical numbers from `issue_state_history` before any UI ships**, so the before/after is honest |
| F-X4 | Observability: structured logs, queue depth/lag, webhook failure alerting, reconciler drift counts | 0 | Drift count is the health metric for the whole read model |
| F-X5 | Deployment: one image per service, docker-compose for self-host, Fly.io/Render for hosted | 0 | |

---

## Feature count by phase

| Phase | Features | Theme |
|---|---|---|
| 0 | ~34 | Read-only mission control + epic workspace (internal dogfood) |
| 1 | ~22 | Act from the workspace (the MVP loop closes) |
| 2 | ~10 | Ask the Factory |
| 3 | ~28 | Onboarding + configuration (productisation) |
| 4 | ~18 | Orgs, roles, billing (commercialisation) |
| 5 | ~6 | Deployment & testing |

## Explicit non-goals (all phases)

Replacing GitHub issues/PRs · running agents (the Console may `workflow_dispatch`
but never executes role prompts) · becoming a CI system · storing authoritative
spec or config content · any enforcement path that bypasses the factory router
or GitHub permissions · creating GitHub repos during onboarding · installing the
Claude Code plugin on developer machines · migrating historical pre-factory
issues into workspaces.
