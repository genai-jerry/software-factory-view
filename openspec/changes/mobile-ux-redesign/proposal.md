## Why

The Factory Console exists so humans can review, decide, and unblock agents without drowning in GitHub. Today that promise holds only on a wide desktop: the shell is a fixed 220px sidebar plus a dense main pane, the epic workspace is a two-column grid, the pipeline board is thirteen fixed-width columns, and almost every control is below a 44px touch target. ISO 9241-11 defines usability as specified users achieving specified goals with effectiveness, efficiency, and satisfaction in a specified context of use — and the specified contexts now include a phone at a gate, a tablet in a standup, and a laptop. Until every primary job works in a 360px viewport, the Console is not usable for the people it was built for.

## What Changes

- Rebuild the app chrome as a **mobile-first shell**: top bar + bottom nav on small screens, collapsible sidebar on large screens, skip link, visible focus, and `safe-area` padding.
- Redesign every surface (home, mission control, peek, flow, blocked, decisions, epic workspace, gate, onboarding, settings, orchestrator run) so it **reflows, never pinches or horizontal-scrolls the page**.
- Introduce a **design token and type system** (breakpoints, spacing, type scale, touch targets) and retire ad-hoc inline layout styles in `apps/web`.
- Rewrite UI copy so jobs use **people language** first (Needs you, Approve spec, Answer the agent) and factory jargon (`factory:spec-ready`, G1) as secondary chips.
- Make high-stakes actions (Approve, Post reply & unblock, Merge, Reset) a **sticky action bar** on small screens, with confirmation that survives a fat-finger.
- Add WCAG 2.2 AA floor: labels, names, contrast, 24×24 minimum / 44×44 preferred targets, focus trap in drawers, Escape to dismiss, `prefers-reduced-motion`.
- **No API/schema change is required** for the first ship; existing `/api/my-work`, peek, gate, and onboarding contracts stay. A later slice may add a compact health payload if the organisation-health strip is too chatty on mobile.

Not in this change: full RBAC UI (F-U2–F-U8), billing, email/Slack notifications, config-as-PR editors, deployment/testing views.

## Capabilities

### New Capabilities

- `console-shell`: Responsive application chrome, navigation information architecture, visual language, and accessibility floor that every other surface inherits.
- `console-attention`: Individual-first daily work (My work, peek, blocked inbox, flow, decisions) usable at 360px with ball-in-whose-court grouping preserved.
- `console-workspace`: Epic workspace, gate panel, artifacts, threads, and Ask the Factory as a single-column, action-first review on small screens and a two-pane review on large screens.
- `console-setup`: Getting-started ticket, organisation connect, factory enablement, and settings as thumb-reachable wizards rather than desktop forms.

### Modified Capabilities

- _(none — `openspec/specs/` is empty; this is the first UI capability set)_

## Impact

- **Code**: `apps/web` only for the implementation slices (shell, CSS tokens, page layouts, shared components). `apps/api` untouched unless a compact DTO is added later.
- **Users**: Every Console role — first-run operator, org owner/admin, member, gate approver, flow watcher, blocked responder. No role currently has a working phone path.
- **Invariants**: Rules 1 and 2 stand. `[≡ raw]` stays on every entity. Approvals still post `Approved` as the signed-in GitHub user.
- **Tests**: Playwright (or equivalent) viewport suites at 360 / 768 / 1280 for the four critical jobs: sign-in, needs-you → peek → reply, gate approve, onboarding step.
- **Dependencies**: System fonts or a self-hosted pair (IBM Plex Sans + IBM Plex Mono). No new UI framework; stay on React 18 + existing CSS tokens.
