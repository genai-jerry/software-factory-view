# Design — Compass phone layout rules

Epic: genai-jerry/software-factory-view#178. One repo: software-factory-view,
web app only (`apps/web`). No API, no data, no migration. Home branch `main`
(the branch policy sets `required: false` and this repo has no staging
branch), so every task PR bases on `main`, and merging one deploys.

## Decisions

### D1 — The app uses three screen sizes: phone under 768px, tablet 768–1023px, desktop 1024px and up
Why: the stylesheet switches at six widths today (640, 720, 768, 860, 900,
1024), so no one can say what "on a phone" means. Each odd width folds into
the nearest size without changing any screen at 360, 768 or 1280px.

### D2 — The bottom nav shows Work, Decisions, Shape, Investigate and More; Activity moves into More
Why: five items fit one row at 360px (72px each). Activity is the least
urgent of the six, and More already holds the other secondary screens.

### D3 — The bottom nav has one fixed height, and every sticky bar sits on top of that height
Why: today the action bar guesses the nav is 3.2rem tall. One shared height
value means the bars and the nav cannot drift apart again.

### D4 — The page keeps hiding sideways overflow until every screen is fixed; the checks task then removes that
Why: removing it first would make unfixed screens pan sideways in production
for a while. The checks measure the real page width either way, so hidden
overflow cannot pass them.

### D5 — On phones the runs list and the Environments pull-request list open in the existing bottom sheet
Why: the `Sheet` component already stays on screen, traps focus and closes
on Escape. Popovers stay as they are on tablet and desktop.

### D6 — On phones, Shape and Investigate show only the chat; a "Conversations" button opens the list in a sheet
Why: the list above the chat pushes the composer below the fold. Tablet and
desktop keep today's layout.

### D7 — The chat sizes itself to the part of the screen the keyboard leaves free
Why: Android Chrome shrinks the page for the keyboard when the page asks it
to (`interactive-widget=resizes-content`); iPhone Safari does not, so the
chat also reads the visible screen height from the browser.

### D8 — The phone checks run the real app in a browser with recorded API answers, one entry per route
Why: the test harness today mounts single components with no data, so most
routes cannot be checked there. Recorded answers need no API, database or
GitHub, so the checks run anywhere in about a minute.

### D9 — A check fails when a route is wider than 360px, has an accessibility violation, or has a control smaller than 44 by 44 pixels
Why: these are the three rules the spec makes testable. Each failure names
the route.

### D10 — CI runs the phone checks inside the existing pull-request check, not a new job
Why: that check is already required before a pull request merges into
`main`. A new job would block nothing until someone changes the repo
settings.

## Context

What the code does today (read on `main` at 4ef9de9):

- `apps/web/src/components/Shell.tsx` renders `PrimaryLinks` twice: in the
  side nav (desktop, ≥1024px) and in `.bottom-nav` (below 1024px). The bottom
  nav gets Work, Decisions, Activity, Shape, Investigate and More — six items
  in `grid-template-columns: repeat(4, 1fr)`, so it wraps to two rows.
- `apps/web/src/styles.css` sets `html, body { overflow-x: hidden }`. Wide
  content is clipped, not reachable. `--target: 44px` exists and `button`,
  `input`, `select` already use it as `min-height`; nothing sets a minimum
  width, and several controls override it (`button.link`, `.focus-clear`,
  `.env-pulls-btn`, `.shape-thumb button` at 20×20, `.shape-toggle button`).
- Sticky bars: `.action-bar` (`components/ActionBar.tsx`) sits at
  `bottom: calc(3.2rem + safe-bottom)` inside the shell; `.settings-save`
  (Settings) uses the same guess; `.thread-composer` sits at `bottom: 0`, so
  the nav (z-index 20) covers it. The halt bar and update bar are at the top
  of the page in normal flow and cannot cover the nav.
- `RunsBadge.tsx` opens `.runs-pop`: absolute, `right: 0`, `min-width: 20rem`.
  At 360px the header wraps, the badge can sit near the left edge, and the
  popover then runs off the left side.
- `Shape.tsx` renders `.shape` as a 280px list beside the chat; at ≤900px it
  stacks the list above the chat. `.shape-messages` has
  `max-height: calc(100vh - 20rem)`, which ignores the keyboard.
- Settings rows (`check-row`, no wrap) carry inline `minWidth: 16rem` and
  `10rem` spans, which is why the repository name and time are lost at 360px.
