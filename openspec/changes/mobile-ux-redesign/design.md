## Context

See `proposal.md` for why. This document records the audit that produced the specs, then the implementation approach.

The Console is a React 18 + Vite SPA (`apps/web`) with one CSS file (`styles.css`), no component library, and a tokenized light/dark/system palette. Routes: `/` Mission control (My work + Factory tabs), `/flow`, `/blocked`, `/decisions`, `/epics/:id`, `/onboarding`, `/settings`, `/runs/:runId`. Chrome is a **fixed 220px sidebar** (`.layout { display: flex }`, `.sidebar { width: 220px; flex-shrink: 0 }`). Responsive CSS exists only for the home ticket and the engine-card grid at `max-width: 640px`. The epic workspace forces `grid-template-columns: minmax(0,1fr) 340px`. The pipeline board is `min-width: 210px` columns. Buttons pad `0.4rem 0.9rem` (~14×32px). There is no `focus-visible`, no skip link, almost no ARIA, no `prefers-reduced-motion`, no `safe-area-inset`. Plan 07 already fixed *information* architecture (My work vs Flow) but not *visual* or *mobile* architecture.

**Standards used in the audit** (not slogans — the scoring below is against these):

| Standard | What we scored |
|---|---|
| ISO 9241-11:2018 | Effectiveness, efficiency, satisfaction for specified users in specified contexts (desk, tablet, phone) |
| ISO 9241-110:2020 | Suitability for the task, self-descriptiveness, controllability, conformity with expectations, error tolerance, individualisation, learnability |
| Nielsen's 10 heuristics | Expert inspection of every primary route |
| WCAG 2.2 Level AA | Perceivable / Operable / Understandable / Robust; 2.5.8 Target Size (Minimum) 24×24; 2.4.11 Focus Not Obscured; 3.3.7 Accessible Authentication is N/A (GitHub OAuth) |
| Apple HIG + Material 3 | 44pt / 48dp targets, 8px separation, thumb reach |
| NN/G mobile + dashboard guidance | Do not scale a desktop grid down; stack; progressive disclosure; one primary job |

Plan 07's research (Linear "My Issues", Graphite ball-in-court, Asana peek, SNARF ranking) is adopted, not replaced.

### Heuristic scores (current Console)

Severity: 0 none · 1 cosmetic · 2 minor · 3 major (task delayed) · 4 blocker (task fails). Scores are the *worst* instance found.

| # | Heuristic | Score | Evidence |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Stale/webhook banners exist, but they speak operator jargon ("worker", "Redis"). Loading is the word "Loading…". Orchestrator-not-started is a dense paragraph. No live "posting…" on every write. |
| 2 | Match to the real world | 4 | Home, board, workspace, and badges speak factory internals: `factory:spec-ready`, G1/G2/G3, `≡ raw`, estate, change folder, PEM. A requester asks "can I ship?" not "am I in `ready-to-ship`". |
| 3 | User control and freedom | 3 | Peek overlay has no Escape handler or focus trap. Approve has no undo (by factory design — mitigate with confirm). Sidebar has no way to collapse. Front door remount used to wipe a pasted PEM (fixed on `main`; keep the "first settle only" rule). |
| 4 | Consistency and standards | 3 | Mix of `<a href="#peek">`, `role="button"` cards, and `<Link>`. Settings used to be in the nav for everyone; `main` hides it behind `canEditApp` but org settings then become unreachable for org admins who are not the App owner. Inline `style={{}}` fights the token system. |
| 5 | Error prevention | 2 | Open-questions ack on Approve is exemplary. Reset App credentials confirms. Onboarding Reset sits next to setup actions with a smaller confirm. Touch targets invite mis-taps. |
| 6 | Recognition rather than recall | 2 | `whyYou` on attention rows is the product's best pattern. Stage rail still requires memorising 11 labels. Filter "Focus" is unexplained. |
| 7 | Flexibility and efficiency | 4 | No keyboard shortcuts, no command palette, no mobile path. Canned Q&A is the one accelerator. Hover-only tooltips (if any) die on touch. |
| 8 | Aesthetic and minimalist | 3 | Dark-first tokens are restrained. Density and stacked banners bury the action. Thirteen board columns and six workspace tabs compete. System font stack is anonymous. |
| 9 | Error diagnosis and recovery | 3 | API errors surface `ApiError.message`. Webhook banners tell the user to open GitHub App settings. Members cannot act on those instructions. |
| 10 | Help and documentation | 4 | No in-app help. README is for the person running the host. Gate "Approve" does not explain that it posts the word `Approved` until after success. |

