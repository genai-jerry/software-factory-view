# 04 · Delivery Plan

Phases → epics → task slices. Ordered **by pain, not by pillar numbering**: the
reviewer-overload problem (pillar 4) is why the product exists, so it ships
first; onboarding (pillar 1) is what makes it sellable to anyone but ourselves,
so it ships third.

Epics are sized to the factory's own constraint — one OpenSpec change per epic,
**max ~10 tasks** (`FACTORY.md` §5) — because the Console's development is
intended to run through the factory itself. Each epic below is one factory epic
issue.

---

## Phase B — Bootstrap

Not in the spec's phase list, but Phase 0 cannot start without it. Two epics,
roughly a week.

### E-B1 · Monorepo scaffold
`F-X5`

1. pnpm workspaces + Turborepo + TS project references; strict `tsconfig` base.
2. `apps/web` (Next.js App Router), `apps/api` (Fastify), `apps/worker` (BullMQ) — each with a health endpoint and a Dockerfile.
3. `packages/core`, `packages/db` (Drizzle + migration runner), `packages/insight` (stub).
4. `infra/docker-compose.yml`: Postgres 16, Redis, the three services.
5. Lint/format/test harness: ESLint, Prettier, Vitest, Playwright skeleton.
6. CI: typecheck, lint, unit tests, docker build for each image.
7. `.env.example` + config loading with schema validation (fail fast on missing config).

**Exit:** `docker compose up` yields three healthy services against an empty database, and CI is green.

### E-B2 · Factory-enable this repository
`F-O2`, `F-O3`, `F-O5`, `F-O7` — done manually, which is exactly the pain the wizard later removes

