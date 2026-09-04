# Bugs on the Epic: Report One, See Them, Confirm the Repair

## Why

`add-bug-reporting` in `claude-software-factory` gives an epic a third kind
of child (FACTORY.md §4c): a `bug(<epic>)` report a tester raises against
code the factory has built and not yet shipped, with an ordinary
`task(<epic>): fix bug #<n>` filed to repair it onto the epic branch.

Without the Console's half, three things break in the place testers actually
work:

1. **The report reads as a task.** A `bug(` sub-issue is a child of the epic,
   so with no `bug` kind it lands on the task board — in a column, with a
   start control, inflating every count a reader takes from the board. And
   the task that *fixes* it is already there, so the same work is counted
   twice.
2. **The states have no answers.** `factory:bug-open`, `factory:bug-retest`
   and `factory:bug-verified` are unknown labels: the state derivation drops
   them, every report renders as "Held", and the "what now?" line — the whole
   point of which is the states that wait on a person — says nothing.
3. **Raising one means leaving.** The tester exercising the epic is on the
   Tests tab; reporting what they found means going to GitHub and typing a
   control whose exact shape they have to remember.

## What Changes

- **A `bug` issue kind** and the three states in `@console/core`: the label
  table (so onboarding creates them), phases, state sentences, next-mover
  lines and the "what now?" answers. `factory:bug` is registered as a *kind*
  marker so it can never win state derivation.
- **The rollups split three ways.** Code tasks, cases, and now reports —
  each counted apart, so the task that fixes a bug is code (it is) and the
  report is not.
- **The Tests tab grows a Bugs section**, under the cases and on the same tab
  because they come out of the same hour of somebody's work: reports grouped
  by what they wait on, the fix task named on each, and the tab label
  carrying open bugs beside the pass count.
- **Report a bug** — a title and a report, posted as one `Bug` comment as the
  acting user. One comment because that is the one factory control that reads
  past its own line, and the report is required for the same reason.
- **The re-test verdict** reuses the case's Pass/Fail control on a report at
  `factory:bug-retest`, because the factory reuses the same two words.
- **Gate GS shows the bugs** beside the test matrix — where the factory does
  not hold the gate (advisory, or no epic branch) the approver is the one
  deciding a known defect may reach staging, and they cannot decide it
  unseen.
- **`bug_reports` is mirrored** onto the repo row from
  `.github/factory-testing.json`, with the same three answers the test policy
  has: on, off, and not read yet.

## Impact

- New column `repos.bug_reports` (migration `0015`), nullable — unread.
- `GET /api/epics/:id` grows a `bugs` block; `rollup` grows `bugs`; the gate
  payload grows `bugs` and `bugsOpen`.
- New endpoint `POST /api/epics/:id/bugs`; `POST /api/issues/:id/test-verdict`
  now also accepts a report at `factory:bug-retest`.
- No behaviour changes for a repo without the policy: with `bug_reports`
  false or unread and no reports projected, every screen renders as it did.