**WCAG 2.2 AA (spot check against code, not a certified audit)**

- Fail 1.4.3 / 1.4.11 until contrast is measured on every badge-on-panel pair (purple-on-dark is close).
- Fail 2.1.1: peek overlay is mouse-oriented; tree carets handle Enter only, not Space.
- Fail 2.4.1: no skip link.
- Fail 2.4.7: no `:focus-visible` rule.
- Fail 2.5.8: nav links pad `0.4rem 0.6rem`; rank badges and `✕` close are well under 24×24.
- Fail 4.1.2: icon buttons (`✕`, theme `◐`, `≡ raw`) lack accessible names; avatar `alt=""`.
- Pass-ish 1.3.1: real headings exist; not wired as landmarks.
- N/A 3.3.8: authentication is GitHub OAuth (no password fields in-app) except PEM paste on first run.

### ISO 9241-11 by persona and context

Roles today (F-U4 is skeleton): **GitHub identity is the account**. Console org role is `owner` / `admin` / `member` (viewer not built). Gate authority is **assignment**, not role. Distinct jobs:

| Persona | Primary jobs | Desk (1280) | Phone (360) today |
|---|---|---|---|
| **Requester / member** | What is stuck on me? Where is my issue? Reply when blocked | My work works | Sidebar eats the width; rows don't wrap as cards; peek is a side drawer on a 360px screen |
| **Spec/design approver** | Read artefact, see what changed, Approve | Gate tab is the product | Workspace 1fr+340px overflows; stage rail wraps into noise; Approve is a mid-page button under long markdown |
| **Release manager** | Merge order at G3 | Release card + per-PR merge | Merge buttons collide with wrapped `spread` rows |
| **Flow watcher** (manager / SM) | Tree of milestones → epics → tasks | `/flow` tree | Tree metadata overflows; board lens is unusable |
| **Org owner / admin** | Connect org, enable factory, secrets, insight key | Onboarding + Settings | Onboarding is a long vertical form (survivable) but targets and PEM fields are hostile; Settings is hidden if they are not the App owner |
| **First-run operator** | Paste GitHub App credentials | Home ticket | Ticket has a 640px tweak; PEM textarea and "technical details" dominate |
| **Blocked responder** | Answer the agent | `/blocked` or peek | Reachable in theory; sidebar + tiny Reply |
| **Viewer** (planned) | Read-only | Not built | Not built |

Effectiveness at a phone is **near zero** for gate review — the job the product exists to make possible (Phase 0 exit criterion: a G2 review conducted entirely from the workspace). Efficiency at a desk is **acceptable** for My work (plan 07 shipped) and **poor** for onboarding (too many simultaneous steps). Satisfaction: the voice is honest, which is a strength; the chrome looks like an internal tool, which is a tax on every new member.

```
CURRENT SHELL (every signed-in page)
┌──────────┬─────────────────────────────────────────┐
│ 220px    │  padding 1.5–2rem                       │
│ sidebar  │  h1 + FilterBar + banners + page        │
│ always   │  workspace: 1fr + 340px rail            │
│          │  board: 13 × 210px → page pan           │
└──────────┴─────────────────────────────────────────┘
         no compact variant exists
```

## Goals / Non-Goals

**Goals:**