1. Create the 14 `factory:*` labels (`scripts/setup-labels.sh`).
2. Add `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) as a **repository** Actions secret.
3. `openspec init --tools claude`.
4. Author `.factory/profile.json` for this stack (TS monorepo, pnpm, Vitest, Playwright, Drizzle).
5. Copy the caller stubs `factory-pipeline.yml` + `factory-branch-guard.yml` **with their `permissions:` blocks intact**, `factory-models.json`, `factory-approvers.json`, the issue template, `.claude/settings.json`.
6. Merge to the default branch (stubs only fire from there), then file one throwaway canary issue and watch it traverse the pipeline.

**Exit:** an issue filed here reaches `factory:spec-ready` on its own.
**Side benefit:** every friction encountered here is a requirement for `F-O*` — capture it in the issue thread as it happens.

---

## Phase 0 — Read-only mission control (internal dogfood)

**No writes to GitHub at all.** Zero risk, immediate relief, and it validates
the read model against a live estate. Target estate: `insurance-app-base`.

**Exit criterion (from the spec, unchanged):** a **G2 review of a real epic
conducted entirely from the workspace**, with GitHub opened only via `[≡ raw]`
links.

### E0.1 · GitHub App, install and sign-in
`F-P1`, `F-P8`, `F-U1`, `F-P7`, `F-P9` (read half)

1. Register the GitHub App; manifest committed under `infra/` with the exact permission set (§02 3).
2. Install callback → create `orgs` + `estates` + `repos` rows from `installation` / `installation_repositories`.
3. GitHub OAuth sign-in; session rows in Postgres behind a signed HTTP-only cookie.
4. Envelope encryption for `users.encrypted_oauth_token` (per-tenant data key).
5. Tenant-scoped query layer in `packages/db`, with the greppable `unsafeUnscoped()` escape hatch.
6. Dual GitHub client factories in `packages/core`; installation tokens minted on demand, never persisted.
7. Tenancy leak test: a query issued for tenant A returns nothing belonging to tenant B, exercised at the data layer.

### E0.2 · Webhook ingestion
`F-P2`, `F-P3`, `F-P4`, `F-X4`

1. Fastify webhook endpoint: HMAC verify → enqueue raw → 200. No inline processing.
2. `webhook_deliveries` idempotency ledger; duplicate delivery short-circuits.
3. BullMQ queues (`ingest`, `reconcile`, `prefetch`) + worker process.
4. Upsert helper with the `gh_updated_at` guard, used by every projector.
5. Capture a real day of deliveries from `insurance-app-base` as a committed fixture corpus.
6. **Reverse-order + duplicate replay test** — projection must be byte-identical to forward-order single delivery.
7. Structured logging, queue depth/lag metrics, webhook failure alerting.

### E0.3 · Core projections
`F-R1`–`F-R5`, `F-R7`, `F-R10`

1. `issues` projector + epic/task/plain `kind` derivation; `factory:fast-track` as a lightweight epic.
2. `issue_state_history` from `labeled`/`unlabeled`, append-only.
3. `comments` projector: `is_agent` from `<!-- factory-agent -->`, `console_markers` parsing, `Approved` classification.
4. `pull_requests` projector + `kind` derivation from branch naming.
5. `pr_reviews` / `pr_review_comments` projectors.
6. `runs` projector with role parsing from workflow inputs/logs.
7. `check_suite` / `check_run` → `ci_status` rollup on PRs.
8. Projection integration tests over the fixture corpus.

### E0.4 · Reconciler and rebuildability
`F-P5`, `F-X1`, `F-P11` (staleness)

1. Per-estate API walk repairing drift; ETag-conditional requests.
2. Nightly schedule + on-demand trigger; per-estate token budget and backoff.
3. **Drift count** metric emitted per run.
4. Staleness banner state exposed on every estate/workspace payload.
5. **Rebuild test:** truncate all projection tables, run the reconciler, assert equality with the pre-truncate snapshot.

### E0.5 · Artifacts and change discovery
`F-P6`, `F-R6`, `F-W4`

1. Contents-API fetcher at a specific ref; immutable `(repo, path, commit_sha)` cache; content encrypted at rest.
2. Change-folder discovery from spec-PR file lists → `changes`, `change_artifacts`.
3. Track `latest_sha` (branch tip) and `merged_sha` (as approved) per artifact.
4. Markdown rendering pipeline (sanitised, GitHub-flavoured, mermaid-aware — the factory's own docs use mermaid).
5. As-proposed ⇄ as-approved diff view.
6. Prefetch job warming artifacts for epics in a `*-ready` state — the ones an approver is about to open.

### E0.6 · Mission control
`F-M1`, `F-M2`, `F-M3` (skeleton), `F-R8`, `F-R9`, `F-U6`

1. Import `gate_assignments` from `factory-approvers.json` on connect and on every push touching the file.
2. Attention-queue query + indexes; per-entry "why you" derivation.
3. Attention-queue UI with deep links into the target workspace panel, ordered by age.
4. Pipeline board: columns matching the label state machine, one swim-lane per estate.
5. Task rollup + days-in-state + blocked badge on cards.
6. Health strip skeleton: last webhook sync, recent run failures (validation checks arrive in Phase 3).

### E0.7 · Epic workspace (read)
`F-W1`–`F-W7`, `F-P11`

1. Workspace shell: navigator / main pane / context rail.
2. Stage rail drawn from the label state machine; current stage marked; my pending action highlighted; clicking a past stage scrolls the timeline.
3. `[≡ raw]` deep links on every element.
4. Freshness header: which refs are rendered + last sync time.
5. Artifact reader tab wired to E0.5.
6. Timeline rail: `issue_state_history` + `runs` interleaved.
7. Tasks tab: board + dependency graph from sub-issue relationships.
8. Degraded-state UI treatments: stale banner, GitHub-down read-only mode.

### E0.8 · Threads (read-only)
`F-W7`, `F-R10`

1. Auto-create threads per artifact, per gate, per task sub-issue.
2. Classify existing comments: agent hand-offs → the stage/gate thread they reference; `Approved` → its gate thread; everything else → Inbox.
3. Thread list + reader UI with open/resolved status.
4. Per-task thread mirroring of the sub-issue comment stream.

### E0.9 · Metrics baseline
`F-X3`

1. Derive historical **gate latency** (`*-ready` → approval) from `issue_state_history`.
2. Derive historical **blocked dwell time** (`factory:blocked` age until human reply).
3. Instrument workspace dwell and `[≡ raw]` click-through from day one of the UI.
4. Publish the baseline in `docs/metrics/baseline.md` **before Phase 1 ships**, so the before/after is honest.

---

## Phase 1 — Act from the workspace

This completes the MVP loop: **see → understand → decide, in one place.**

### E1.1 · The user-token write path
`F-P9` (write half), `F-P10`, `F-U5` (gate subset), `F-P12`, `F-P13`

1. User-token client wired to the session; token refresh and revocation handling.
2. Authoritative-operations module that structurally accepts only a user client.
3. Capability checks server-side for the gate subset of the matrix.
4. `audit_log` writes recording the resulting GitHub operation (comment node id, merge SHA, PR number).
5. **Invariant lint**: no write route mutates projection tables; every write route declares its GitHub materialisation.
6. **Marker conformance test** enumerating `console:*` markers against the factory's trigger semantics.
7. Human-readable failure surfaces for GitHub 403/409 (a denied merge must read as "GitHub says no", not as a Console error).

### E1.2 · Gate panel — G1 and G2
`F-W11`–`F-W16`

1. Panel appears when an epic sits at `factory:spec-ready` / `factory:design-ready`.
2. "What you are approving": the exact document PR(s), **rendered** — not raw markdown in a diff viewer.
3. "What changed since you last looked": diff against the reviewer's last-visited ref or last rework round (per-user last-viewed tracking).
4. Open-questions guard: unresolved threads on this gate's artifacts listed beside the approve control.
5. "Approve anyway" acknowledgement, recorded.
6. **Approve** — posts the literal string `Approved` via the user's token; the router does the rest, untouched.
7. **Request changes** — an ordinary comment.
8. Manual path for users with repo rights: merge PR + flip label.

### E1.3 · G2 cross-repo contract check
`F-W17`

1. Locate each affected repo's design PR for the change.
2. Extract the shared contract snippet from every `design.md`.
3. Normalise and diff across repos; render ✓ / ✗ with the mismatch shown **before** the approver acts.
4. Side-by-side rendering of all design PRs.

### E1.4 · G3 release panel
`F-W18`

1. Assemble the release train: `staging→main` promotion PRs per repo, plus task PRs where the repo has no staging branch.
2. Render the Release Manager's posted merge order.
3. Per-PR merge buttons using the **user's** token; the App token is never used to merge.
4. Guard rails: merge disabled until CI green and the preceding repo in the order has merged.

### E1.5 · Threads (write) and decisions
`F-W8`, `F-W9`, `F-W10`, `F-W20`–`F-W23`

1. Post a thread reply as a real GitHub comment carrying `<!-- console:thread=<id> -->`.
2. File an Inbox comment into a thread as thread metadata — **no comment editing**.
3. Private `console_note` entries, visibly marked as not-posted.
4. Decision composer: title, context, options, choice, consequences, decider.
5. On decide, post a structured comment carrying `<!-- console:decision=<id> -->` and index it.
6. Supersede chain — linked, never edited in place.
7. Auto-record gate approvals as decisions (context = artifact SHAs).
8. Decisions tab + org-wide decision search.

### E1.6 · Blocked inbox
`F-W19`

1. Surface `factory:blocked` sub-issues on the epic overview and the stage rail.
2. Blocked queue on mission control with age ordering.
3. Reply from the blocked thread as an ordinary human comment — **no special unblock API**; the factory's comment trigger clears the state.
4. Confirm the state clears within one sync cycle and show it.

### E1.7 · Notifications
`F-W24`, `F-C13`

1. In-app inbox.
2. Email channel with a deliberately quiet default: actionable-only (attention-queue entries).
3. Sources: gate ready, blocked, awaiting merge, thread mentions, decision made/superseded on epics you participate in.
4. Per-user `notification_prefs`.
5. Emails link to **both** Console and GitHub; GitHub's own @-mention notifications are neither suppressed nor duplicated.

---

## Phase 2 — Ask the Factory

Deliberately after Phase 1: grounding and citations need the artifact/thread
plumbing solid first, and the write path must already be human-attributed so
"promote answer to comment" lands correctly.

### E2.1 · Insight service foundation
`F-I1`, `F-I2`, `F-I3`, `F-X2` (Q&A retention)

1. `packages/insight` takes a *reader* interface only — structurally incapable of writing.
2. Context assembly bounded to the epic's surfaces: change folder at both refs, epic + task threads, PR diffs and reviews, run logs, `FACTORY.md`, repo profile.
3. Citation model: every claim carries `(source kind, path/sha or comment node_id, line range)`.
4. Model routing with a default chain, configurable per org.
5. Per-org token budget enforcement + per-question cost computation.
6. Cross-tenant retrieval test: context assembly for tenant A can never reach tenant B's material.
7. Q&A retention policy with a 12-month default auto-expiry.

### E2.2 · Q&A panel
`F-I4`, `F-I5`, `F-I6`

1. Conversational panel in the context rail.
2. Source chips (`file@sha`, comment, PR line) that open the source in place.
3. "I would need outside knowledge" refusal path instead of improvising.
4. Private (default) / shared visibility.
5. Promote an answer → thread comment or decision draft, attributed to the promoting user with a "drafted with assistance" footer.
6. Per-question cost display and remaining budget.

### E2.3 · Generated summaries
`F-I7`, `F-I8`, `F-I9`

1. Thread digests for threads over *n* entries: cheap model, per-claim citations, regenerated on new entries, clearly labelled generated.
2. Gate review brief: top-tier model, cached per artifact SHA — scope summary, notable risks, apparent gaps against the WHEN/THEN scenarios, open questions from touching threads.
3. Advisory framing enforced in the UI: the full artifacts are always adjacent.
4. The five canned insights, one-click and cost-labelled.
5. Insight-down behaviour: every panel except Q&A and generated summaries remains fully functional.

---

## Phase 3 — Onboarding and configuration (productisation)

After this phase a stranger goes from "installed the App" to "first gate
approved on a canary" **without reading `FACTORY.md`**.

### E3.1 · Wizard shell and steps 0–2
`F-O1`–`F-O4`, `F-O10`, `F-O11`

1. `onboarding_runs` state machine: resumable, re-runnable, every step reports found / created / fixed.
2. Step 0: repo selection, estate creation, coordination repo, factory version pin, canary designation.
3. Step 1: create the 14 labels idempotently; detect and offer to fix colour/description drift.
4. Step 2: `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` written as a **repository** Actions secret, write-through, never stored.
5. Step 2b: `FACTORY_CROSS_REPO_TOKEN` with scope explanation, pre-filled creation link, and **per-repo reach probing before the secret is written**.
6. Failure handling: record the raw API error, stay resumable, **re-verify rather than re-execute** completed steps.
7. Permission-gap messaging naming the missing permission and linking installation settings.

### E3.2 · OpenSpec check and the stub PR
`F-O5`, `F-O7`

1. Detect `openspec/` and the `/opsx:*` command set at the repo root.
2. Offer either a PR carrying the deterministic `openspec init --tools claude` output, or the one command to run locally, then re-check.
3. Stub PR builder assembling the whole consuming-repo footprint: both caller stubs **with `permissions:` intact**, `factory-models.json`, `factory-approvers.json` pre-filled from gate assignments, the issue template with the estate's repos as checkboxes, `.claude/settings.json` with the merge deny-list, and the step-4 profile.
4. PR body explaining every file in one line.
5. The wizard **does not merge it** — merging is the human act that enables the factory, and stubs only fire from the default branch.

### E3.3 · Profile authoring
`F-O6`, `F-I10`, `F-C8`

1. Agent-assisted draft reading build files, CI config, README and test layout; each field annotated with the evidence it came from.
2. Side-by-side form + JSON editor validated live against `templates/profile.schema.json`.
3. Smoke-execute `test` / `build` / `lint` via a throwaway workflow run — "the test command actually runs" is verified before the factory depends on it.
4. Output as a commit on the enablement PR, never a Console-side copy.
5. Post-setup re-entry: diff against the live file, agent redraft after a stack change, save = config PR.

### E3.4 · Validation suite and health strip
`F-O8`, `F-M3` (full)

1. Implement all nine checks (see `01-feature-inventory.md` §F).
2. Each check reports green/red with a one-click or one-command fix.
3. **Makes no writes on an already-healthy repo** — asserted by test.
4. Run on demand, nightly, and after every config-PR merge.
5. Health strip becomes the persistent estate-page surface; regressions notify estate operators.

### E3.5 · Canary run and adoption
`F-O9`, `F-O12`

1. File a real labelled canary issue ("Add a `FACTORY_CANARY.md` containing the run date").
2. Show expected wall-clock and token cost up front.
3. Watch it traverse intake → G1 → planner → architect → G2 → one trivial task → done, live in the Console's own workspace — the user's first gate approval happens here.
4. Make the canary deletable afterwards.
5. **Adopt existing install**: run the same validation suite against a manually-enabled repo, import gate assignments, require zero re-setup.

### E3.6 · Config-as-PR lifecycle
`F-C1`, `F-C2`, `F-C15`, `F-C16`

1. `config_edits` lifecycle: draft → validated → App-opened PR with a human-readable diff summary → human merge → validation re-run.
2. Base = default branch (docs-path-safe under the factory's `paths-ignore` rules).
3. Concurrency: second save rebases onto the first's PR or surfaces a conflict — no lost updates.
4. Validation blocks PR creation on schema failure, unreachable model, or non-collaborator approver — explained **in the editor**, not in a failed pipeline run three hours later.
5. Outside edits re-ingested on push, view updated, org-default drift flagged — never overwritten silently.
6. Admin direct-commit path for repos that allow it, recorded in `audit_log`.

### E3.7 · Config editors
`F-C3`–`F-C8`

1. Model routing editor: role × preference chain, drag-to-reorder, per-repo or estate-wide.
2. Live reachability probe using the repo's actual credential (mirrors the pipeline's one-token ping).
3. Cost hinting per role from recent run history.
4. Gate & approver editor with a collaborator-restricted picker; empty-list semantics ("any collaborator") stated explicitly in the UI.
5. Bi-directional sync with `gate_assignments`; on drift **the file wins** and the health strip notes who changed it and how.
6. Approver validation: Console member **and** repo collaborator.

### E3.8 · Org and estate defaults
`F-C9`, `F-C10`, `F-C11`, `F-C14`

1. Org-level and estate-level default templates.
2. Compiler producing per-repo file contents from defaults.
3. A default change opens a config PR per affected repo with the exact diff; **nothing takes effect until they merge**.
4. Override marking + three-way merge (default ∙ current file ∙ new default); conflicts surface for a human.
5. Factory version pinning per estate; bumping opens stub-update PRs across the estate **with `uses:` and `factory_ref` kept in sync**.
6. Org settings surface: insight routing, token budget, Q&A retention.

---

## Phase 4 — Orgs, roles, billing (commercialisation)

### E4.1 · Full RBAC
`F-U2`, `F-U3`, `F-U4`, `F-U5` (full), `F-U8`

1. Invitations by email or GitHub login.
2. Auto-join rules; joiners land as Viewer, an Admin is notified to upgrade them.
3. Owner / Admin / Member / Viewer with the full capability matrix enforced server-side.
4. Estate scoping restricting an estate to a member subset — enforced at the tenant-scoped query layer, hiding projections, artifacts, Q&A and notifications.
5. Negative tests: a crafted gate action from an unassigned Member is rejected server-side.

### E4.2 · Access lifecycle
`F-U9`, `F-U10`, `F-U11`

1. Repo visibility floor: artifact content served only after a per-user repo-access check.
2. Daily re-check job; access lapses at the next re-check or next action, whichever comes first.
3. Member removal: sessions invalidated, OAuth token deleted.
4. Gate-assignment vacancies surfaced on the health strip, prompting the Admin to open the approver-edit PR — the plan states plainly that the router-side file still lists them until that PR merges.

### E4.3 · Audit and retention
`F-U12`, `F-X2`

1. Audit log surface with filtering, plus export.
2. Uninstall / estate deletion hard-deletes projections + artifact cache within 24h.
3. Export-then-delete for Console-native data on org request.
4. Retention policy jobs and their observability.

### E4.4 · Billing and packaging
`F-B1`–`F-B5`, `F-W25`

1. Stripe: per-seat tiers + metered insight tokens.
2. Plan limits (estates/repos per tier) enforced at the estate-creation path.
3. BYO Anthropic key.
4. Self-host packaging: docker-compose, licence validation, own GitHub App registration, no phone-home.
5. Slack / outgoing webhook notification channel.
6. Private-beta onboarding runbook for the first external orgs.

---

## Phase 5 — Deployment and testing (pillar 5)

Extends the workspace to the right of G3.

### E5.0 · Factory-side prerequisites (upstream, in the MIT repo)
`F-D0` — **can and should start earlier than Phase 5**

1. Standardise deployment-event emission in the deploy workflows.
2. Define a machine-parsable QA report format.

Both are small, both benefit non-Console users, and both are hard blockers for
E5.1 and E5.4 — so file them in `claude-software-factory` during Phase 3 rather
than discovering the dependency in Phase 5.

### E5.1 · Environment registry
`F-D1`

1. Add Deployments (R) to the App permissions; consume `deployment` / `deployment_status`.
2. Environment registry per repo (staging, production), fed by those events plus `workflow_run`.
3. Health-check execution and history from the profile's `deploy.health_checks`.

### E5.2 · Release train and staging watch
`F-D2`, `F-D3`

1. Release-train board: per-repo staging status, CI, health-check results, with the E1.4 merge buttons now carrying environment context.
2. Soak status and health-check history.
3. `factory:incident` issues surfaced with rollback context; ops-stage archive/closure visible.

### E5.3 · Test intelligence
`F-D4`

1. Parse QA reports into a scenario→test coverage matrix per epic.
2. "Every WHEN/THEN mapped to a green test?" rendered in the gate panel and a QA tab.
3. Wire the "which scenarios lack a mapped test" canned insight (F-I9) to real data.

---

## Sequencing summary

```
Phase B ──► Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
  (scaffold)  (see)      (decide)    (understand) (sell)     (charge)
                                          │
                              E5.0 upstream ├──────────────► Phase 5
