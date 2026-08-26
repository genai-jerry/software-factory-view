## 1. Compact chrome and halt

- [ ] 1.1 Replace compact Focus `<select>`s with a single chip/button that opens `Sheet`; keep `useFocus` persistence and labelled Close/Escape
- [ ] 1.2 Collapse the top bar to one row on viewports below 768px (brand, Focus, named avatar; hide @login text)
- [ ] 1.3 Lift halt to Shell context so it stays visible off `/`; hide it on the matching Gate tab; delete the duplicate “gate is waiting on you” banner
- [ ] 1.4 Hash-link More → `/settings#organisation` and `/settings#github-app`; scroll/show the matching Settings section
- [ ] 1.5 Keyboard-check Focus sheet and global halt (Tab order, skip link still reaches `#main`)

## 2. Sheet, rows, and compact writes

- [ ] 2.1 Add pointer drag/swipe dismiss on `Sheet` (handle + header; ignore when `scrollTop > 0` or gesture starts in a field); keep Close and Escape
- [ ] 2.2 Restyle Needs-you / in-flight / waiting-on rows so the reason appears once (title, one reason, one chip, age)
- [ ] 2.3 Add compact confirm (second tap in `ActionBar`) for Approve, Merge, Post-reply; desktop ≥768px may stay single-tap
- [ ] 2.4 Size Ask-the-Factory canned prompts to `--target` (44px) with 8px gap
- [ ] 2.5 Add My work / peek / workspace skeletons; stop using a lone “Loading…” as the signed-in waiting state on those surfaces

## 3. Nudge and help

- [ ] 3.1 Add Waiting-on **Nudge** that posts an ordinary GitHub comment via the existing reply API; confirm on compact; disable when there is no named mover
- [ ] 3.2 Add Gate inline sentence that Approve posts `Approved` as the signed-in user; add `aria-describedby` on Focus
- [ ] 3.3 Keep onboarding accordion and Settings sticky Save above bottom nav + `safe-area` after chrome changes

## 4. Real-page viewport tests

- [ ] 4.1 Mount real `MissionControl`, peek, Gate, Inbox, and Onboarding against typed fixture JSON (Playwright `page.route` or e2e harness)
- [ ] 4.2 Assert no page-level pan at 360×800, 768×1024, 1280×800, and 800×360 on those routes
- [ ] 4.3 Run axe-core WCAG 2.2 AA on My work and Gate at 360px; cover Focus sheet Escape and Approve confirm-does-not-post-on-first-tap
- [ ] 4.4 Mark `docs/plan/09-ux-ui-redesign.md` implemented and point at this change; add phone jobs to the README testing guide if they drifted
