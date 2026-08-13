# 08 · Pipeline view implementation plan

**Status:** implementation plan for [07-pipeline-view-state-display](07-pipeline-view-state-display.md).
**Shape:** six work packages (WP1–WP6), each independently shippable, ordered so
the two missing projections — assignees ("my issues") and task dependencies —
land early because everything personal hangs off them.

Invariants every package must preserve:

- **Rebuildable projections.** Every new column/table in the projections area is
  repairable from the GitHub API by `reconcileEstate` (`apps/worker/src/reconcile.ts:22`)
  — drop it, reconcile, it comes back. Nothing personal-view-related may live
  only in webhook-delivered state.
- **LWW guards.** New issue columns ride the existing `setWhere: ghUpdatedAt <=`
  guard in `projectIssue` (`apps/worker/src/project.ts:139-154`); new tables use
  delete-then-insert repair (the `importGateAssignments` pattern, `artifacts.ts:152`).
- **Org scoping at the data layer.** Every new route starts with `requireAuth` and
  filters by `ctx.orgIds`, like everything in `apps/api/src/routes/read.ts`.
- **No new GitHub writes.** All packages are read/projection/UI work; the single
  write ("nudge") reuses the existing user-token comment path.
- **Labels stay the state** (F-R3). Phases and groupings are pure functions over
  `factoryState`, defined once in `packages/core` and shared by API and web.

---

## WP1 · Blocked ownership, blocked metadata, and the Held fix

*Design §4.1 + §6.3 + the vanishing-card bug. No schema change. Ships alone.*

### 1a. `blockedSince` and `blockedQuestion` derivations

New helpers in `apps/api/src/routes/read.ts` (alongside `taskRollup`):

- `blockedSince(issueId)` — newest `issue_state_history` row with
  `toState = 'factory:blocked'` (`projectLabelEvent` already records these,
  `apps/worker/src/project.ts:164-185`). Falls back to `ghUpdatedAt` when
  history is empty (pre-Console issues that were reconciled in already blocked —
  the reconciler cannot recover label-event history).
- `blockedQuestion(issueId, since)` — newest `comments` row for the issue with
  `isAgent = true` and `ghCreatedAt >= since - 5min`; strip the
  `<!-- factory-agent -->` marker and markdown headings, return the first
  non-empty line, truncated ~140 chars. Both are cheap: blocked issues are few,
  and `comments_issue (issueId, ghCreatedAt)` and `ish_issue (issueId, occurredAt)`
  indexes already exist (`packages/db/src/schema.ts:177,199`).
- `stateBefore(issueId)` — newest history row whose `toState` is a non-blocked
  state; gives the stage the issue halted in, for approver routing below.

### 1b. Ownership routing in `/api/attention`

Rework the `factory:blocked` branch (`read.ts:121-133`):

1. Compute `owners`: issue assignees (after WP2; empty until then) → else issue
   `author` → else the approver list for `GATE_STATES[stateBefore].gate` (e.g. an
   issue blocked out of `factory:in-review` routes to the `implementation` list).
2. If `ctx.login ∈ owners`: emit with `rank: 1` and a specific `whyYou`
   (`"assigned to you"` / `"you filed it"` / `"you own the ${gate} list"`), plus
   new fields `blockedSinceDays` and `question`.
3. Otherwise emit today's broadcast entry with `rank: 4` and the existing wording.

Extend the entry DTO with `rank: 1|2|3|4` (gates = 2, task-start/merge = 3) and
sort by `(rank asc, ageDays desc)` instead of `ageDays` alone (`read.ts:183`).
`ageDays` for blocked entries switches from `ghUpdatedAt` (reset by any comment)
to `blockedSince`.

While in this function, fix the N+1: hoist the per-issue `gateAssignments` query
(`read.ts:138-141`) into one `inArray(estateId, …)` load before the loop, indexed
into `Map<estateId, Map<gate, Set<login>>>`.

### 1c. The Held column (web only)

`apps/web/src/pages/MissionControl.tsx`: after the `PIPELINE_ORDER` columns,
render one **Held** column containing open cards whose `state` is not in
`columns` — covers `factory:blocked`, `factory:fast-track`, `factory:incident`,
and `null`. Add the three short names to `STATE_SHORT` (L6-18) and reuse the
existing `.board-card.blocked` treatment. No API change: `/api/board` already
returns these cards; the client just never had a column for them.

### 1d. Attention row UI