- One layout system (tokens + breakpoints + shell) that every page inherits.
- Every primary job in the persona table completable at 360px without page-level pan.
- People-language first; factory terms remain visible as chips and `[≡ raw]`.
- WCAG 2.2 AA floor in the shell and shared controls, verified by automated + keyboard pass.
- No change to Rules 1–2 (lens, not authority; GitHub remains the write path).

**Non-Goals:**

- Native iOS/Android apps, PWA install campaign, or offline-first.
- Replacing React/Vite or introducing MUI/Chakra/Tailwind as a prerequisite (utility CSS is allowed later; this design does not require it).
- Full RBAC UI, billing, Slack/email, config-as-PR, deployment views.
- Redesigning the factory label machine or OpenSpec artefact formats.
- Pixel-perfect marketing site; this is still a control panel.

## Decisions

### D1 · Mobile-first CSS, not a second app

**Choice:** Rebuild `styles.css` as mobile-first (`min-width` queries: 768, 1024) plus container queries on board, workspace, and peek. One SPA.

**Why:** The web app *is* the product. A separate mobile bundle would fork the gate and peek flows. Container queries let peek (sheet vs drawer) and board (list vs columns) respond to the slot they sit in.

**Rejected:** Viewport-only media copies for every component (the Shopify Polaris lesson: it duplicates CSS). Native wrappers. "Desktop-only + 'use GitHub on your phone'" — that abandons the product thesis.

### D2 · Compact IA: four bottom destinations

