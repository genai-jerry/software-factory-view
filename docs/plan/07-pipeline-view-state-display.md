# 07 · Pipeline view: displaying issue state without drowning the individual

**Status:** research + proposed design (no code yet).
**Scope:** how Mission Control presents the state of issues — redesigned around the
*individual* first, with a separate tree-shaped view for managers / scrum masters.

---

## 1. The problem

Mission Control today (`apps/web/src/pages/MissionControl.tsx`) shows three things:
the attention queue ("What needs you"), a Kanban-style pipeline board of every epic
in every estate, and the estate-health strip. This is a *whole-factory* lens. It
answers "where is everything?" but an individual opening the Console actually asks
four narrower questions, in this order:

1. **What is stuck on me right now?** (the factory is literally halted waiting for
   my reply, approval, or merge)
2. **Where are *my* issues?** (the things I filed, own, or approved into flight)
3. **What am I waiting on?** (which dependency is holding my issue, and who/what
   can move it)
4. **Can I ask about it without reading five documents?** (question the blocked
   issue and its dependencies directly)

The board answers none of these without scanning. Worse, the current implementation
has structural gaps that make the *state* display actively misleading:

- Epics whose state is off the rail (`factory:blocked`, `factory:fast-track`,
  `factory:incident`) or `null` **render in no column at all** — they vanish,
  because the board maps cards onto `PIPELINE_ORDER` only
  (`packages/core/src/factory.ts:33`, `MissionControl.tsx:55-90`).
- `factory:blocked` entries in the attention queue are shown to **every member of
  the org** with the same "any member may reply" line (`apps/api/src/routes/read.ts:121-133`)
  — nobody feels responsible, which is the known failure mode of broadcast queues.
- No card or row anywhere shows a *person*. Assignees are not ingested (no column
  on `issues`, never requested from GitHub), so "the issues I am responsible for"
  is currently unanswerable.
- Task-to-task dependency edges ("blocked by #123") are not modelled — only
  parent→child exists — so "what am I waiting on" is also unanswerable, even
  though FACTORY.md §7 makes merge order dependency-driven and the plan promises
  the graph (F-R8, F-W6).

## 2. What the research says

Patterns from tools that solved exactly this problem, and the lesson each one
carries for the Console:

| Pattern | Source | Lesson |
|---|---|---|
| **"My Issues" as a filter, not a new model** | Linear | The personal view is an opinionated query over the same projections — assigned / created / subscribed — one click from anywhere. No new source of truth. |
| **A "reason" chip on every row** | GitHub notifications inbox | Every entry must answer *"why am I seeing this?"* inline. The Console's attention queue already has `whyYou` — keep it, extend it to the new reasons (assignee, author, dependency). |
| **Sections ordered by whose move it is** | Graphite PR inbox | Top-level grouping is *ball-in-whose-court*, never workflow stage. Stage is a secondary chip on the row. "Needs your review" sits above "waiting on review" — always. |
| **Three levels of disclosure** | Asana My Tasks, Todoist | Collapsed one-line row → in-place peek (one click) → full workspace (second click). The scan stays cheap; depth is opt-in. |
| **Never interleave action with FYI** | Atlassian's "Your work", notification-fatigue research | Mixed feeds get ignored. "Action required" and "informational" must be visually separate sections, not sorted together. |
| **Boards are team instruments** | Kanban literature | Individuals with < ~10 live items experience a board as a wall of cards; a queue/list is faster to scan. Keep the board for the flow view (manager), give individuals a list. |
| **Order by blockage, then staleness** | Email-triage research (SNARF) | Rank by "is something halted because of this" first, age-in-state second. Chronological ordering buries the urgent under the recent. |
| **Scoped, cited Q&A** | The Console's own "Ask the Factory" | Grounded-only, citations mandatory, corpus bounded to the entity in focus. Extend the corpus from *epic* to *issue + its 1-hop dependency neighbourhood* and the same guarantees answer dependency questions. |

Anti-patterns to hold the line against: badge soup (more than ~3 chips per row and
scanning collapses), duplicating GitHub's own @-mention notifications (plan policy
already forbids it, F-W24), and hiding the substrate (every row keeps its
`[≡ raw]` deep link — trust rule F-W2).

## 3. Design principles