`MissionControl.tsx` "What needs you" (L37-53): render `question` (italic,
quoted) under the title when present; visually mute `rank: 4` rows; strongest
badge weight on `rank: 1`. Update `AttentionEntry` in `apps/web/src/types.ts`.

**Tests.** API-level: seed history + agent comment fixtures, assert routing order,
`blockedSince` fallback, and that a rank-1 owner match beats an older rank-4 row
(new `apps/api/test/attention.test.ts`, patterned on `security.test.ts`'s app
bootstrap). Web behaviour (Held column) is covered by a snapshot of the column
partition function if extracted, else left to manual QA — do extract it:
`partitionCards(columns, cards)` as a pure function in `apps/web/src/lib/board.ts`.

---

## WP2 · Assignee ingestion — the "my issues" prerequisite

*Design §6.1. One migration, one interface field, one projection line.*

### 2a. Schema — migration `0002_assignees.sql`

```sql
ALTER TABLE issues ADD COLUMN assignees jsonb NOT NULL DEFAULT '[]';
CREATE INDEX issues_assignees_gin ON issues USING gin (assignees jsonb_path_ops);
```

Drizzle side (`packages/db/src/schema.ts`, issues table):
`assignees: jsonb("assignees").$type<string[]>().notNull().default([])`. The GIN
index makes `assignees @> '["login"]'` cheap; drizzle expresses it as
`sql`${issues.assignees} @> ${JSON.stringify([login])}``. Keep the migration
hand-written like `0001_app_config.sql` and register it in `migrations/meta/_journal.json`.

### 2b. Core + projection

- `GhIssue` (`packages/core/src/github.ts:141`) gains
  `assignees?: Array<{ login: string }> | null` — the REST issues payload always
  carries it; webhook `issues` payloads do too.
- `projectIssue` (`apps/worker/src/project.ts:119-154`): add
  `assignees: gh.assignees?.map(a => a.login) ?? []` to both the insert values
  and the `onConflictDoUpdate.set` block.

That is the whole ingestion story: `assigned`/`unassigned` webhook actions are
plain `issues` events already dispatched to `projectIssue`
(`apps/worker/src/ingest.ts:47-67`), the payload's bumped `updated_at` passes the
LWW guard, and the reconciler backfills every existing issue on its next walk via
`listIssues` (`reconcile.ts:49-58`) with no extra API calls. **"Responsible for"
everywhere in the API = `assignees ∪ author`, assignees ranking first.**

**Tests.** Extend `apps/worker/test/projection.test.ts`: assignees projected on
insert, replaced on update, stale delivery (older `updated_at`) does not clobber;
`GhIssue` fixture builders gain the field.

---

## WP3 · Task dependency projection

*Design §6.2. The real modelling work; unlocks "waiting on others", the peek
dependency strip, Q&A neighbourhood, and the epic Tasks-tab edges.*

### 3a. Schema — migration `0003_task_dependencies.sql`

```sql
CREATE TABLE task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  blocked_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocker_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source text NOT NULL,              -- 'github' | 'body'
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocked_issue_id, blocker_issue_id)
);
CREATE INDEX task_deps_blocker ON task_dependencies (blocker_issue_id);
CREATE INDEX task_deps_org ON task_dependencies (org_id);
```

Both directions of the design's queries are covered: "what blocks me" via the
unique key's leading column, "whom do I block" via `task_deps_blocker`.

### 3b. Two sources, one repair discipline

**Source 1 — GitHub's native issue-dependency relations (authoritative).**
Mirror the sub-issues pattern exactly (`RepoReader.listSubIssues`,
`packages/core/src/github.ts:312-319`): add

```ts
async listBlockedBy(owner, repo, num): Promise<GhIssue[]>   // GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by
```

with 404/410/403 tolerated as `[]`, so estates on plans or API versions without
dependencies degrade silently. Resolve returned issues to rows **by `node_id`**
(`issues.ghNodeId` is globally unique, `schema.ts:157`), which makes cross-repo
dependencies work for free — exactly what FACTORY.md §7's cross-repo merge order
needs. A returned issue not yet projected (sibling repo not walked yet) is
skipped; the next reconcile pass converges.

**Source 2 — body markers (fallback, same-repo).** The Planner's task bodies
carry ordering hints. In `projectIssue`, parse alongside `parentNumberFromBody`
(`project.ts:88-93`):

```ts
function blockerNumbersFromBody(body: string | null): number[]
// matches, case-insensitive, one per line: "blocked by #12", "depends on #12, #13", "after #12"
```

resolved against `(repoId, number)` like the parent lookup.