- `apps/web/e2e/ux.spec.ts` checks 6 harness screens at 360/768/1280. It is
  out of date (it looks for a "My work" link the nav no longer has), and no
  workflow runs it. `@playwright/test` and `@axe-core/playwright` are already
  dev dependencies.

## Shared pieces (built once, reused by every task)

| Piece | File | Built by | Used by |
|---|---|---|---|
| Screen sizes as constants and `useIsPhone()` | `apps/web/src/lib/screens.ts` (new) | the shared phone rules task | runs list, Environments, Shape |
| `--nav-h`, `--bar-offset` | `styles.css` `:root` | the shared phone rules task (`--nav-h`); the bottom nav task fixes its value | action bars task |
| `.scroll-x`, `.wrap-anywhere` | `styles.css` | the shared phone rules task | every screen task |
| `useVisibleHeight()` | `apps/web/src/lib/screens.ts` | the keyboard task | Shape |
| Route list and recorded API answers | `apps/web/e2e/routes.ts`, `apps/web/e2e/fixtures/` (new) | the checks task | CI task |

`src/lib/screens.ts` (illustrative):

```ts
// The three screen sizes (design D1). CSS cannot read these, so styles.css
// repeats the two numbers in its media queries; keep them in step.
export const PHONE_MAX = 767;   // phone: < 768px
export const DESKTOP_MIN = 1024; // tablet: 768–1023px; desktop: >= 1024px
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export function useIsPhone(): boolean { /* matchMedia(PHONE_QUERY) + change listener */ }
```

## Task 1 — The three screen sizes and the shared phone rules (#180)

Depends on nothing. Changes `apps/web/src/styles.css` and adds
`apps/web/src/lib/screens.ts`. No screen changes on purpose.

- **Sizes (D1).** Every `@media` width query uses one of two forms only:
  `(max-width: 767px)` for phone, `(min-width: 768px)` for tablet and up,
  `(max-width: 1023px)` / `(min-width: 1024px)` for below/at desktop. Fold:
  640 → 767, 720 → 767, 860 → 1023, 900 → 1023. At 360 and 1280 nothing
  changes; at 768, 640/720 rules did not apply and still do not, 860/900
  rules applied and still do. The `@container (min-width: 1024px)` on the
  board host measures the board's own width, not the screen, and stays.
  A comment block at the top of the file names the three sizes and points
  at `src/lib/screens.ts`.
- **Wrap or scroll rule.** Two utility classes: `.scroll-x { overflow-x:
  auto; max-width: 100%; overscroll-behavior-x: contain }` for tables, logs
  and diagrams; `.wrap-anywhere { overflow-wrap: anywhere; min-width: 0 }`
  for long names, URLs and branch names. Base rules: `img, video, iframe,
  svg { max-width: 100% }`; flex and grid children inside `.main` get
  `min-width: 0` where the existing class lacks it. `pre` already scrolls.
  `html, body { overflow-x: hidden }` stays for now (D4).
- **44px rule.** Inside `@media (max-width: 1023px)` (the sizes that show
  the bottom nav and are touch-first): `button, a.button, select, summary,
  [role="button"], input:not([type=checkbox]):not([type=radio])` get
  `min-height: var(--target)` and `min-width: var(--target)`. Checkboxes and
  radios meet it through their `<label>`, which gets `min-height:
  var(--target)` and `display: inline-flex; align-items: center`.
  `button.link` keeps `min-height: 0` only when it sits inside running text
  (`p button.link, li button.link`); elsewhere it gets the target.
- **Nav height.** `:root { --nav-h: 3.5rem }` declared here, with the meaning
  "the bottom nav's height, safe area excluded". Nothing uses it yet.

Failure modes: a screen that relied on a 640/720 rule between 641 and 767px
now gets the phone layout there — intended. A control that grows to 44px
min-width may push a tight row wider; such rows are each screen task's job.

## Task 2 — The one-row bottom nav, with Activity in More (#181)

Depends on the shared phone rules task. Changes `Shell.tsx`, `styles.css`.

- `PrimaryLinks` with `onMore` (bottom nav) renders Work, Decisions, Shape,
  Investigate, More. Activity renders only in the side nav. `MoreMenu`
  gains `Activity` as its first link, above Environments.
