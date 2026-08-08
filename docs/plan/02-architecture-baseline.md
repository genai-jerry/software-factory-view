# 02 · Architecture Baseline

Decisions that must be settled before the first epic is filed, because changing
them later is expensive. Everything here follows the spec's recommendation
(§01 6) unless a note says otherwise.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | One toolchain; shared types between API and web |
| Web | Next.js (App Router) | SSR for fast first paint of workspaces |
| API | Fastify, **separate service** | Webhooks must not share Next.js cold-start behaviour |
| Jobs/queue | BullMQ on Redis | Webhook workers, reconciler, artifact prefetch, insight jobs |
| DB | Postgres 16 | Projections + native data. `pgvector` only *if and when* artifact search needs it — not in Phase 0 |
| GitHub | Octokit (App + OAuth flavours) | |
| LLM | Anthropic TypeScript SDK | Insight service only |
| Billing | Stripe | Seats + metered insight tokens |
| Deploy | Docker Compose (self-host) / Fly.io or Render (hosted) | One image per service |

**Choices the spec left open, resolved here:**

| Open item | Decision | Rationale |
|---|---|---|
| Drizzle vs Prisma | **Drizzle** | Projection workers do high-volume `INSERT … ON CONFLICT DO UPDATE` upserts with a `gh_updated_at` guard in the `WHERE` clause. Drizzle expresses that natively; Prisma's `upsert` cannot carry the guard without raw SQL, which would defeat the point of the ORM on the hottest path |
| Monorepo tooling | pnpm workspaces + Turborepo | Cheapest thing that caches builds across `apps/` and `packages/` |
| Web ↔ API boundary | Next.js server components call the Fastify API over internal HTTP; request/response shapes are Zod schemas exported from `packages/core` | Keeps one authorisation implementation. The web app holds **no** GitHub credentials of its own |
| Session store | Signed, HTTP-only cookie → server-side session row in Postgres | Session rows are revocable, which F-U10 (removal invalidates sessions) requires |
| Testing | Vitest (unit/integration) + Playwright (E2E) + recorded webhook fixtures from the live estate | Fixture-driven projection tests are the only honest way to prove order-tolerance |

## 2. Monorepo layout

```
apps/web/          Next.js app — rendering only, no GitHub credentials
apps/api/          Fastify API + webhook endpoint
apps/worker/       BullMQ workers (ingest, reconcile, prefetch, insight)   [added to the spec's list]
packages/core/     domain model, projection logic, GitHub client, config compiler, Zod contracts
packages/insight/  context assembly + Claude API wrapper
packages/db/       Drizzle schema, migrations, tenant-scoped query layer
infra/             docker-compose, deploy manifests
docs/              this spec set and plan
```

The spec lists five services; `apps/worker` is broken out from `apps/api`
because webhook *acceptance* (must return 200 in milliseconds) and webhook
*processing* (may take seconds and retry) have opposite scaling and failure
characteristics. They share `packages/core`, so this is a deployment split, not
an architectural one.

## 3. The token model — the core design decision

Two credential paths, never interchangeable:

| Token | Identity | Used for |
|---|---|---|
| **Installation token** (app-to-server) | the app | Webhook verification, reading issues/PRs/contents, onboarding automation (labels, stub PRs, Actions secrets, config validation), non-authoritative comments |
| **User OAuth token** (user-to-server) | the human | Everything carrying authority: `Approved` comments, gate label flips, merging PRs (G1/G2 document PRs and G3 release merges), replies that unblock `factory:blocked` issues, closing issues |

**Why this is not negotiable.** The factory's enforcement is router-side and
identity-based (`factory-approvers.json`, `FACTORY.md` §2b). If the Console
posted approvals as the app, every approval would look like the same bot and
the approver lists would be meaningless. Using the user's own token means the
existing pipeline sees exactly what it sees today — a human it can authorise —
and the Console needs no parallel enforcement layer. GitHub's native permission
checks still apply: a user who cannot merge on GitHub cannot merge via the
Console.

**Enforcement mechanism.** `packages/core` exposes two client factories,
`installationClient(estateId)` and `userClient(session)`. The merge, approve,
label-flip and comment-as-human operations live on a module that only accepts a
`userClient`. A lint rule (F-P12) fails CI if an authoritative operation is
reachable from an installation client.

**App permissions requested:** Issues (RW), Pull requests (RW), Contents (RW),
Actions (R), Checks (R), Workflows (R), Actions secrets (W — onboarding only),
Members (R), Metadata (R). Deployments (R) is added in the Phase 5 slice, not
before — asking for a permission we do not yet use is a bad look on an install
screen.

## 4. Webhook events consumed

`issues`, `issue_comment`, `label`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `push`, `check_suite`, `check_run`,
`workflow_run`, `installation`, `installation_repositories`,
`member` / `membership` / `organization` (RBAC sync), and later
`deployment` / `deployment_status`.

**Ingestion contract** (three sentences, all testable):

1. Verify HMAC signature → enqueue raw payload → return 200 immediately.
2. Workers are **idempotent** (delivery GUID + event id de-dupe) and
   **order-tolerant** (each projection is an upsert keyed by GitHub `node_id`;
   `updated_at` from GitHub wins over arrival order).