**Repair function** `repairDependencies(db, repo, reader)` in
`apps/worker/src/artifacts.ts`, called from `reconcileEstate` right after
`repairSubIssueLinks` (`reconcile.ts:82`): for each task/epic issue with a
factory state, fetch native relations; per issue, delete-then-insert its
`source='github'` rows (the `importGateAssignments` discipline, `artifacts.ts:152`)
so removed dependencies disappear. Body-derived rows are refreshed by
`projectIssue` itself (delete `source='body'` rows for the issue, insert current
matches) — and **`source='github'` wins**: a body row is only inserted when no
github-sourced row exists for the same pair (the unique key plus insert order
enforces this: repair github rows first in reconcile; in `projectIssue` use
`onConflictDoNothing`).

**Webhook path:** dependency edits do not arrive as a reliably-documented event,
so freshness comes from (a) `projectIssue` body parsing on every issue event, and
(b) an on-demand `repairDependencies` for the epic's repo when the epic workspace
loads stale — but (b) is an optimisation; v1 relies on reconcile like gate
assignments already do.

### 3c. Read surface

- `taskRollup` (`read.ts:534`) additionally returns
  `waiting: number` (open tasks having an open blocker).
- `/api/epics/:id` tasks array (`read.ts:292-299`) gains
  `blockedBy: Array<{ id, number, title, state, open }>` and `blocks: […]`,
  loaded in two `inArray` queries — this is F-W6's missing edge data, and the
  epic Tasks tab renders it as chips on task cards (`apps/web/src/pages/EpicWorkspace.tsx`,
  Tasks tab) ahead of any full graph drawing.

**Tests.** `projection.test.ts`: body parse variants (multi-number, "after",
case, absent); github-beats-body precedence; delete-then-insert removes dropped
edges; cross-repo resolution by node_id. Core test for the new regex if extracted
to `packages/core` (it should be, next to `derivePrKind`).

---

## WP4 · `/api/my-work` + the My work view

*Design §4.1–4.4. Depends on WP1 (ranking), WP2 (mine), WP3 (waiting-on).*

### 4a. Shared vocabulary in `packages/core`

New `packages/core/src/phases.ts` (exported from the package index):

```ts
export type Phase = "specifying" | "planning" | "building" | "shipping" | "held";
export const PHASE_OF_STATE: Record<string, Phase>;         // §4.2 table; null/off-rail → "held"
export const PHASE_LABELS: Record<Phase, string>;           // "Being specified", …
export const STATE_SENTENCE: Record<string, string>;        // peek line 1 templates, with
                                                            // {approvers} {gate} {days} slots
export const NEXT_MOVER: Record<string, string>;            // FACTORY.md §3 "Advanced by", one line
```

Pure data + total functions (every `factory:*` state maps; unknown → `held`), so
API and web cannot drift. Unit-tested for totality against `FACTORY_LABELS`.

### 4b. The endpoint

`GET /api/my-work` in a new `apps/api/src/routes/mywork.ts` (registered in
`apps/api/src/app.ts` beside the others), one round trip returning:

```ts
{
  needsYou: AttentionEntry[];              // WP1's re-ranked list, verbatim
  mine: Array<{                            // assignee ∪ author, open, factory-labelled
    issueId, epicId, number, title, repo, kind,
    state, phase, whyMine: "assigned" | "author",
    freshness: { lastMovedAt, quietDays }, // from newest issue_state_history row
    rollup?, blocked: boolean
  }>;
  waitingOn: Array<{                       // my open issues with open blockers
    issueId, number, title,                // …the waiting issue
    blocker: { issueId, epicId, number, title, repo, state, phase,
               assignees, ageDays, htmlUrl }
  }>;
}
```

Queries: `mine` is one indexed select
(`assignees @> [login] OR author = login`, `state='open'`, `factoryState is not null`,
org-scoped); `waitingOn` is `task_dependencies` joined twice to `issues`, filtered
to my side via the same predicate (including tasks whose *parent epic* is mine —
one extra `inArray(parentIssueId, myEpicIds)` term); attention is the WP1
function extracted so `/api/attention` and `/api/my-work` share it. Everything
batched — no per-row queries (the WP1 N+1 fix set the standard).

### 4c. The peek endpoint

`GET /api/issues/:id/peek` (same file) — the §4.4 payload:

```ts
{ issue: { number, title, repo, state, phase, htmlUrl, assignees, author },
  sentence,                       // STATE_SENTENCE filled with gate approvers etc.
  nextMover,                      // NEXT_MOVER[state]
  deps: { blockedBy: DepNode[], blocks: DepNode[] },   // one hop, with state + open
  lastEvent: { at, detail, actor } | null,             // newest history row or run, not comments
  blocked: { since, question } | null,                 // WP1 helpers
  epicId }                        // for "Open workspace" and tab deep-links
```

