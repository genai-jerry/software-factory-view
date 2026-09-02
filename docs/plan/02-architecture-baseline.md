# 02 · Architecture Baseline

Decisions that must be settled before the first epic is filed, because changing
them later is expensive. Everything here follows the spec's recommendation
(§01 6) unless a note says otherwise.

> **Revision (2026-08-09):** the spec recommended Next.js SSR for the web
> layer. Per product-owner direction, the web layer is instead a **separate
> single-page application talking to the API over HTTP** — a clean UI/backend
> split with an API-driven contract. The SSR rationale ("fast first paint of
> workspaces") is traded for a simpler deployment story, one authorisation
> surface (the API), and independent scaling/release of UI and backend. §1a
> below defines the security and deployment structure this requires.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | One toolchain; shared types between API and web |
| Web | **React 18 + Vite SPA** (react-router, TanStack Query) | Static asset bundle; no server runtime of its own; deployable on any static host or nginx container |
| API | Fastify, **separate service** | The single backend surface: auth, REST API, webhook endpoint |
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
| Monorepo tooling | pnpm workspaces | Cheapest thing that works across `apps/` and `packages/` |
| Web ↔ API boundary | The SPA calls the Fastify API over HTTP with a session cookie; request/response shapes are Zod schemas exported from `packages/core` and shared by both sides | Keeps one authorisation implementation. The web app holds **no** GitHub credentials of its own — it is static files |
| Session store | Signed, HTTP-only cookie → server-side session row in Postgres | Session rows are revocable, which F-U10 (removal invalidates sessions) requires |
| Testing | Vitest (unit/integration) + webhook fixtures replayed through the projectors | Fixture-driven projection tests are the only honest way to prove order-tolerance |

## 1a. SPA + API: security and deployment structure

The split introduces a browser↔API trust boundary that SSR did not have.
Decisions, in order of consequence:

**Same-origin deployment.** In every deployed environment the SPA and the API
share one public origin: nginx (or the platform's edge) serves the static
bundle and reverse-proxies `/api/*` and `/auth/*` to the API service, and
`/webhooks/*` directly to the API as well. Same-origin means cookies need no
`SameSite=None`, no CORS surface exists in production, and the SPA needs no
configured API base URL. In development, the Vite dev server proxies the same
paths to the local API — the browser still sees one origin.

**Authentication.** GitHub OAuth (authorization-code flow) handled entirely by
the API. On callback the API creates a session row and sets an **opaque session
id** in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. No JWT in
`localStorage` — nothing readable by page JavaScript, nothing to exfiltrate via
XSS, and sessions are individually revocable (F-U10).

**CSRF.** Two independent layers: `SameSite=Lax` blocks cross-site sends of
the cookie on non-navigation requests, and every state-changing endpoint
requires an `X-Console-Csrf: 1` custom header — a cross-origin page cannot add
a custom header without a CORS preflight, which the API (no CORS enabled)
rejects. OAuth callback is additionally protected by the `state` parameter.

**Webhook endpoint.** `/webhooks/github` is unauthenticated by design and
verified by HMAC signature instead; it lives on the API service but outside the
session/CSRF middleware, and never sets cookies.

**Content security.** The API sets `Cache-Control: no-store` on all
authenticated JSON. nginx sets a strict CSP on the SPA (self-only scripts,
no inline), `X-Content-Type-Options`, and `frame-ancestors 'none'`. Rendered
markdown is sanitised server-side before it reaches the SPA.

**Deployment units.** Four containers behind one edge: `web` (nginx + static
bundle), `api` (Fastify), `worker` (BullMQ), plus Postgres and Redis. UI and
API version independently; the API carries the OpenAPI-shaped contract and
rejects unknown-version breaking calls rather than assuming lockstep deploys.

## 2. Monorepo layout

```
apps/web/          React + Vite SPA — static assets only, no GitHub credentials
apps/api/          Fastify API + auth + webhook endpoint
apps/worker/       BullMQ workers (ingest, reconcile, prefetch, insight)   [added to the spec's list]
packages/core/     domain model, projection logic, GitHub client, config compiler, Zod contracts
packages/insight/  context assembly + Claude API wrapper
packages/db/       Drizzle schema, migrations, tenant-scoped query layer
infra/             docker-compose, nginx config, deploy manifests
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

**Token lifetime and renewal.** Both paths expire, and neither expiry is
allowed to reach the user as an error. Installation tokens live ~1h and are
minted on demand, with a re-mint forced when a call comes back 401. A GitHub App
with *Expire user authorization tokens* enabled — the default — issues user
tokens that die after **8 hours**, alongside a refresh token good for **6
months** which GitHub rotates on every use. The API therefore stores the whole
grant (access token, refresh token, both expiries, encrypted) and renews it
five minutes ahead of expiry, again on a 401, and only ever once at a time per
user — two exchanges racing on one rotating refresh token would leave the
loser holding a credential GitHub has already retired. A human is asked to sign
in again only when GitHub disowns the refresh token itself; that answer reaches
the SPA as `401 {reauth: true}`, which raises a "sign in again" banner rather
than a dead-end error.

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
  (KMS-style envelope) — the refresh token alongside the access token, since
  the grant is renewed server-side (§3). Clearing a user's stored grant takes
  effect on their next request, not on the next restart. **Installation tokens
  are never persisted** — minted on demand, ~1h lifetime.
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
