# 06 · Setting up `.factory/profile.json`

Covers `F-C8` (profile editor) and the hole it was filed against. Read with
`FACTORY.md` §2c (what the profile is) and `03` §1 (where its facts land).

## 1. The problem

Onboarding a repo through the Console runs five steps — labels, secret,
OpenSpec, stubs, validate — and at the end validation says this:

> `.factory/profile.json` missing — implementer/reviewer/qa are hard-blocked
> — `apps/api/src/routes/onboarding.ts:237`

That is not a bug in the check. The enablement PR deliberately does not write a
profile (`onboarding.ts:487`: *"it is the one file whose contents are genuinely
yours"*), and `refreshRepoProfile` keeps `factory_enabled` false until the
profile and the pipeline stub both exist (`apps/worker/src/artifacts.ts:163`).
So a repo the Console reports as onboarded is a repo where every per-repo role
hard-blocks on its first run. The wizard stops one file short of working.

The file cannot be templated away, because its value is that it is *specific*:
eleven role prompts stay byte-identical across an estate precisely because this
one file carries the stack facts. A profile of plausible defaults is worse than
none — a missing profile blocks loudly, a wrong one makes the implementer run
commands that do not exist and the reviewer check conventions the repo does not
follow.

So the profile has to be derived from the code. And the Console must not be the
thing that reads it.

## 2. The constraint, and what it forces

The Console does not fetch repository source, and this plan does not change
that. What it reads today is narrow and named:

| Reads | Where |
|---|---|
| Named config files — `.factory/profile.json`, `.github/factory-*.json`, workflow stubs, issue template | `onboarding.ts` validation, `artifacts.ts` |
| Change-folder artifacts (`design.md`, `tasks.md`), encrypted at rest | `artifact_cache` (`schema.ts:255`) |
| Issue / PR / run **metadata** | ingestion |

Even the OpenSpec step, which runs a scaffold on the Console host, does it in an
empty temp directory and seeds only `CLAUDE.md` — it never clones the repo
(`apps/worker/src/openspec.ts:70`).

Whole-repo reading is the one thing profiling genuinely needs, and it is the one
thing the Console should never acquire. That forces the design rather than
merely suggesting it: **the drafting runs where the code already is — the repo's
own GitHub Actions runner — and the Console only ever sees the result.**

This is the same trade the secret step already makes: onboarding writes
`ANTHROPIC_API_KEY` straight to the repo so it never passes through Console
storage. The factory is built for exactly this shape — eleven roles already run
as agents inside the consuming repo's runner, with role prompts injected from
`claude-software-factory` cloned into `RUNNER_TEMP`.

## 3. Design

A twelfth role, **Profiler**, in the factory repo. It is the only role whose
Step 0 is not "read the profile" — it is the role that writes it.

```
Console                     GitHub                      Repo's runner
   |                           |                              |
   |-- open issue + label ---->|                              |
   |   (as the signed-in user) |-- caller stub fires -------->|
   |                           |                     profiler role:
   |                           |                     reads the code,
   |                           |                     RUNS test/build/lint,
   |                           |                     writes the profile
   |                           |<-- PR + issue comment -------|
   |<-- webhook: PR merged ----|                              |
   |   refreshRepoProfile: profile_sha, staging_branch,       |
   |   factory_enabled = true                                 |
```

The Console's whole part is: check the preconditions, file one issue, and
report. It never fetches source, never runs the agent, never merges the PR.

### 3a. Why an issue and a label, not `workflow_dispatch`

The obvious trigger is `workflow_dispatch` — the caller stub already exposes
`role` and `issue_number` inputs. It is the wrong one here.

| Option | Cost |
|---|---|
| `workflow_dispatch` via the API | Needs `actions: write` on the App. The manifest asks for `actions: read` (`packages/core/src/credentials.ts:165`), so **every existing installation would have to approve a permission bump** — and it hands the Console the ability to run any workflow in the repo, for one feature |
| Push a commit to fire a `push` trigger | Works with `contents: write`, but it is a side effect masquerading as a signal and it litters history |
| **Open an issue carrying a trigger label** ✅ | Uses `issues: write`, which the Console already holds and already uses. Costs one label and one router mapping |

The issue is not a workaround, it is where this belongs. Every other role is
issue-shaped: the run's trace goes there, `factory:in-progress` marks it while
the agent works, a human replies to it if the draft is wrong, and the
"Approved" convention already exists for acting on what a role produced. A
profile drafted with no issue behind it would be the one agent run in the system
with nowhere to argue with it.

The Console files it **as the signed-in user** (`UserClient.createIssue`,
`github.ts:462`), consistent with "every action here is a GitHub operation under
your own identity", and so the run is attributable to a person.

### 3b. What makes the draft trustworthy

The profile is *authoritative* for eleven roles, so a plausible-but-wrong
profile is the failure mode that matters. Three rules, enforced in the prompt:

1. **Run what you record.** Every command written to `commands` must have been
   executed in the run. A `test` command that was not run does not go in the
   file — `null` is a supported value and means "this repo has no such gate".
2. **A failure observed is a `gotcha`, not a silence.** Pre-existing test
   failures are exactly what that field is for (see the worked example in
   `templates/profile.example.json`). A profiler that hides them produces an
   implementer that blames its own delta.
3. **Cite evidence per field in the PR body.** `stack` from the manifest files,
   `conventions` from paths actually sampled, `branches.staging` from the
   branch list. A field with no evidence is omitted, never guessed.

And the Console does not auto-merge the PR. A human reads the draft; that review
is the point at which the repo's owner confirms the facts the factory will treat
as true from then on.

## 4. Staying current

"Once the profile is added, it should be updated for the repo" is the half that
decides whether this stays useful. Three mechanisms, in increasing cost:

| Trigger | Mechanism | When it earns its run |
|---|---|---|
| **On demand** | The Console re-applies the label ("Redraft profile"). The profiler reads the existing profile first and opens a PR only if a *verified* fact changed | After a stack change the team already knows about |
| **On drift** | `push` on the default branch with a `paths:` filter — manifests, lockfiles, CI config, tool config — running the profiler in verify mode: re-run the commands, re-check the branches, PR only on disagreement | The stack moved without anyone thinking about the profile. This is the one that keeps it honest |
| **On repeated failure** | A role that hard-blocks on a profile fact (a command that does not exist, a branch that is gone) proposes the profile fix on its issue | `FACTORY.md` already states the doctrine — *"if a role gets something wrong twice, the fix belongs in this file"* — but making it mechanical is a prompt change across eleven roles. Defer |

A silent no-op run is a requirement, not a nicety: if the drift check comments
or PRs when nothing changed, it gets muted within a week and the mechanism is
dead.

## 5. Work breakdown

### 5a. `claude-software-factory`

| # | Change | Notes |
|---|---|---|
| 1 | `commands/profiler.md` | The role. Step 0 inverted (no profile to read); the three trustworthiness rules; validate against `templates/profile.schema.json` before writing; open a PR, comment the evidence |
| 2 | `.github/workflows/factory-pipeline.yml` | Route the trigger label → `profiler`; **exempt this role from the missing-profile hard-block** (§2c) — otherwise the role that creates the profile is blocked by its absence |
| 3 | `templates/workflows/factory-pipeline.yml` | Add `profiler` to the `workflow_dispatch` choice list |
| 4 | `scripts/setup-labels.sh` | The trigger label (19 → 20) |
| 5 | `templates/factory-models.json` | A `profiler` entry — a whole-repo read wants a strong model |
| 6 | `FACTORY.md` §2c + setup step 5, `docs/setup-guide.md` | Step 5 becomes "run the profiler, review its PR", with hand-authoring as the documented fallback |

**Version pinning matters here.** Consuming repos pin the reusable workflow at
`@v1`, so the router change reaches them only when that tag moves. The label
path then works everywhere at once; the `Run workflow` dropdown lags until each
repo's stub is refreshed. Acceptable asymmetry — the Console drives the label
path — but it means the tag move is part of shipping, not after it.

### 5b. `software-factory-view` (the Console)

| # | Change | Notes |
|---|---|---|
| 1 | `POST /api/repos/:id/onboarding/profile` | New step between `stubs` and `validate`. Preconditions **checked, not assumed**: pipeline stub present *on the default branch* (`onboarding.ts:212`), the Actions secret present (`:233`), labels created. Each failure names its own fix |
| 2 | Idempotence, matching the other steps | Profile already on the default branch → `{ ok, found: true }`, nothing written. An open profile issue or PR → return that, do not file a second |
| 3 | Completion without polling | The profile PR merge already arrives as a webhook and `refreshRepoProfile` already updates `profile_sha` / `staging_branch` / `factory_enabled`. The step flips to `ok` when the profile appears — no new plumbing |
| 4 | `apps/web/src/pages/Onboarding.tsx` | Step card with links to the issue, the run and the PR. The OpenSpec step's `refetchInterval` pattern already exists for in-flight steps |
| 5 | Extend the `profile` validation check (`:237`) | Today: parses + required keys. Add: which optional sections are empty. A profile with no `gotchas` and no `conventions` is schema-valid and practically useless, and the operator should see that before they call the repo done |

Ordering is forced: labels → secret → stubs **merged to the default branch** →
profile. A workflow that is not on the default branch cannot fire, so the step
must refuse to file the issue before then rather than filing one that sits there
doing nothing.

## 6. Decisions

| ID | Decision | Recommendation |
|---|---|---|
| **P-1** | Trigger label name | `factory:profile`. The router's existing trigger labels read as states (`factory:spec-approved`); `factory:profile-requested` is more consistent but longer. Low stakes, pick one and put it in `setup-labels.sh` |
| **P-2** | Does the drift check ship with v1? | **Yes.** Without it this is a one-shot draft that rots, which is the thing the user asked not to build. It is a `paths:` filter and a verify-mode branch in the same prompt |
| **P-3** | Scheduled backstop as well as the path filter? | **Not in v1.** A weekly cron burns a full agent run on quiet repos; the path filter catches the drift that is visible in the tree. Revisit if real profiles go stale in ways no path predicted |
| **P-4** | Does the Console offer a manual editor too (the original F-C8 scope)? | **Later.** The generated-then-reviewed path covers the case; a form that edits a file the Console cannot verify against the code is a worse version of editing it in GitHub |
| **P-5** | Should the profiler run automatically at the end of onboarding? | **No — one button.** The first run costs real tokens against the user's own key, and an agent that starts reading the whole repo unasked is a surprise |

## 7. Risks

| Risk | Mitigation |
|---|---|
| A confident, wrong profile — the failure mode that matters, since eleven roles treat it as authoritative | §3b: run what you record, evidence per field, human merges the PR. The Console must never auto-merge |
| Cost and wall-clock on a large monorepo | Model routing via `factory-models.json`; prompt scopes the read (manifests and CI first, then sample by directory) rather than walking the tree |
| The run fails and the Console cannot say why — it holds `actions: read`, so it sees the conclusion, not the log | Check the secret and the stub *before* filing the issue, so the common failures never become a red run. Link the run; the log is one click away in GitHub, where it should be |
| Trigger label collides with a repo's existing labels | The labels step already handles create-or-update (`createLabel`, `github.ts:324`) |
| The drift check becomes noise | Silent no-op is a requirement (§4), not a polish item |