```

Dependencies worth naming explicitly:

| This | Needs | Because |
|---|---|---|
| E1.2 gate panel | E0.5 change artifacts | The panel diffs `latest_sha` against `merged_sha` |
| E1.5 thread posting | E0.8 thread classification | Posting into a thread requires threads to exist |
| E2.x insight | E0.5 + E0.8 + E1.1 | Grounding needs artifacts and threads; promotion needs the human-attributed write path |
| E3.3 profile authoring | E2.1 insight foundation | The agent draft is an insight-service call |
| E3.7 approver editor | E3.6 config-as-PR | Every approver edit is a config PR |
| E4.1 estate scoping | E0.1 tenant-scoped query layer | Scoping is a filter on an existing enforcement point, not a new one |
| E5.1, E5.3 | E5.0 upstream | Deployment events and QA format do not exist yet |

## Success metrics (baselined in E0.9, reported per phase)

| Metric | Target direction |
|---|---|
| **Gate latency** — `*-ready` label to approval | Down. This is the number the product exists to cut |
| **Reconstruction cost proxy** — workspace dwell + `[≡ raw]` click-through | Raw links used for *trust*, not *necessity* |
| **Blocked dwell time** — `factory:blocked` age until human reply | Down |
| **Onboarding conversion** — App install → canary approved, and time taken | Up, fast |
| **Q&A citation-follow rate** | Up — are answers trusted and checkable? |

## Estimating note

No calendar estimates are given here on purpose: team size and the degree to
which the factory itself does the implementation are both undecided (`D-4` in
`05-decisions-and-risks.md`). What *is* fixed is the shape — 6 epics of
bootstrap-and-read before any write, then one epic per coherent capability —
and each epic is independently shippable behind a flag, so the plan survives a
re-estimate without re-planning.