1. **Ball-in-whose-court is the primary grouping.** State labels describe the
   *pipeline*; the individual cares about *turn-taking*. Every issue in a user's
   view falls into exactly one of: *needs you* / *agents are on it* / *waiting on
   someone or something else*.
2. **Specific first, complete on demand.** A row shows at most: title, one reason
   chip, one state chip, age. Everything else is one click deeper (peek), and the
   full epic workspace is one more.
3. **The label is still the state.** No Console-invented states (invariant F-R3).
   The personal view only *re-groups and re-words* the existing label machine.
4. **Every "why" is nameable.** A row never appears without a machine-derived
   reason the UI can print: *you are on the `spec` approver list*, *assigned to
   you*, *your task #41 is blocked by #38*, *you filed it*.
5. **Individuals get a queue, flow-watchers get a tree.** Two views, two
   audiences, zero mixing on one screen.

## 4. Proposed design — "My work" (the individual view)

A new default landing section on Mission Control (or a `/my-work` route with the
current board demoted below it / moved behind a tab). Three strictly separated
sections, in fixed order:

### 4.1 · Needs you — the factory is stopped on you

The existing attention queue, kept as the top of the page, with sharper
personalisation and re-ranked:

| Rank | Entry | Why it's yours |
|---|---|---|
| 1 | `factory:blocked` issue **you are the best responder for** | assignee, else author, else gate approver of the stage it blocked in — see §6.1 |
| 2 | Gate awaiting you (`spec-ready`/`design-ready`/`ready-to-ship`) | on the gate's approver list (`gate_assignments`) — unchanged |
| 3 | Task awaiting an implementation `Approved` | on the `implementation` list — unchanged |
| 4 | `factory:blocked` in your estate, unowned | today's broadcast entry, demoted to the bottom and visually muted, so ownership signals always outrank broadcast |

Within a rank: age-in-state descending, and rank 1–3 entries carry an "agent
halted" treatment (the strongest visual weight on the page) because a stopped
agent is pure dead time — the strongest claim on attention the factory can make.

Row anatomy (one line): `#(number) title` · reason chip · state chip · `3d`.
Empty state stays as-is: "Nothing is waiting on you. The factory is running."

### 4.2 · Yours, in flight — where your issues are

Issues where the user is assignee or author, grouped not by the 11-column label
machine but by **five plain-language phases** that compress it:

| Phase shown | Labels it covers | One-line explainer on the chip's tooltip |
|---|---|---|
| **Being specified** | `intake`, `spec-ready` | "An agent is writing the spec" / "spec awaits gate G1" |
| **Being planned** | `spec-approved`, `planned`, `design-ready` | planner/architect at work, or design awaits G2 |
| **Being built** | `design-approved`, `ready`, `in-review`, `in-test` | tasks executing; rollup shows n/m |
| **Shipping** | `ready-to-ship`, `deployed` | awaiting merges / soaking |
| **Held** | `factory:blocked`, `factory:incident`, `backlog` | needs a human / regression / not yet released |

Eleven columns is the *factory's* resolution; five phases is the *requester's*.
The full label is always one hover away (tooltip = `FACTORY_LABELS` description,
`packages/core/src/factory.ts:7-22`) and one click away (peek → stage rail).
Rows here are calm — no badges screaming, because by construction nothing in this
section needs the user (it would be in §4.1). A quiet "moved yesterday" /
"quiet for 6d" freshness note replaces the board's `Nd in state` arithmetic.
**Held** rows are the exception — they render with the blocked treatment, which
also fixes today's vanishing-card bug by giving off-rail states a home.

### 4.3 · Waiting on others — your dependencies

The section that does not exist today anywhere in the product. For each of the
user's issues (or tasks of their epics) that cannot move:

> **#41 task(api): rate-limit headers** — blocked by **#38 task(db): quota
> schema** *(in review · @sam · 2d)* — `[Ask about this]` `[Nudge]`

One row per blocked-edge, naming the *specific* blocker, its state, its human
(assignee or gate owner), and its age. This is the "who do I chase" view, and it
requires the dependency edges of §6.2. `[Nudge]` posts an ordinary GitHub
comment on the blocker thread as the user (same write path as the blocked-inbox
reply, `apps/api/src/routes/write.ts:104` — no new write primitives).

