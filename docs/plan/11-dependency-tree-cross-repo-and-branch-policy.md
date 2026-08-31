# 11 — Dependency tree, cross-repo dependencies, branch policy, and the runs page

Practical findings from running one issue end-to-end through the factory, and
the plan that addresses them. Four workstreams; the first three span both
repositories, the fourth is orchestrator-only.

## 1. The task list is unmanageable in the classic GitHub view

Once the planner fans an epic out into task sub-issues, GitHub's flat issue
list hides the structure that matters: which task is blocked by which, which
needs an approval right now, and which is quietly waiting on a sibling. The
Console's Tasks tab groups by state but still doesn't show the *graph*.

**Plan: a Tree tab in the epic workspace.**

- New API `GET /api/epics/:id/tree` — the epic plus every task sub-issue
  (cross-repo sub-issues included; `issues.parent_issue_id` is repo-agnostic),
  with both directions of the dependency graph from `task_dependencies`, and
  per-node action capability:
  - a task at `factory:ready` is *approvable* — the start gate (FACTORY.md:
    `Approved` on a ready task starts its implementer);
  - the epic's own gate (G1/G2/G3) is reported so the tree can hand off to the
    existing gate panel.
- New API `POST /api/issues/:id/approve` — posts the literal `Approved` as the
  acting user on a `factory:ready` task, mirroring the gate panel's discipline:
  the Console relocates the button, the factory router keeps the authority.
  Approver check against the `implementation` gate assignments; audit-logged.
- Comments reuse the existing `POST /api/issues/:id/reply`.
- UI: nodes are laid out in dependency layers (topological order). Each node
  card shows: state chip, blocked badges naming the open blockers, an
  **Approve** button when the node is actionable, an inline comment composer,
  a repo chip when the task lives in a sibling repo, and the GitHub link.
  Blocked-on-a-human (`factory:blocked`) is visually distinct (halt colour)
  from waiting-on-a-dependency.

## 2. Dependencies must work across repositories

Today the *native* GitHub dependency relations already project cross-repo
(resolved by `node_id` in `repairDependencies`), but the body-marker fallback
(`blockerNumbersFromBody`) and the parent-issue heuristic
(`parentNumberFromBody`) resolve same-repo only — and the factory's planner
only ever writes `Blocked by #N`.

**Plan:**

- `packages/core/derive.ts`: parse `#12`, `owner/repo#12` and full GitHub
  issue URLs in dependency markers (`blocked by` / `depends on` / `after`) and
  in parent markers (`parent:` / `epic:` / `part of` / `sub-issue of`).
- `apps/worker/project.ts`: resolve qualified refs against any projected repo
  in the same org (repos are keyed by `full_name`); unqualified numbers keep
  resolving same-repo.
- Factory prompts (`commands/planner.md`, `commands/dispatch.md`): sub-issues
  in sibling repos must carry `Part of owner/repo#<epic>` and cross-repo
  dependencies must be written `Blocked by owner/repo#N` — one marker per
  line, so both the dispatcher and the Console parse them mechanically.
  FACTORY.md §7 documents the encoding.

## 3. Branch policy: PRs merge to staging; the org names the branches

The factory already targets the integration branch for implementation PRs and
auto-creates it (`.github/factory-branches.json`: `staging` / `required` /
`auto_create`, FACTORY.md §6a) — but the branch names were not configurable
anywhere in the Console, and a repo without the policy file silently rides on
hard-coded defaults.

**Plan:**

- `orgs` gains nullable `default_branch` and `staging_branch` columns
  (migration `0012_org_branches.sql`) — org-wide *defaults*, with GitHub and
  the repo's own policy file staying authoritative where present.
- `GET /api/orgs/:id/settings` returns a `branches` block;
  `POST /api/orgs/:id/settings/branches` (admin) sets it; Settings page gains
  a Branches section.
- Resolution order for a repo's integration branch becomes: profile override
  → repo policy file → **org setting** → `"staging"` (worker
  `refreshRepoProfile`).
- The onboarding stub-files PR now also writes
  `.github/factory-branches.json` templated from the org's setting (with
  `required: true, auto_create: true`), and the branch-guard stub watches the
  org's configured default branch — so a newly connected repo gets the org's
  policy on day one, and the factory's existing auto-create cuts the staging
  branch from the default branch on first need.

## 4. `/runs/{id}` shows raw JSON

Two causes found:

- The orchestrator mints run links in GitHub comments from its own
  `PUBLIC_BASE_URL` (`graph.py`), and its `GET /runs/{id}` serves bare JSON —
  so the link in the comment opens JSON even when the Console is healthy.
- Separately, on the VPS a Traefik hostname collision can route the Console's
  host to the orchestrator (ops runbook: `scripts/fix-vps-host-routing.sh`).

**Plan (orchestrator):**

- Prefer the Console origin when minting run URLs: dispatches already carry
  `console_url` (registered per-repo in `ConsoleTokenSource`); use it, fall
  back to `PUBLIC_BASE_URL`. The Console serves a real page at `/runs/{id}`.
- Content-negotiate `GET /runs` and `GET /runs/{id}`: a browser (`Accept:
  text/html`) gets a small server-rendered HTML run page (auto-refreshing
  while the run is live, linking the transcript); API callers — including the
  Console's own proxy — keep getting JSON.
