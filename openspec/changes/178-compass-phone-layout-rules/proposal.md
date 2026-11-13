## Why

Compass screens added since the phone layout was built don't follow it. On phones
the bottom nav holds six items (Work, Decisions, Activity, Shape, Investigate,
More) in a four-column grid (`apps/web/src/components/Shell.tsx`,
`.bottom-nav` in `apps/web/src/styles.css`), so it wraps to two rows and sticky
action bars cover the second row. The page hides sideways overflow
(`html, body { overflow-x: hidden }`), so content that is too wide — a
repository name and time on a Settings row, for example — is cut off with no
way to scroll to it. The phone checks in `apps/web/e2e/` run against static
stubs and no CI workflow runs them, so nothing catches a screen that stops
fitting.

Two earlier changes (`mobile-ux-redesign`, `console-ux-hardening`) built the
phone shell and its rules. This change extends those rules to the screens added
since (Shape, Investigate, Settings, Tools, Models, Environments, Runs) and
makes CI enforce them for every route.

## What Changes

- Bottom nav keeps at most 5 items on phones (Work, Decisions, Shape,
  Investigate, More). Activity moves into More.
- Action bars and save bars sit above the nav and never cover it.
- Content that is too wide wraps or scrolls inside its own box. It is no longer
  cut off.
- The app uses three screen sizes only: phone under 768px, tablet 768–1023px,
  desktop 1024px and up.
- Popovers and drawers, including the runs popover opened from the header
  (`RunsBadge`), open as sheets on phones.
- In Shape and Investigate, the conversation list moves behind a
  "Conversations" button, the composer stays visible while the keyboard is
  open, and the button that removes an attached image is 44px.
- Every route gets a 360px no-sideways-scroll check and an accessibility
  check, and CI runs both and fails the build when either fails.

## Capabilities

### New Capabilities

- `console-phone-layout`: the rules every Compass screen meets in a phone
  browser, enforced by automatic checks.

### Modified Capabilities

None. (`openspec/specs/` is empty — the earlier phone-layout changes were
never synced into main specs — so this capability is added, not a delta.)

## Impact

- Repositories: genai-jerry/software-factory-view only — the web app
  (`apps/web`: shell nav, global styles, shared layout classes, the Settings,
  Onboarding, EpicWorkspace, Tools, IssuePeek, Shape and Investigate screens
  and the runs popover), the phone end-to-end tests under `apps/web/e2e`, and
  the CI job that will run them.
- APIs: none.
- Data and privacy: none. Layout and tests only — no new data is collected or
  stored, and no phone-usage analytics are added.

## Non-goals

- No new UI library.
- No change to what the screens do. Only their layout changes.
- No phone-usage analytics.

## Interpretations taken

1. "Every screen" means every route the app defines today.
2. Activity moves into the More sheet so the nav fits on one row.
3. A 360px-wide screen stands in for the smallest phone the app must support.
4. Screens may still scroll sideways inside a table or data box, but the page
   itself never does.
5. The two findings the investigation was less sure of — the runs popover
   going off the screen edge and the keyboard hiding the Shape composer — are
   treated as requirements either way: the popover opens as a sheet and the
   composer stays visible, whether or not the defect reproduces today. (Both
   pieces of UI were confirmed in the code during intake.)
6. With no usage data to say which screens phone users open most (the issue's
   first open question), every route is in scope and the order the screens are
   fixed in is left to planning.