### 4.4 · Progressive disclosure: row → peek → workspace

Clicking a row anywhere in §4.1–4.3 opens an in-place **peek panel** (drawer),
not a navigation. The peek shows, in order:

1. **State, in a sentence.** Template per label, e.g. *"Design PR open since
   Tue, awaiting gate G2 — approvers: @jerry, @sam."* Derived from
   `factoryState` + `GATE_STATES` + `gate_assignments`; no free text.
2. **What happens next, and who moves it.** The "Advanced by" column of
   FACTORY.md §3, rendered as one line.
3. **Mini dependency strip** (tasks only): `#38 ✓ → #41 ● → #44 ○` — done /
   this / waiting-on-this. Click any node to re-peek it.
4. **Last meaningful event** from the timeline (state flip or run, not comments).
5. **Ask panel** (§5) pre-scoped to this issue.
6. Actions: **Open workspace** (deep-links to the right tab, reusing the
   attention queue's `?tab=` links), **Reply** (if blocked), `[≡ raw]`.

The peek is the answer to "give specific info and allow the user to dig deeper":
the row is the headline, the peek is the paragraph, the workspace is the article.

## 5. Asking questions about a blocked issue and its dependencies

"Ask the Factory" already gives grounded, cited, budgeted Q&A — but scoped to one
epic and surfaced only inside the epic workspace (`apps/api/src/routes/qa.ts:140-238`,
`apps/web/src/pages/QaPanel.tsx`). Two extensions, no new machinery:

1. **Issue-scoped corpus.** When invoked from a peek, `assembleContext` is
   assembled around the *focus issue*: its body and comments; its change-folder
   artifacts; **plus the 1-hop dependency neighbourhood** — each blocker's and
   dependent's body, state, latest comments, and PR; plus the parent epic's
   `design.md`/`tasks.md`. Bounded (12 000 chars/source, same truncation as
   `packages/insight/src/index.ts:51`), cited, and read-only exactly as today.
   This directly answers *"why is #41 blocked and what is #38 waiting for?"* with
   citations into #38's thread — without the user ever opening #38.
2. **Same entry point everywhere.** The peek's ask panel and the epic workspace's
   QaPanel are the same component with a different scope parameter
   (`epic:<id>` today, `issue:<id>+deps` new). Canned prompts for the issue
   scope: *"Why is this blocked?"*, *"What has to happen before this moves?"*,
   *"Summarise the blocker's current state."*, *"Who is expected to act next?"*

Budget, privacy (`qaConversations.userId`), and the advisory-only system prompt
are unchanged. The blocked-inbox reply box sits next to the ask panel in the
peek, so the natural flow is *ask → understand → reply/unblock* on one screen.

## 6. Data the design needs (the honest cost)

The individual view is a query over projections — but two projections are missing.

### 6.1 · Assignees (small)

Add `assignees jsonb` (logins) to `issues`; request assignees in the issue fetch
(`packages/core/src/github.ts`) and map them in `projectIssue`
(`apps/worker/src/project.ts:119`); backfill via the reconciler. "Responsible
for" = assignee ∪ author, with assignee winning for §4.1 rank-1 routing.
Where the factory itself never sets assignees, author + gate lists degrade
gracefully — the sections still populate, only "assigned to you" chips are absent.

### 6.2 · Dependency edges (the real work)

A `task_dependencies` table `(orgId, blockedIssueId, blocksIssueId, source, syncedAt)`
projected from, in order of authority:

1. GitHub's native "blocked by" issue relationships where available (mirrors how
   `repairSubIssueLinks` treats the sub-issues API as authoritative,
   `apps/worker/src/artifacts.ts:211`);
2. `blocked by #n` / `depends on #n` lines in task-issue bodies (the Planner
   already emits these — same regex-with-repair approach as
   `parentNumberFromBody`, `apps/worker/src/project.ts:87`);
3. the checklist ordering in `tasks.md` as a weak fallback, marked `source:'inferred'`.

This unlocks §4.3, the peek's dependency strip, the Q&A neighbourhood, F-R8's
promised rollup graph, and the epic workspace Tasks tab's missing edges — one
projection, five consumers.

### 6.3 · Blocked metadata (cheap, high value)

