## Why

Pass 1 (`mobile-ux-redesign`) shipped a mobile-first shell, people-language chips, sheets, and a 360px Playwright harness — but the harness mounts static stubs, not the real routes. A relook against ISO 9241-11/110, Nielsen’s heuristics, WCAG 2.2 AA, and Apple HIG / Material targets shows the four critical jobs still fail or degrade on a real phone: chrome stacks (top bar + halt + banners + bottom nav), gate review duplicates the halt signal, peek has no drag-dismiss, Approve has no fat-finger confirm, and in-app help is still absent. Until the live SPA, not the e2e fixture, completes those jobs at 360px, the Console is not entirely mobile-compatible.

## What Changes

- Tighten the **compact chrome**: one-line top bar (brand + focus chip + account), Focus opens a sheet instead of two wrapping `<select>`s, halt bar is global and never stacked with a duplicate gate banner or a second sticky Approve.
- Finish **Sheet** behaviour the first spec already required: drag/swipe to dismiss, restore focus, and keep peek/Ask/More as one primitive.
- Restore **row anatomy** (title, one reason, one state chip, age) — Needs-you currently repeats the reason on the badge and in the meta line.
- Add **fat-finger protection** on compact Approve / Merge / Post-reply (confirm step that still posts `Approved` as the GitHub user).
- Ship **contextual help** (Focus, halt, gate “posts Approved as you”) so heuristic 10 is no longer a blocker for new members.
- Replace “Loading…” with **skeletons** on My work, peek, and workspace; keep Banner’s people-sentence + technical `<details>`.
- Implement the plan-07 **Nudge** on Waiting-on rows (plain-language chase, not a new notification system).
- **Playwright against real screens** (or a harness that mounts the real page components with mocked API): 360 / 768 / 1280 / landscape 800×360; axe on My work, peek, Gate, onboarding — not only `/e2e.html?screen=shell`.
- Split Settings deep-links in More: Organisation vs GitHub App must land on the matching section, not the same undifferentiated page.

Not in this change: native apps, PWA install, command palette, full RBAC UI (viewer treatment), billing, Slack/email, config-as-PR, `/api/me/nav` unless `/api/blocked` for the badge is shown to be too heavy.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `console-shell`: Compact top bar and Focus sheet; global single halt; landscape; real-route overflow and axe tests; Settings section deep-links.
- `console-attention`: Strict one-reason row anatomy; skeletons; Waiting-on nudge; Inbox reply confirm on compact.
- `console-workspace`: One halt signal on the epic; drag-dismiss sheets; compact Approve/Merge confirm; Ask chips meet 44px targets.
- `console-setup`: First-run and onboarding remain one-step; API-down and PEM stations stay thumb-reachable when Focus/account chrome is compacted.

## Impact

- **Code**: `apps/web` (Shell, Sheet, MissionControl, EpicWorkspace, IssuePeek, QaPanel, Blocked, Settings, e2e). No API/schema change required.
- **Users**: Every signed-in role on a phone; gate approvers and blocked responders most.
- **Invariants**: Rules 1–2 unchanged. Approvals still post `Approved` as the signed-in user. GitHub control stays.
- **Tests**: Replace stub-only confidence with real-page viewport jobs; keep 360 / 768 / 1280 and add landscape.
- **Docs**: Update `docs/plan/09-ux-ui-redesign.md` status to implemented; this change is the pass-2 programme spec.