- `.bottom-nav { grid-template-columns: repeat(5, minmax(0, 1fr)); height:
  calc(var(--nav-h) + var(--safe-bottom)) }`. Items: `height: var(--nav-h)`,
  `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis`, so a
  long label or the Decisions count can never add a row. At 360px each item
  is 72px; "Investigate" at 0.78rem is about 60px.
- When the current page is Activity (or any More page), the More button
  shows as active (`aria-current` is not used on a button; add the `active`
  class) so the person can see where they are.
- Unit test in `src/components/Shell.test.tsx` (new): the bottom nav has
  exactly five items in that order; More opens a sheet that lists Activity.

Edge: the side nav (desktop) is unchanged, with Activity in place.

## Task 3 — Action bars and save bars sit above the nav (#182)

Depends on the one-row bottom nav task. Changes `styles.css`, `Settings.tsx`.

- `:root { --bar-offset: 0px }`; under 1024px, `.shell { --bar-offset:
  calc(var(--nav-h) + var(--safe-bottom)) }`.
- `.shell .action-bar`, `.settings-save` and `.thread-composer` use
  `bottom: var(--bar-offset)`. Remove the `3.2rem` guesses and the
  `bottom: 0` override at ≥1024px (the variable is 0 there).
- `.action-bar` drops its own `safe-bottom` padding when inside `.shell`,
  because the nav already carries it.
- `.settings-save` gets the same top border and panel background as
  `.action-bar`, so it reads as a bar. Its inline `marginTop` moves into the
  class.
- The halt bar and update bar sit at the top of the page in normal flow;
  this task confirms that and changes nothing about them.

Failure mode: a page outside the shell (front door, sign-in) has no nav;
`--bar-offset` stays 0 there.

## Task 4 — Settings and Onboarding fit a phone screen (#183)

Depends on the shared phone rules task. Changes `Settings.tsx`,
`Onboarding.tsx`, `styles.css`.

- Settings webhook-delivery and reconcile rows: replace inline `minWidth`
  styles with classes. `.check-row` gets `flex-wrap: wrap`; a new
  `.check-row-name` (`flex: 1 1 12rem; min-width: 0`, `.wrap-anywhere`) holds
  the repository or estate name; `.check-row-time` (`white-space: nowrap`)
  holds the time. On a phone the name takes the first line and the time and
  status wrap to the next, all visible.
- Error text in those rows (`d.error`, `r.errors`) gets `.wrap-anywhere`,
  with `flex-basis: 100%` so it starts its own line.
- Project rows, rename row and member rows: replace inline `style` widths
  with `.row` and `.wrap-anywhere`.
- Onboarding: `.repo-pick` labels, secret fields and the validation list get
  `.wrap-anywhere`; `.secret-field` stacks its button under the input on
  phones; `.engine-grid` already stacks.

## Task 5 — The remaining screens fit a phone screen (#184)

Depends on the shared phone rules task. Changes `EpicWorkspace.tsx`,
`Tools.tsx`, `Models.tsx`, `Environments.tsx`, `OrchestratorRun.tsx`,
`IssuePeek.tsx` and their rules in `styles.css`.

- Epic workspace: `.assembly-table` and any other table get a `.scroll-x`
  wrapper; branch names, PR titles and file paths get `.wrap-anywhere`;
  `.stage-rail` already wraps.
- Tools: server URLs move from inline `wordBreak: break-all` to
  `.wrap-anywhere`; the header-row inputs (`flex: 1 1 10rem` / `2 1 14rem`)
  stack on phones (`flex-basis: 100%`).
- Models: each phase row's model chain wraps; selects get `max-width: 100%`.
- Environments: already stacks at ≤860 (now ≤1023). Card titles and pull
  meta get `.wrap-anywhere`.
- Run page: `.run-page pre.run-log` scrolls inside itself (`.scroll-x` and
  `max-width: 100%`); `.run-fields > div` stacks to one column on phones
  (`7rem 1fr` → `1fr`).
- Issue peek: opens in `Sheet` already; its rows switch from inline styles
  to classes, and links and PR titles get `.wrap-anywhere`.
- Work, Decisions, Activity, Pipeline, Flow, Blocked, Decision log,
  Telegram, New work: check at 360px with the checks task's helper run
  locally; fix with the same two classes where they overflow. The checks
  task will fail any that are missed.

## Task 6 — The runs list and other popovers open as sheets (#185)

Depends on the shared phone rules task. Changes `RunsBadge.tsx`,
`Environments.tsx`, `styles.css`.

