# 09 · UX/UI redesign: mobile-compatible Console

**Status:** proposed (OpenSpec change `mobile-ux-redesign`). Planning only — no UI code in this change.
**Companion artifacts:** [`openspec/changes/mobile-ux-redesign/`](../../openspec/changes/mobile-ux-redesign/) (`proposal.md`, `design.md`, specs, `tasks.md`).
**Depends on:** [07](07-pipeline-view-state-display.md) (individual-first information architecture — kept), [00](00-overview.md) Rules 1–2 (lens, not authority — kept).

## 1. Verdict

Plan 07 made Mission Control *ask the right questions*. The chrome still answers them only on a wide desk. ISO 9241-11 usability (specified users, specified goals, effectiveness / efficiency / satisfaction, specified context) fails as soon as the context is a phone: the shell is a 220px sidebar, the workspace is a 1fr+340px grid, the board is thirteen 210px columns, and controls sit under 24×24 CSS pixels. Gate review — the reason the product exists — cannot be completed at 360px.

## 2. Standards applied

ISO 9241-11, ISO 9241-110, Nielsen's 10 heuristics, WCAG 2.2 AA, Apple HIG 44pt / Material 48dp targets, NN/G mobile and dashboard guidance. Full scoring tables live in `design.md`.

Worst heuristic misses: **match to the real world** (factory jargon as the only language), **flexibility** (no mobile path), **help** (none in-app), **visibility** (operator banners). Plan 07 already lifted recognition (`whyYou`) and task-suitability (Needs you / in flight / waiting).

## 3. Persona scorecard (today → target)

| Persona | Today at 360px | Target |
|---|---|---|
| Member / requester | Sidebar crushes My work | Halt bar + row → peek sheet → reply |
| Spec/design approver | Workspace overflows; Approve buried | Single-column review + sticky Approve |
| Release manager | Merge buttons collide | Sticky Merge per PR on Gate |
| Flow watcher | Tree overflows; board pans | Wrapping tree; phase list instead of kanban |
| Org admin | Hostile forms; Settings hidden if not App owner | Accordion onboarding; Organisation in More |
| First-run operator | PEM-hostile ticket | Full-width actions; technical details collapsed |
| Blocked responder | Tiny Reply | Inbox in bottom nav; in-place composer |
| Viewer | Not built | Unchanged (out of scope) |

## 4. Design in one page

- **Shell:** bottom nav of four jobs (My work, Flow, Inbox, More) below 768px; sidebar at 1024+.
- **Signature:** halt bar when the factory is stopped on you.
- **Language:** jobs first ("Approve the spec"); G1 / `factory:*` as chips; GitHub control replaces `≡ raw`.
- **Type/colour:** IBM Plex Sans + Plex Mono; graphite/paper field; `--halt` iron-orange as the only loud colour.
- **Overlays:** one Sheet primitive (peek, Ask, More).
- **Board:** phase-stacked list in a narrow container; 13-column board only when the container is wide.
- **No API change** for the first ship. Rules 1–2 unchanged.

## 5. Implementation

Four work packages in `tasks.md`, independently shippable, matching the four new capabilities (`console-shell`, `console-attention`, `console-workspace`, `console-setup`). Apply with `/opsx:apply` (or four factory epics sliced from those headings). Playwright jobs at 360 / 768 / 1280 are the exit tests.