`blocked_since` (from the `labeled` event for `factory:blocked`, which
`issue_state_history` already records — today's `ageDays` uses `ghUpdatedAt`,
which any comment resets, `read.ts:117`) and `blocked_question` (first line of
the agent's `<!-- factory-agent -->` comment that applied the label). The §4.1
row can then show *the actual question the agent is stuck on* instead of the
generic "needs human attention".

### 6.4 · API sketch

- `GET /api/my-work` → `{ needsYou: AttentionEntry[] (re-ranked, with ownerReason),
  mine: IssueRow[] (grouped by phase), waitingOn: DependencyRow[] }` — one
  endpoint, one round trip, built from the same org-scoped queries as
  `/api/attention` (and fixing its per-issue `gate_assignments` N+1 while there).
- `GET /api/issues/:id/peek` → the §4.4 payload.
- `POST /api/issues/:id/qa` → issue-scoped Q&A (mirrors `POST /api/epics/:id/qa`).

## 7. The manager / scrum-master view — a separate tree

A distinct route (`/flow` or `/releases`), explicitly *not* the individual's
landing page, shaped as a collapsible tree from the milestone down — matching how
the factory itself is structured (§2d release trackers → epics → task sub-issues):

```
▼ Milestone: 2026.09 “Quota & billing”      release: G0 approved · 3 epics
  ▼ #12 [Req] Usage quotas                  building · 4/9 tasks · 1 blocked ⚠
      #38 task(db): quota schema            in review · @sam · 2d
      #41 task(api): rate-limit headers     held: blocked by #38
      #44 task(web): usage banner           ready · unassigned
  ▶ #17 [Req] Billing export                shipping · G3: 2 merges awaiting @jerry
  ▶ #23 [Req] Admin overrides               being specified · intake 5d ⚠stale
```

- **Every node rolls up its children**: epic rows show phase, task rollup
  (`taskRollup`, `read.ts:534` — already built), blocked count, and *which gate
  and which human* the epic waits on. Milestone rows show epic counts by phase
  and the release tracker's own `factory:release-*` state.
- **The flow signals live here, not on the individual view**: days-in-state,
  gate-latency and blocked-dwell flags (the F-X3 metrics), WIP per stage, and a
  per-stage staleness marker when an issue exceeds ~2× the stage's median dwell.
- **Issues outside any milestone** collapse under a final "No release" node, so
  the tree is total (release gating off = one big node; the view degrades to
  epic→task, still useful).
- The existing Kanban board remains available as an alternate *lens* on this
  same page (tree ⇄ board toggle) — column view is genuinely right for spotting
  stage pile-ups, which is a manager question. Adding the estate swim-lanes the
  plan already promised (F-M2) happens here, and off-rail states get a visible
  "Held" column so nothing vanishes.
- Same peek panel (§4.4) on every node — the disclosure model is shared; only
  the top-level organisation differs per audience.

No RBAC is required to ship this: the two views are *lenses*, both org-scoped
reads. When estate scoping / roles arrive (F-U8), the tree simply becomes the
view managers land on.

## 8. What this is *not*

- Not a new state machine — every grouping above is a pure function of the
  existing labels, `gate_assignments`, and the two new projections.
- Not a notification system — F-W24 remains separate; this is what you see when
  you *choose* to look.
- Not a rename of the labels — agents and FACTORY.md keep the exact vocabulary;
  only the individual's grouping layer compresses it to five phases.

## 9. Phasing

| Step | Ships | Depends on |
|---|---|---|
| 1 | Re-ranked "Needs you" + blocked-ownership routing + blocked_since/question; off-rail "Held" fix on the board | nothing new (history + gate_assignments + comment scan) |
| 2 | Assignee ingestion → "Yours, in flight" with five-phase grouping + peek panel (without dependency strip) | §6.1 |
| 3 | Dependency projection → "Waiting on others", peek dependency strip, Tasks-tab graph edges | §6.2 |
| 4 | Issue-scoped Ask (peek Q&A over the dependency neighbourhood) | §6.2 + existing insight package |
| 5 | Manager tree view with rollups and flow flags; board becomes a toggle lens with estate swim-lanes | steps 1–3 |

Steps 1 and 2 alone already answer the two questions users ask first — *what's
stuck on me* and *where are my things* — which is why they go first.