**Choice:** My work, Flow, Inbox, More. Inbox is `/blocked` (the time-critical human reply). Decisions and Onboarding are important but not every-session. Settings stays behind More, and **org settings must be reachable by org admins even when `canEditApp` is false** (today's nav hides the whole page).

**Why:** Four is the mobile cap before labels truncate. Plan 07 already split individual vs manager; the nav should match that split, not the six sidebar links.

**Rejected:** Hamburger-only (hides My work). Five-item bar including Settings. Keeping "Mission control" as a label (it's a place name, not a job).

```
COMPACT ( <768 )                         WIDE ( ≥1024 )
┌─────────────────────────────┐          ┌────────┬──────────────────────┐
│ top: brand  focus  account  │          │ side   │ top: focus           │
├─────────────────────────────┤          │ nav    ├──────────────────────┤
│                             │          │ My work│                      │
│  main (halt bar if needed)  │          │ Flow   │  main                │
│                             │          │ Inbox  │                      │
├─────────────────────────────┤          │ More…  │                      │
│ My work  Flow  Inbox  More  │          └────────┴──────────────────────┘
└─────────────────────────────┘
```

Tablet 768–1023: compact shell (bottom nav). Tablets in landscape still get thumb reach; a persistent sidebar at 768 eats too much.

### D3 · Halt bar is the signature

**Choice:** When rank-1 attention or an open gate awaits the current user, show a persistent halt bar: one-line question + primary action. Compact: docked above bottom nav (`safe-area` aware). Wide: docked under the top/focus bar. One on screen.

**Why:** The product's job is "the factory is stopped on you." Today that fact is a purple dot and a row in a list. The halt bar is the one memorable, non-generic element (frontend-design: spend boldness in one place).

**Rejected:** Toast notifications (missable). Full-screen interstitial (blocks scanning My work). Badge-only on Inbox (too quiet for a halted agent).

### D4 · People language, factory as secondary

**Choice:** UI strings use jobs: "Approve the spec", "Answer the agent", "Merge to ship". Factory labels and G1/G2/G3 remain as chips and tooltips. `[≡ raw]` stays, renamed visually to "GitHub" with accessible name "Open on GitHub".

**Why:** Heuristic 2 is a severity-4 miss. The substrate must stay visible (F-W2) but it must not be the only language.

Mapping (compact rail / chips):

| Label | People language |
|---|---|
| `factory:intake` | Filed |
| `factory:spec-ready` | Approve spec (G1) |
| `factory:spec-approved` | Spec approved |
| `factory:planned` | Planning |
| `factory:design-ready` | Approve design (G2) |
| `factory:design-approved` | Design approved |
| `factory:ready` | Ready to build |
| `factory:in-review` | In review |
| `factory:in-test` | In test |
| `factory:ready-to-ship` | Merge to ship (G3) |
| `factory:deployed` | Shipped |
| `factory:blocked` | Agent halted |
| `factory:fast-track` | Fast track |
| `factory:incident` | Incident |

### D5 · Visual language (not a template)

**Subject:** a control panel over a software factory. **Audience:** humans in the loop. **Job:** see whose move it is and act.

Tokens (names, not a second palette fighting `:root`):

| Token role | Dark | Light |
|---|---|---|
| `--bg` graphite | `#121417` | `#f3f4f2` |
| `--bg-panel` | `#1b1f24` | `#ffffff` |
| `--text` | `#e6e3d6` (warm paper, not cool grey) | `#1c2328` |
| `--accent` shift-blue | `#3d7ab8` | `#2c5f91` |
| `--halt` (signature) | `#c45c26` | `#a64b1c` |
| `--ok` | `#2e9e5b` | `#1e7a44` |

`--halt` is the only saturated accent on a calm graphite/paper field. Gate purple is demoted; halt orange-iron is the factory-floor signal (not acid green, not terracotta-cream, not newspaper).

**Type:** IBM Plex Sans (UI) + IBM Plex Mono (tickets, SHAs, labels), self-hosted `woff2`. Plex was drawn for engineering consoles; Inter/system UI is the generic default this brief rejects. Scale: 12 / 14 / 16 / 20 / 28. Body 16px. Root stays 16px on compact (iOS zoom rule).

**Radius:** 4px on controls (ticket-stub, not squircle). **No** gradients, **no** shadows on compact; one 1px border.

**Rejected:** Tailwind-default Inter + sky-500. Cream + serif. OLED black + neon. Broadsheet hairlines.

### D6 · Shared primitives before page restyles

**Choice:** Extract `Shell`, `TopBar`, `BottomNav`, `MoreSheet`, `HaltBar`, `FocusChip`, `Row` (attention), `Sheet` (peek / Ask / More), `SegmentedTabs`, `ActionBar`, `Banner` (with disclosure for technical detail). Pages consume these; they do not invent layout.

**Why:** Inline styles and one-off grids are why mobile failed. Implementation order is tokens → primitives → shell → pages.

**Rejected:** Ad-hoc media queries per page. Introducing a full design-system package in the first slice.

### D7 · Peek / Ask / More as the same Sheet

**Choice:** One `Sheet` primitive: compact = full-height (or 90%) bottom sheet with drag handle; wide = right drawer 480px. Focus trap + Escape + Close. Peek, Ask, More, orchestrator-run (when opened as modal) all use it.

**Why:** Three overlay behaviours today (peek overlay, run-modal centre, none for More). Consistency (heuristic 4) and one a11y implementation.

### D8 · Board becomes a phase list under 768 / under a narrow container

**Choice:** Reuse plan 07's five phases + Fast track. Compact: stacked sections. Wide: keep the 13-column board. `PipelineBoard` switches on container width, not only viewport (so a half-pane never gets 13 columns).

**Rejected:** Horizontal-scroll kanban on mobile (NN/G: tables/boards that pan the page fail). Dropping the board on desktop (managers still want it).

### D9 · Workspace is a review phone app, not a shrunk IDE

```
COMPACT WORKSPACE
┌──────────────────────────────────┐
│ ‹ My work    #42 Title    GitHub │
│ Filed → Approve spec (G1) → …  ▾ │
├──────────────────────────────────┤
│ HALT  Approve the spec     [Open]│
├──────────────────────────────────┤
│ Overview  Spec  Gate  Tasks  … → │
├──────────────────────────────────┤
│ rendered artefact / thread / …   │
│ (table scrolls inside card)      │
├──────────────────────────────────┤
│ [Ask]  [History]                 │
│ sticky: Approve · Request changes│
└──────────────────────────────────┘
```

**Choice:** Sticky action bar on Gate/Blocked; Ask/History as sheets; tabs as a scrollable tablist with `aria-selected`.

**Rejected:** Pinch-to-see-the-rail. Iframes of GitHub. Markdown as raw `<pre>` on mobile.

### D10 · Settings split

**Choice:** `App.tsx` today: Settings route is `canEditApp` only. Org insight keys live on that page, so org admins who are not the App owner cannot reach them. Split into **Organisation** (any org admin/owner) and **GitHub App** (canEditApp). More sheet lists Organisation for admins; GitHub App only for the App owner.

**Why:** Heuristic 4 / suitability for the task. No API change: same page, two sections, route always registered; App section omitted when `!canEditApp`.

### D11 · Progressive disclosure for operator errors

**Choice:** Banner = people sentence + one action. Worker/Redis/PEM/webhook URL behind `<details>Technical details</details>`.

**Why:** Heuristic 9 vs 2. Operators still get the payload; members are not blocked by it.

### D12 · Test the four critical jobs in Playwright

**Choice:** Viewport fixtures 360, 768, 1280. Jobs: (1) sign-in station layout, (2) needs-you → peek → reply, (3) gate Approve sticky + no page pan, (4) onboarding accordion. Plus axe-core on shell.

**Why:** Visual review cannot be the only gate; this change is otherwise unfalsifiable.

**Rejected:** Snapshot-only tests (too brittle on tokens). Manual-only QA.

### D13 · No API change in the first ship

**Choice:** Existing DTOs. If organisation-health is too heavy, collapse client-side. A compact `/api/me/nav` (blocked count for the Inbox badge) is a **follow-up** if counting client-side from `/api/blocked` is too chatty — not a blocker.

## Risks / Trade-offs

- **[Managers lose the board on a phone]** → Mitigation: phase-stacked list is the same data; desktop board unchanged. Copy on the Factory tab: "Board on larger screens".
- **[Approvers approve without reading because Approve is sticky]** → Mitigation: artefact stays on-screen; open-questions ack unchanged; what-changed banner sits above the bar (plan 05 risk "approve without reading").
- **[Plex webfonts slow first paint]** → Mitigation: `font-display: swap`, subset woff2, system-ui fallback matching metrics as well as possible.
- **[Bottom nav + halt bar + sticky Approve stack and eat the viewport]** → Mitigation: halt bar **is** the Approve entry on Gate; do not show both. Inbox badge does not duplicate a halt bar.
- **[Org admin cannot open Settings today; we change who sees the route]** → Mitigation: D10; still no new capabilities leaked (API already scopes writes).
- **[Scope explodes into a visual rewrite of markdown]** → Mitigation: tables scroll inside the card; we do not restyle GitHub-flavoured markdown beyond existing `.markdown-body`.
- **[Factory constraint: one OpenSpec change ≲ 10 tasks]** → Mitigation: `tasks.md` is four work packages that can be filed as four factory epics; this change is the programme spec.

## Migration Plan

1. Land tokens + `Shell` behind the current pages (no IA change) — visual-only, easy revert.
2. Switch `App.tsx` to `Shell` (nav IA change). Keep old class names as aliases for one release if needed.
3. Page-by-page: attention → workspace → setup. Each WP is independently shippable.
4. Remove unused sidebar-only CSS once all pages consume primitives.
5. Rollback = revert the SPA deploy; API unchanged.

## Open Questions

- Whether to add `/api/me/nav` for the Inbox badge or derive from `/api/blocked` (does not change specs).
- Whether tablet landscape at 1024px should prefer the wide shell (spec already says 1024 = wide).
- Exact IBM Plex licensing/self-host path in `apps/web/public/fonts` (implementation detail).
