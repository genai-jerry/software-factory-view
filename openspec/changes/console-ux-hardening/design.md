## Context

See `proposal.md` for why. Pass 1 (`openspec/changes/mobile-ux-redesign`, shipped in `2e7cdb5`) already owns tokens (`--target: 44px`, `--halt`, Plex, skip-link, `focus-visible`, `safe-area`), `Shell` / bottom nav / `Sheet` / `HaltBar` / `ActionBar` / `Banner`, people-language maps in `lib/labels.ts`, and Playwright on `/e2e.html` stubs.

Constraints: `apps/web` only; no new UI framework; Rules 1–2 (lens, GitHub writes as the user); existing `/api/my-work`, peek, gate, blocked, onboarding contracts.

Current gaps this design closes:

- `Shell` halt is gated on `location.pathname === "/"` (`apps/web/src/components/Shell.tsx`); epic Gate still renders HaltBar **and** an info banner (`EpicWorkspace.tsx`).
- Top bar puts two Focus `<select>`s inline; they wrap on 360px.
- Needs-you prints the reason on the badge and again in `.work-row-meta`.
- `Sheet` traps focus and Escape; the handle is visual only (pass-1 spec already required drag-dismiss).
- Gate `ActionBar` posts on first tap; pass-1 asked for fat-finger protection.
- `QaPanel` canned prompts use `.chip` padding (`0.05rem`).
- e2e never mounts `MissionControl` / `EpicWorkspace` / `OnboardingPage`; axe runs on an empty shell.

Heuristic scores **after pass 1** (worst remaining instance; 0–4): visibility 2, match-to-world 2, control/freedom 2, consistency 2, error prevention 3 (fat-finger Approve), recognition 2, flexibility 3 (no real phone path proven), aesthetic 2, error recovery 2, help 4.

## Goals / Non-Goals

**Goals:**

- One chrome density model that fits 360×800 and 800×360 without pan.
- One halt signal, one confirm on destructive/authoritative compact writes.
- Tests that fail if a real page regresses overflow or axe.
- Help that is a sentence in the job, not a wiki.

**Non-Goals:**

- Replacing pass-1 visual language (Plex, halt orange, graphite). This is hardening, not a second aesthetic pass.
- Native apps, command palette, `/api/me/nav`, viewer RBAC, billing.
- Rewriting markdown rendering.

## Decisions

### D14 · Halt state lifts to Shell for every signed-in route

**Choice:** Keep `HaltCtx`. Mission Control continues to *compute* the top attention item, but persist it on the context so Flow/Inbox/workspace inherit it. Epic Gate *consumes* the same item: if the member is on the Gate tab for that epic, Shell hides the halt bar (actions live in `ActionBar`). Remove the duplicate info banner.

**Why:** D3 already said one halt. Implementation only wired My work.

**Rejected:** Per-page HaltBars (status quo). Toasts.

### D15 · Focus is a chip that opens the existing Sheet

**Choice:** Compact: one “Focus” button / active-repo chip in the top bar; choices live in `Sheet`. Wide (≥768): keep inline selects if they fit one row; otherwise the same sheet.

**Why:** Two selects + brand + avatar is the overflow source. `useFocus` persistence unchanged.

**Rejected:** Hiding Focus on mobile (members with several repos would lose the product’s scoping model). A new popover library.

### D16 · Confirm is in-sheet, not `window.confirm`

**Choice:** Compact Approve, Merge, Post-reply, and Nudge swap the primary button for “Confirm · posts as @login” in the same `ActionBar`. Desktop (≥768) may keep single-tap (mouse precision). Open-questions ack still gates the first tap.

**Why:** `window.confirm` is inaccessible and ugly; a second page would lose the artefact. Matches fat-finger without changing the GitHub write.

**Rejected:** Long-press. Always-on two-tap on desktop.

### D17 · Drag-dismiss on Sheet via pointer events

**Choice:** Track `pointerdown/move/up` on the handle + header; translate the panel; dismiss if dy > 80px or velocity is downward. Ignore when the body is scrolled (`scrollTop > 0`). Mouse users still have Close and Escape.

**Why:** Pass-1 spec already required it; iOS users expect it. No extra dependency.

**Rejected:** A drawer library. Handle-only without body-scroll guard (would fight peek content).

### D18 · Real-page tests via mocked API in Playwright

**Choice:** Extend the Vite e2e entry (or Playwright `page.route`) so tests render `MissionControl`, `IssuePeek`, `EpicWorkspacePage` Gate, `OnboardingPage`, `BlockedPage` with fixture JSON — same components as production, no GitHub. Keep 360 / 768 / 1280; add 800×360. Stub-only `?screen=shell` may remain as a smoke test but is not sufficient.

**Why:** The current harness cannot regress EpicWorkspace overflow. Network-less fixtures stay CI-friendly.

**Rejected:** Only live-environment e2e (flaky, needs secrets). Deleting the harness without replacing coverage.

### D19 · Nudge is a GitHub comment, not a Console notification

**Choice:** POST the existing issue reply endpoint (or epic comment) with a short template: “@login — this is blocking #N. Please move it.” No new notifier.

**Why:** Rule 2. Plan 07 already specified this; it was not in pass 1.

**Rejected:** Email/Slack. Console-native unread counts.

### D20 · Settings sections via hash

**Choice:** `/settings#organisation` and `/settings#github-app`. More links use those hashes. `SettingsPage` scrolls the section into view and MAY hide the other section when the viewer cannot use it.

**Why:** Two More items already point at the same route.

**Rejected:** Two routes (`/settings/org`, `/settings/app`) — extra router surface for a one-page form.

### D21 · Help is inline copy + `aria-description`, not a coach-mark product

**Choice:** One sentence on Gate; `aria-describedby` on Focus. Optional localStorage “dismissed” for a compact hint, not a tour SDK.

**Why:** Heuristic 10 is still a 4; a product tour would fight halt density.

## Risks / Trade-offs

- **[Global halt annoys flow watchers who are also approvers]** → Mitigation: halt action is always the *top* rank-1/gate item; one bar, not a stack of bars.
- **[Two-tap Approve slows desktop reviewers]** → Mitigation: D16 applies below 768px only.
- **[Drag-dismiss fights textarea focus in peek]** → Mitigation: D17 ignores gestures that start inside form fields.
- **[Nudge spam]** → Mitigation: disable after a successful nudge until reload; comment is visible on GitHub so social pressure is the throttle.
- **[Fixture e2e still diverges from API shapes]** → Mitigation: type fixtures from `apps/web/src/types.ts`; one fixture file per screen.

## Migration Plan

1. Sheet drag + Focus sheet + top-bar density (chrome only; easy revert).
2. Halt context global + remove duplicate banners.
3. Row anatomy, confirm, nudge, Ask targets.
4. Replace stub-only Playwright with mounted pages; add landscape.
5. Help sentences. Rollback = SPA revert; API unchanged.

## Open Questions

- Whether `/api/blocked` for the Inbox badge is too chatty (pass-1 D13). Defer `/api/me/nav` until measured.
- Whether tablet landscape at 1024px should keep the wide sidenav (pass-1 already says 1024 = wide). Unchanged.