3. A nightly + on-demand reconciler walks the GitHub API per estate and repairs
   drift from missed deliveries or edits made while the Console was down.

That contract is what makes the read model rebuildable from scratch. It is
worth stating the test that proves it: **replay a recorded day of webhook
deliveries in reverse order and in duplicate; the resulting projection must be
byte-identical to forward-order single delivery.**

## 5. Artifact fetching and caching

The change folder (`openspec/changes/<epic>-<slug>/`), `.factory/profile.json`
and the `.github/factory-*.json` configs are fetched via the Contents API **at a
specific ref** and cached by `(repo, path, commit_sha)` — immutable entries, so
there is no invalidation problem.

The workspace always states which ref it renders (spec-branch tip vs merged
`main`), because a gate approver must know whether they are reading the
proposal as it will merge. This is a UI requirement derived from a caching
decision, which is why both live in the same section.

## 6. Multi-tenancy and security

- **Tenant = Console org**, keyed to one or more GitHub App installations. Every
  projection row carries `tenant_id`; every query is tenant-scoped **at the data
  layer**, enforced centrally, not per endpoint. `packages/db` exposes no
  unscoped query builder — obtaining one requires an explicit, greppable
  `unsafeUnscoped()` escape hatch used only by the reconciler.
- **User OAuth tokens** encrypted at rest with a per-tenant data key
  (KMS-style envelope). **Installation tokens are never persisted** — minted on
  demand, ~1h lifetime.
- **Webhook payloads** are HMAC-verified before enqueue; raw payloads retained
  30 days for replay/debug, then dropped.
- **Repo file content in the artifact cache is customer source material:**
  encrypted at rest, purged on uninstall, never used for model training, sent
  to the LLM only within that tenant's own insight requests.
- **Self-hosted tier** runs identical images against the customer's own
  Postgres/Redis and their own GitHub App registration — no phone-home except
  licence validation.

Tenancy is built in from the first commit even though Phase 0 has exactly one
tenant. Retrofitting `tenant_id` into a populated projection schema, and
retrofitting scoping into hand-written queries, is the kind of work that never
gets done properly.

## 7. Failure posture

| Failure | Behaviour |
|---|---|
| Console down | Factory unaffected — it never sat in the control path |
| Webhooks missed | Reconciler repairs; workspaces show a staleness banner when last successful sync exceeds a threshold |
| GitHub down | Console degrades to read-only over cached data, clearly labelled stale |
| Insight service down | Workspaces fully usable; Q&A panel shows retry |

Each of these is a designed, visible state with a UI treatment — not an error
page. They are acceptance criteria for Phase 0, not polish for later.

## 8. Source-of-truth invariants (CI-tested)

These are the spec's §01 3 rules restated as things a test can fail on:

1. **Pipeline state lives in GitHub labels/issues.** The Console renders it and
   never stores an alternative state field a user can edit.
   *Test:* no projection table has a column writable by an API route.
2. **Spec content lives in `openspec/` in the repo.** The Console renders it and
   never offers a rich-text editor whose output lives only in Postgres.
   *Test:* no write route persists markdown bodies for artifact paths.
3. **Configuration lives in the consuming repo's files.** The Console edits them
   by commit/PR, never by shadow copy.
   *Test:* every config write route returns a PR number or commit SHA.
4. **Anything with authority is a GitHub operation under a user identity.**
   *Test:* the token-model lint of §3.
5. **Console-native data degrades gracefully.** Threads and decisions are also
   written into GitHub comments via hidden markers, so a Console outage never
   hides an approval request or a decision from people working in plain GitHub.
   *Test:* rebuild-from-GitHub recovers all thread membership and decisions;
   only private notes and Q&A depend on Console backups.

## 9. The marker scheme

Console structure round-trips through hidden HTML comments in GitHub comment
bodies:

```
<!-- console:thread=proposal -->
<!-- console:decision=<id> -->
```

This is the same mechanism the factory already uses for `<!-- factory-agent -->`,
so it survives the factory's comment-triggered automation. Two properties make
the collision risk manageable and both need a test:

- Markers are **namespaced** (`console:*` vs `factory-agent`).
- The factory's comment triggers match either exact bodies (`Approved`) or
  human-vs-agent authorship — a trailing HTML comment affects neither. Verified
  against `.github/workflows/factory-pipeline.yml`, which tests
  `body.includes('<!-- factory-agent -->')` and exact-matches `Approved`.

A **conformance test enumerating known markers** ships in this repo and is
mirrored upstream into the MIT factory repo, so a future factory change that
would break the scheme fails there first.

## 10. Insight service constraints

Stated here because they are architectural, not feature-level:

- **Grounded, cited, bounded.** Context is assembled only from the epic's own
  surfaces. No cross-tenant retrieval, ever.
- **Read-only.** The insight service holds **no write credentials**. It can
  draft a comment or a decision; a human posts it, which then flows through the
  normal user-token path.
- **Routed and budgeted.** Cheap fast model for summarisation and thread
  digests; top-tier model for gate-review analysis and design questions;
  configurable per org with a sane default chain, per-org token budgets, and
  per-question cost display.

`packages/insight` therefore takes a *reader* interface as its only dependency
and is structurally incapable of writing — the same trick as the token model,
applied one layer up.
