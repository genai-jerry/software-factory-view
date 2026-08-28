# 10 — Factory ops view: queue, workers, workspaces

Companion to `claude-software-factory` → `docs/plan/execution-architecture.md`.
That document plans the orchestrator's move to a separate worker process
(Stage 2), a managed workspace record (Stage 3) and workspace reuse (Stage 4).
This one plans what the Console shows for it.

## The gap

The Console answers **"how is run X going"** well. `OrchestratorRunView`
polls `/api/orchestrator/runs/:runId` every 2s, renders phase, model, the
`events[]` timeline and the streaming transcript; `FactoryRunStatus` puts the
same live state on the epic workspace; GitHub failure comments link to
`/runs/:runId` and land on a same-origin page.

It cannot answer **"what is the factory doing right now"**:

- how many deliveries are queued, and whether any failed;
- which role processes are alive, on which host, at what pid, how far into
  their wall clock, and whether their heartbeat is fresh;
- what is on disk — which checkouts exist, which are leased, which are idle
  holding a tree open for the next role, how much space they take.

Before Stage 2 those questions had no answer to give: one process, one
tempdir, no record. After Stage 2 and 3 they are rows, and not showing them
would be the whole point of the refactor thrown away.

## Orchestrator endpoints this depends on

Added in Stages 2–3, all behind the dispatch token (§6.1 of the orchestrator
plan): `GET /queue`, `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`,
`GET /workspaces`, `POST /workspaces/{key}/release`, `DELETE
/workspaces/{key}`, `GET /workers`.

## Console API

Extend `apps/api/src/orchestrator-dispatch.ts` with `fetchOrchestratorQueue`,
`fetchOrchestratorJobs`, `fetchOrchestratorWorkspaces`, `fetchOrchestratorWorkers`
and the two mutations, following the shape of the existing
`fetchOrchestratorRun(s)` helpers — same base URL, same bearer token, same
`{ error, status }` union.

Register in `apps/api/src/routes/orchestrator.ts`:

| Console route | Proxies |
| --- | --- |
| `GET /api/orchestrator/queue` | `GET /queue` |
| `GET /api/orchestrator/jobs` | `GET /jobs` |
| `GET /api/orchestrator/workspaces` | `GET /workspaces` |
| `GET /api/orchestrator/workers` | `GET /workers` |
| `POST /api/orchestrator/jobs/:id/cancel` | `POST /jobs/{id}/cancel` |
| `POST /api/orchestrator/workspaces/:key/release` | `POST /workspaces/{key}/release` |
| `DELETE /api/orchestrator/workspaces/:key` | `DELETE /workspaces/{key}` |

The reads take `requireAuth` like the existing run routes. The three mutations
kill processes and delete disk, so they take **org-admin** (`isOrgAdminRole`),
not plain auth — the read views are for anyone watching the factory, the
destructive actions are not.

Workspace keys are `owner/repo#issue` and must be URL-encoded on the path;
decode and re-validate server-side rather than trusting the segment.

## The page

`apps/web/src/pages/FactoryOps.tsx`, routed at `/ops` in `App.tsx`, linked from
the "more" section of the side nav next to Decisions and Onboarding (it is an
operator view, not a daily one). Hide the entry for orgs on the GitHub Actions
orchestrator — there is no worker or workspace to show there, the same check
`/api/epics/:id/factory-run` already makes with `githubActionsEnabled`.

One `useQuery` per pane, `refetchInterval: 2000`, matching the existing run
view's cadence, and paused when the tab is hidden.

### Pane 1 — Queue

Depth, oldest waiting delivery's age, and a list of `failed` deliveries with
their stamped error. That error text is already written for operators
(`public_delivery_error` turns an unparsable App key into a sentence about the
placeholder), so render it verbatim rather than summarising it.

### Pane 2 — Workers

One card per job in `running`, plus a line per idle worker from `GET /workers`.

Each card: `repo#issue`, role, current phase (the same `guards.phase` the run
view already reads through `runPhase`), elapsed against remaining wall clock as
a bar, host/pid, heartbeat age. A heartbeat older than the grace window gets a
`stale` chip — that is the signal the reaper is about to act, and seeing it
before the reaper does is the point. Each card links to `/runs/:runId`, which
keeps the detailed log exactly where it already is.

Cancel sits on the card behind a confirm; it finishes the run as cancelled, so
the existing run page renders the outcome with no new state to teach it.

### Pane 3 — Workspaces

One row per key: state chip
(`cloning`/`ready`/`running`/`idle`/`stale`/`deleting`), size, lease holder
(job + pid) when running, idle age against the TTL, last role, and the factory
PR link when one is open. Sort `running` first, then `idle` by age — the rows
an operator acts on are the ones about to be swept.

Release and delete are the escape hatches, both org-admin, both confirmed.
Deleting a leased workspace is refused by the orchestrator, not by the UI; the
UI shows the refusal.

State chips reuse the existing chip styling from the pipeline board rather than
introducing a second visual language for status.

## Epic workspace

One addition, no new page: when a run on the epic is `running`, show the
workspace state beside it — "reusing workspace, 3rd role" or "cloning" — so the
Stage 4 win is visible where people actually look. `FactoryRunStatus` already
has the run; it needs one extra field from `GET /workspaces?key=`.

## Sequencing

1. With Stage 2: queue + workers panes, cancel. Nothing else exists yet.
2. With Stage 3: workspaces pane (all rows will be short-lived `running` →
   deleted, which is itself the proof the lease works).
3. With Stage 4: idle age, TTL, PR link, disk total against the cap, and the
   epic-workspace line.

Build the panes in that order so each ships against a real backend rather than
against a mock.

## Testing

- `apps/api` route tests: auth on reads, org-admin on mutations, key encoding,
  orchestrator error passthrough — mirroring `orchestrator-client.test.ts`.
- `apps/web` component tests alongside `OrchestratorRunView.test.tsx`: stale
  heartbeat renders the chip, a leased workspace disables delete, an empty
  queue renders the empty state rather than a spinner.
- One `e2e/ux.spec.ts` case: the page loads, the three panes render, and no
  destructive control is reachable as a non-admin.