- `RunsBadge`: extract the list into `RunsList({ running, onPick })`. When
  `useIsPhone()` is true, open it inside `<Sheet title="Running now">`;
  otherwise keep the `.runs-pop` popover. The outside-click and Escape
  listeners stay for the popover only (the sheet has its own).
- `.runs-pop` on tablet gets `max-width: min(28rem, calc(100vw - 2rem))`
  and drops `min-width: 20rem` below that, so it can never leave the screen
  at 768px either.
- Environments: the pull-request list (`.env-pulls-pop`) uses the same
  pattern — sheet on phones, popover elsewhere. `.env-pulls-btn` gets the
  44px target on phones (Task 1 rule).
- The other drawers (`IssuePeek`, More, the Environments detail panel,
  Shape's requirement panel) already use `Sheet` and need no change.
- Unit test in `RunsBadge.test.tsx`: with a phone `matchMedia` stub the list
  opens as a dialog inside `.sheet`; with a desktop stub as `.runs-pop`.

## Task 7 — Shape and Investigate: the chat fills the phone screen (#186)

Depends on the shared phone rules task. Changes `Shape.tsx`, `styles.css`.

- Extract the `<aside className="shape-list">` body into
  `ConversationList({ kind, onPick })`.
- On phones (`useIsPhone()`): do not render the aside. The page head gets a
  `Conversations` button (44px) that opens `<Sheet title="Conversations">`
  with `ConversationList`; picking a conversation or starting a new one
  closes the sheet. The "start" controls (product pick, new conversation)
  live in the same sheet, so nothing is lost.
- On phones `.shape` is one column and `.shape-chat` takes the full width.
  With no conversation open, the page shows the start prompt and the
  Conversations button, never an empty column.
- Tablet keeps today's stacked layout; desktop keeps the list beside the
  chat (D6).
- Unit test in `Shape.test.tsx`: phone stub — no list in the page, a
  "Conversations" button that opens a dialog with the conversations.

## Task 8 — Shape and Investigate: typing with the keyboard open (#187)

Depends on the chat fills the phone screen task. Changes `Shape.tsx`,
`src/lib/screens.ts`, `index.html`, `styles.css`.

- `index.html` viewport meta adds `interactive-widget=resizes-content`, so
  Android Chrome shrinks the page for the keyboard (D7).
- `useVisibleHeight()` in `screens.ts`: reads `window.visualViewport.height`
  (falls back to `innerHeight`), updates on `resize`, and writes it to
  `--vv-h` on `document.documentElement` while mounted.
- On phones `.shape-chat` becomes a flex column with `height: calc(
  var(--vv-h, 100dvh) - var(--chat-top))`, where `--chat-top` is the
  measured top of the chat; `.shape-messages` is `flex: 1; overflow-y:
  auto` (replaces the `100vh - 20rem` guess); `.shape-composer` is the last
  child, so it is always on screen.
- While the composer has focus on a phone, the shell gets the class
  `keyboard-open`, which hides the bottom nav (the keyboard covers that
  space anyway, and on iPhone the nav would otherwise sit between the
  keyboard and the composer). On focus and on each `--vv-h` change, scroll
  the latest message into view with the existing `endRef`.
- The remove-image button on a thumbnail becomes a 44×44 button
  (`.shape-thumb button { width: var(--target); height: var(--target); top:
  -12px; right: -12px; background: transparent }`) with the visible 20px
  circle drawn by a `::before`, so it looks the same and is easy to hit.
- Edge: a browser without `visualViewport` uses `100dvh`, which is correct
  on Android and only too tall on very old iPhones.

## Task 9 — The 360px and accessibility checks for every screen (#188)

Depends on every screen task: the action bars task, the Settings and
Onboarding task, the remaining screens task, the popovers task and the
keyboard task. Changes `apps/web/e2e/`, `playwright.config.ts`,
`styles.css`.

- **Real app, recorded answers (D8).** New `e2e/phone.spec.ts` opens the real
  app (`/`, served by the Vite server Playwright already starts) and
  answers every `/api/**` request with `page.route` from
  `e2e/fixtures/api.ts`: a map from path (and query) to JSON, typed against
  `src/types.ts`. It covers `/api/me` (signed in, one org, admin), `/api/
  setup/status`, and what each route below reads. A request with no
  recorded answer gets a 404 and is listed in the test's annotations.
- **Route list.** `e2e/routes.ts` lists every `<Route path>` in
  `src/App.tsx` with a concrete URL (ids from the fixtures) and a `ready`
  text that must be visible before checking, so a route that rendered an
  error banner cannot pass. A Vitest test (`src/routes.test.ts`) reads
  `App.tsx`, extracts the paths and fails when one is missing from
  `routes.ts`, so a new route cannot skip the checks.
- **Per route at 360×800 (D9):** (1) `scrollWidth - clientWidth ≤ 1` on the
  document, and no visible element in `main` ends past the right edge
  unless it sits inside a scroll box; (2) axe with tags `wcag2a, wcag2aa,
  wcag21a, wcag21aa`, zero violations; (3) every visible `button, a.button,
  select, summary, [role=button]`, text input and checkbox label is at
  least 44×44. Each is its own `test()` named `<route> — <check>`, so the
  failure names the route.
- **Shell checks:** the bottom nav is one row (all five items share one
  `top`) with the five names in order; More lists Activity; on Settings
  with a changed field and on a gate screen, the bar's rectangle and the
  nav's rectangle do not overlap; the runs list opens as a sheet inside the
  screen; in Shape, the remove-image button is ≥44×44 and "Conversations"
  opens the list; with the composer focused and a 300px-shorter viewport,
  the composer and the last message are visible.
- **Remove the clip (D4).** Delete `html, body { overflow-x: hidden }` in
  this task. If a route then fails, fix it here; it is a missed case.
- **Existing checks.** Bring `e2e/ux.spec.ts` up to date (the nav link is
  "Work", not "My work") and widen `testMatch` to `/\.spec\.ts$/`. Use
  Chromium only.
- `apps/web/package.json` script `test:e2e` stays `playwright test`.

## Task 10 — CI runs the phone checks (#189)

Depends on the checks task. Changes `.github/workflows/deploy.yml`.

- In the `check` job (`typecheck-test-build`), after `pnpm test`, add (D10):
  - cache `~/.cache/ms-playwright` keyed on the Playwright version in
    `pnpm-lock.yaml`;
  - `pnpm --filter @console/web exec playwright install --with-deps
    chromium`;
  - `pnpm --filter @console/web test:e2e` with `CI=true`.
  - On failure, upload `apps/web/playwright-report` and `test-results` as an
    artifact (7 days).
- The Playwright list reporter prints each failing test as `<route> —
  <check>`, so the failed run names the route in the job log.
- Budget: Chromium install about 40s cached, the checks about 60–90s. If the
  job grows past 12 minutes, run the three-width harness tests at 360px
  only in CI (`--grep`), as the task allows; the route checks are 360px
  only already.
- A docs-only pull request still runs the job, as today; the checks pass on
  it.

## Scenario coverage and failure modes

| Spec scenario | Built by | Checked by | Failure mode covered |
|---|---|---|---|
| Nav on a phone | the bottom nav task | shell checks | a long label or the Decisions count cannot add a row (fixed height, ellipsis) |
| Settings save bar on a phone | the action bars task | shell checks | no bar uses a guessed nav height |
| Settings rows on a phone | the Settings and Onboarding task | route checks | long repo names wrap instead of pushing the time out |
| Every route checked | the screen tasks | route checks + route-list test | a new route without an entry fails the unit test |
| Runs popover on a phone | the popovers task | shell checks | popover on tablet capped to the screen width too |
| Removing an attached image | the keyboard task | shell checks | — |
| Typing a message on a phone | the keyboard task | shell checks (simulated by a shorter viewport) | no `visualViewport` → `100dvh` |
| Finding past conversations | the chat fills the screen task | shell checks | no conversation open → start prompt, not an empty column |
| A screen stops fitting | the CI task | the CI job | report uploaded on failure |

## Rollout and rollback

- Every merge to `main` deploys production. Order: shared rules → bottom nav
  → (action bars, Settings and Onboarding, remaining screens, popovers,
  chat) → keyboard → checks → CI. Each step only improves a screen; the
  page clip stays until the checks task, so no step makes a screen pan.
- Rollback is a revert of the one task PR. No data or API is involved. The
  CI task can be reverted alone if the checks prove flaky, without losing
  any layout fix.

## Open questions

- The keyboard behaviour on iPhone Safari is designed from the browser's
  documented behaviour, not seen on a device. The check simulates it with a
  shorter viewport. A person should try Shape on an iPhone once the keyboard
  task lands.