Org-scoped like `loadEpic` but for any issue row (new `loadIssue` helper beside
it, `read.ts:519`).

### 4d. Web

- **`apps/web/src/pages/MyWork.tsx`** — the three sections, in design §4.1–4.3's
  fixed order. Mission Control becomes: My work sections on top; the board and
  estate health move behind a "Factory" tab on the same page (cheapest honest
  version of "demoted", keeps one route). Sidebar label stays "Mission control"
  (`apps/web/src/App.tsx:54-59`).
- **`apps/web/src/components/IssuePeek.tsx`** — drawer rendering the peek payload:
  sentence, next-mover line, dependency strip (`#38 ✓ → #41 ● → #44 ○`, each node
  a button that re-peeks), last event, blocked reply box (reusing the Blocked
  page's reply mutation, `POST /api/issues/:id/reply`), Ask panel placeholder
  until WP5, actions row (Open workspace / `[≡ raw]`). Opened by row click from
  any of the three sections *and* from board cards (same disclosure model
  everywhere, design §7).
- **Nudge** in `waitingOn` rows: a one-field form posting to the *blocker's*
  `POST /api/issues/:id/reply` (`apps/api/src/routes/write.ts:104` — already
  org-scoped, user-token, audited; drop its current restriction to
  `factory:blocked` issues by allowing any open factory issue, keeping the audit
  action distinct: `issue.nudge`).
- `types.ts`: `MyWorkResponse`, `PeekResponse`, `DepNode`; five phase chip styles
  in `styles.css` (quiet), keeping the loud treatments for §4.1 ranks only.

**Tests.** `apps/api/test/mywork.test.ts`: scoping (member of org A never sees
org B rows — mirror `security.test.ts` patterns), `mine` predicate
(assignee-only, author-only, both), `waitingOn` includes tasks under my epic,
peek 404s cross-org. Phase totality test in `packages/core/test/phases.test.ts`.

---

## WP5 · Issue-scoped Ask (Q&A over the dependency neighbourhood)

*Design §5. Depends on WP3; touches nothing in `packages/insight`.*

### 5a. Schema — migration `0004_qa_scope.sql`

```sql
ALTER TABLE qa_conversations ADD COLUMN scope_issue_id uuid REFERENCES issues(id) ON DELETE CASCADE;
CREATE INDEX qa_conversations_scope ON qa_conversations (scope_issue_id);
```

`null` = epic-scoped (today's rows unchanged). `epicIssueId` stays required and
is set to the scope issue's epic (or itself), so budget accounting, listing, and
the existing epic panel keep working untouched.

### 5b. Routes

In `apps/api/src/routes/qa.ts`:

- Extract today's context assembly into `assembleEpicContext` (rename of
  `assembleContext`) and add `assembleIssueContext(deps, ctx, issue)`:
  1. the focus issue: body + last 30 comments (from the `comments` projection);
  2. **each 1-hop neighbour** from `task_dependencies` (both directions, open or
     closed): body, `factoryState`, last 10 comments, and its PRs by
     `issueNumber` — each neighbour one `InsightSource` with
     `ref: "issue:#<n>"` so citations point at the right thing;
  3. the parent epic's `design.md` + `tasks.md` from `artifactCache` at
     `latestSha ?? mergedSha` (reusing the decrypt path);
  4. the same runs tail as today.
  Existing per-source truncation in `packages/insight` (12 000 chars) already
  bounds it; cap neighbours at 8 by `ghUpdatedAt` desc and say so in a final
  synthetic source line ("2 more dependencies omitted") — the no-silent-caps rule.
- `GET/POST /api/issues/:id/qa` — same handler pair as the epic routes with
  `loadIssue` + `scope_issue_id`; same budget check, same private-by-default,
  same token accounting.

### 5c. Web

`apps/web/src/pages/QaPanel.tsx` takes `scope: { kind: "epic" | "issue"; id }`,
derives its endpoints from it, and swaps canned questions for issue scope
(*"Why is this blocked?" / "What has to happen before this moves?" / "Summarise
the blocker's current state." / "Who is expected to act next?"*). `IssuePeek`
mounts it under the reply box; `EpicWorkspace.tsx:118` passes the epic scope and
is otherwise untouched.

**Tests.** Context assembly unit test with seeded deps (neighbour inclusion, cap
+ omission note, citation refs); route test for budget 429 and scope privacy.

---

## WP6 · The manager / scrum-master tree

*Design §7. Depends on WP1–WP3; milestone data needs one more projection column.*

### 6a. Schema — migration `0005_milestones.sql`

```sql
ALTER TABLE issues ADD COLUMN milestone_title text;
ALTER TABLE issues ADD COLUMN milestone_number integer;
CREATE INDEX issues_org_milestone ON issues (org_id, milestone_title);
```

`GhIssue` gains `milestone?: { number: number; title: string } | null`;
`projectIssue` maps both fields (insert + update set). Webhook `issues` events
with action `milestoned`/`demilestoned` are already dispatched to `projectIssue`;
the reconciler backfills. Release trackers are recognised as they are today —
the `factory:release` label in `labels` — and matched to their milestone by
`milestone_title` (the tracker itself carries the milestone).

### 6b. `GET /api/flow`

New route (in `mywork.ts` or its own `flow.ts`): the whole tree in one payload,
grouped `estate → milestone → epic → task`:

```ts
{ estates: [{ id, name, milestones: [{
    title, trackerState,                    // factory:release-* or null
    epics: [{ epicId, number, title, repo, state, phase, daysInState,
              rollup: { …taskRollup, waiting },   // WP3 rollup
              gate: { label, approvers } | null,  // who it waits on, from gate_assignments
              blockedCount,
              tasks: [{ issueId, number, title, state, phase, assignees,
                        ageDays, blockedBy: number[] }] }],
  }],                                       // + a final "No release" pseudo-milestone
}] }
```

Built from four batched queries (issues, history-latest per issue via a lateral
or window query, rollups computed in one pass over the task rows,
gate_assignments) — explicitly *not* the board's per-epic N+1. `daysInState`
logic lifts out of `/api/board` (`read.ts:200-217`) into a shared helper that
takes the pre-fetched history rows.

Flow flags, phase-2 of this WP: per-state median dwell from `issue_state_history`
(one grouped query), `stale: daysInState > 2 × median`, and gate-latency /
blocked-dwell aggregates (F-X3) as a summary strip.

### 6c. Web

- **`apps/web/src/pages/Flow.tsx`** at route `/flow`, sidebar entry "Flow"
  (`App.tsx` sidebar + routes) — collapsible tree per design §7's sketch,
  `IssuePeek` on every node, milestone rows showing tracker state + epic phase
  counts, epic rows showing rollup + "waits on G2: @jerry, @sam".
- **Tree ⇄ board toggle** on the same page: the board component extracts from
  `MissionControl.tsx` into `components/PipelineBoard.tsx`, gaining estate
  swim-lanes (group cards by `estateId` — the field already arrives, design §7)
  and the WP1 Held column. Mission Control's "Factory" tab embeds the same
  component, so the board exists once.

**Tests.** Flow endpoint scoping + grouping (milestone-less issues land in
"No release"; closed epics excluded by default), rollup math shared-helper tests.

---

## Sequencing, sizing, and risk

| Order | Package | Size | Risk to watch |
|---|---|---|---|
| 1 | WP1 blocked ownership + Held | S | wording of `whyYou` variants; history-less blocked issues fall back gracefully |
| 2 | WP2 assignees | S | none — additive column, LWW-guarded |
| 3 | WP3 dependencies | M | native dependencies API availability per plan/version — the 404-tolerant client makes absence a silent degrade to body markers; watch reconcile API-call growth (one extra call per factory issue) |
| 4 | WP4 my-work + peek | M | the one UX-heavy package; keep the board untouched behind its tab until this settles |
| 5 | WP5 issue-scoped ask | S–M | context size — capped neighbours + existing truncation bound it; budget spend unchanged mechanically |
| 6 | WP6 flow tree | M | query shape (windowed latest-history) — do it batched from day one |

Migrations land strictly in order `0002 → 0005`; each is independently
deployable ahead of its consumer code (all additive, all defaulted). After each
package: `pnpm test`, `pnpm typecheck`, `pnpm build`, plus a reconcile against a
live estate to confirm the new projection repairs from zero (truncate the new
table/columns, reconcile, diff).

What is deliberately **not** in this plan: notifications (the unused table stays
unused — F-W24 is its own feature), RBAC-based view defaults (both views stay
org-scoped lenses until F-U8), `tasks.md`-inferred dependencies (design §6.2
source 3 — only if the two real sources prove too sparse in practice), and any
GitHub write beyond the existing user-token comment.
