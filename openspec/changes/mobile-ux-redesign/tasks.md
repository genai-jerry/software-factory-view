## 1. Tokens, fonts, and primitives

- [x] 1.1 Extend `apps/web/src/styles.css` with mobile-first tokens from design D5 (`--halt`, type scale, spacing, 768/1024 breakpoints) without changing page layout yet
- [x] 1.2 Self-host IBM Plex Sans + IBM Plex Mono woff2, apply `font-display: swap`, keep the existing theme first-paint rule in `theme.ts`
- [x] 1.3 Add global a11y CSS: `:focus-visible`, skip-link, `prefers-reduced-motion`, `env(safe-area-inset-*)` padding helpers
- [x] 1.4 Add `Sheet`, `HaltBar`, `SegmentedTabs`, `ActionBar`, and `Banner` (people sentence + technical `<details>`) components with focus trap, Escape, labelled Close, and 44px preferred targets
- [x] 1.5 Add Playwright (or extend existing e2e) viewport fixtures at 360, 768, and 1280 plus an axe-core pass on the signed-in shell once it exists

## 2. Application shell and navigation

- [x] 2.1 Implement `Shell` + `TopBar` + `BottomNav` + `MoreSheet` per `console-shell` (four destinations: My work, Flow, Inbox, More)
- [x] 2.2 Move Focus into the top bar as a chip that wraps on compact viewports; keep `useFocus` persistence
- [x] 2.3 Split Settings: register `/settings` for org admins; show GitHub App section only when `canEditApp`; list Organisation vs GitHub App correctly in More
- [x] 2.4 Add Inbox badge count from `/api/blocked` (no new API); add skip link and `banner` / `navigation` / `main` landmarks
- [x] 2.5 Wire halt bar on My work from rank-1 / open-gate attention; do not stack it with a duplicate sticky Approve
- [x] 2.6 Replace `App.tsx` sidebar layout with `Shell`; verify signed-out home and `/runs/:runId` stay outside the signed-in shell
- [x] 2.7 Keyboard-check the shell: Tab order, Escape on More, theme control has an accessible name

## 3. Daily work surfaces

- [x] 3.1 Restyle My work rows to the compact anatomy (title, one reason in people language, one state chip, age) using the D4 label map
- [x] 3.2 Switch peek to `Sheet` (full-height compact, 480px drawer wide); add Escape, focus restore, reply + Ask in the sheet
- [x] 3.3 Make `PipelineBoard` container-query aware: phase-stacked list below 768px container width, column board at 1024+
- [x] 3.4 Wrap Flow tree metadata; 44px expand targets; Enter and Space toggle; title opens peek
- [x] 3.5 Restyle Blocked as in-place reply with 16px textarea and sticky "Post reply & unblock"
- [x] 3.6 Stack decision cards and set search input to 16px minimum
- [x] 3.7 Playwright: 360px needs-you → peek → reply composer visible without page-level horizontal overflow

## 4. Epic workspace and gate

- [x] 4.1 Compact workspace: single column, three-stage rail with expand-to-full, scrollable job-named tablist (`aria-selected`)
- [x] 4.2 Move Ask the Factory and timeline into compact sheets; keep the 340px rail at 1024+
- [x] 4.3 Gate sticky `ActionBar` (Approve, Request changes, Merge) with open-questions ack and what-changed banner above the bar
- [x] 4.4 Artefact reader: stacked picker + segmented as-proposed/as-approved; markdown tables scroll inside the card
- [x] 4.5 Threads sticky composer and compact task list with halt treatment on blocked tasks
- [x] 4.6 Rename `≡ raw` to a "GitHub" control with accessible name "Open on GitHub" across workspace, peek, and rows
- [x] 4.7 Playwright: 360px G1 Gate tab shows rendered spec plus Approve without page-level pan; non-approver does not see Approve

## 5. Getting started, onboarding, settings

- [x] 5.1 Home ticket: full-width 44px primary actions, stacked ticket head, API-down banner with technical details collapsed
- [x] 5.2 Connect-org checklist: 44px repo rows, in-list scroll, visible selected count
- [x] 5.3 Onboarding accordion on compact viewports (one open step); move Reset behind confirmation away from the primary action
- [x] 5.4 Validation results as stacked pass/fail/skip rows with a human fix on failures
- [x] 5.5 Settings: sectioned cards, secret show/hide, 16px fields, sticky Save above the home indicator
- [x] 5.6 Orchestrator run log wraps inside its region; unauthenticated `/runs/:id` sign-in prompt unchanged
- [x] 5.7 Playwright: 360px sign-in station and one onboarding step expanded with later steps collapsed

## 6. Copy, QA, and cleanup

- [x] 6.1 Apply people-language strings (D4) on remaining chips/banners; keep factory labels as secondary text
- [x] 6.2 Keyboard + VoiceOver/NVDA pass on shell, peek, gate, and onboarding; fix names, traps, and contrast misses
- [x] 6.3 Remove unused sidebar-only CSS and inline layout styles that duplicate tokens
- [x] 6.4 Document the compact IA and halt bar in `README.md` testing guide (phone jobs)
