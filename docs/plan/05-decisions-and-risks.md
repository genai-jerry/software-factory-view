# 05 · Decisions Needed, Risks and Mitigations

## 1. Decisions needed before or during Phase B

Each one is stated with a recommendation, so none of them needs a meeting to
unblock — but each should be confirmed.

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| **D-1** | Product and repo name. The spec's working name is `factory-console`; this repo is `software-factory-view` | Keep `software-factory-view` as the repo, use **Factory Console** as the product name. It affects only branding strings and the GitHub App slug | Nothing (App slug by E0.1) |
| **D-2** | GitHub App ownership: personal account vs a GitHub organisation | Register under an **org**, even for the dogfood. Moving an App between owners later invalidates installations | E0.1 |
| **D-3** | Hosted-first or self-host-first | **Hosted-first.** Self-host is Phase 4 and runs the identical images, so nothing is thrown away | E-B1 (deploy target) |
| **D-4** | Does the Console's own development run through the factory? | **Yes** — the spec calls for it, and it is the fastest way to find `F-O*` requirements. E-B2 exists for this | E-B2 |
| **D-5** | Drizzle vs Prisma | **Drizzle** — the projection upsert needs a `WHERE excluded.gh_updated_at > …` guard on the hot path (see `02` §1) | E-B1 |
| **D-6** | Multi-tenancy from commit one, or single-tenant then retrofit | **From commit one.** Retrofitting `tenant_id` into a populated schema and scoping into hand-written queries never gets done properly | E0.1 |
| **D-7** | Where hosted infrastructure runs (Fly.io vs Render vs plain containers) | Either; pick the one whose Postgres and Redis you are willing to be paged for | E-B1 |
| **D-8** | Anthropic billing for the insight service: platform key vs BYO key from the start | **Platform key** in Phase 2, BYO in Phase 4. Metering has to exist either way | E2.1 |
| **D-9** | Q&A default retention | 12 months, per the spec, configurable per org | E2.1 |
| **D-10** | Whether Phase 0 targets `insurance-app-base` only, or the whole estate | **`insurance-app-base` only.** One repo is enough to validate the read model, and the cross-repo paths (F-W17, F-O4) get their own attention in Phase 1/3 | E0.1 |

## 2. Risks

Carried from the spec's §07 6 and extended with risks this plan introduces.

| Risk | Why it is serious | Mitigation |
|---|---|---|
| **Two-sources-of-truth creep** — the standing temptation to store "just this one" authoritative field Console-side | It is the failure that would make the whole product untrustworthy, and it arrives one reasonable-looking field at a time | The `02` §8 invariants are CI-tested: a lint that no write endpoint touches projection tables; **every feature spec must name its GitHub materialisation** (which is why `01` has that column) |
| **Webhook loss / ordering bugs corrupt the read model** | Silent corruption in a review tool means someone approves against a stale picture | Idempotent upserts with a `gh_updated_at` guard, reconciler, projections rebuildable by design. The reverse-order replay test and the truncate-and-rebuild test both run in CI. Corruption is repairable, not fatal |
| **GitHub API rate limits on large estates** | Reconciliation and artifact prefetch are both chatty | Per-estate installation-token budgets, conditional requests (ETags), SHA-keyed immutable artifact cache, reconciler backoff |
| **Insight answers wrong at a gate → misplaced trust** | The one place where a plausible-but-wrong summary does real damage | Citations mandatory; advisory framing; **full artifacts always adjacent**; the "approve anyway" guard is about open *human* questions, not model output |
| **Marker-comment scheme collides with factory automation** | Would break the pipeline for everyone, Console user or not | Markers namespaced (`console:*` vs `factory-agent`); the factory's triggers match exact bodies (`Approved`) or human-vs-agent authorship, both unaffected — verified against `factory-pipeline.yml`. A **conformance test enumerating known markers** ships in this repo and is mirrored upstream |
| **Console user without GitHub repo access sees private code** | A security incident, not a bug | Visibility-floor re-checks (F-U9); artifact content served only after a per-user repo-access check. Note this is a **Phase 4 feature** — until then the Console must be run only with users who already have estate-wide access, and that constraint belongs in the beta gating criteria |
| **A paid product atop an MIT pipeline invites a free clone** | Real, and unavoidable by design | The moat is the read model + review UX + trust details, not the idea. Move fast in beta, keep the factory community healthy |
| **Solo-maintainer bandwidth** | The most likely reason this stalls | Phase B/0/1 are one coherent slice; every later phase is independently shippable; the stack is chosen for operational boredom |
| **Phase 0 has no writes, so nobody notices it is wrong** *(added)* | A read-only tool can be quietly inaccurate for weeks | The Phase 0 exit criterion is a **real G2 review conducted entirely from the workspace**. That is a use, not a demo — an inaccuracy shows up as a wrong approval decision the reviewer catches |
| **Onboarding automation writes to customer repos** *(added)* | Labels, secrets and PRs on someone else's repo, from a wizard | Every step idempotent and reporting found/created/fixed; the enablement PR is **never merged by the Console**; the validation suite makes **no writes** on a healthy repo; permission gaps are named, not swallowed |
| **The gate panel becomes a place people approve without reading** *(added)* | The exact opposite of the product's purpose | The full artifacts are always shown, never only a brief; the open-questions guard requires an explicit recorded acknowledgement; `[≡ raw]` click-through is tracked as a **trust** metric, not a failure metric |

## 3. Open questions for the spec author

Genuine gaps, not restatements — each one changes an implementation decision.

1. **Thread digest threshold.** The spec says "threads with > *n* entries". What
   is *n*? Recommend 15, configurable per org.
2. **"Last time you looked" semantics (F-W12).** Is the diff baseline the
   reviewer's last *visit* to the workspace, or their last *gate action*? These
   diverge for a reviewer who browses before approving. Recommend: last gate
   action if one exists, else last visit, and label which is being shown.
3. **Fast-track epics in the attention queue.** `factory:fast-track` issues have
   no gates. Do they appear in the queue at all? Recommend: only when blocked or
   awaiting merge.
4. **Multi-estate tenants and gate assignments.** `gate_assignments` carries a
   nullable `repo_id`, implying estate-wide assignments — but
   `factory-approvers.json` is per repo. Which wins when they disagree, before a
   config PR has merged? Recommend: the file, per repo, always; the estate-level
   record is a template for generating it.
5. **Console-authored comments when identity attribution is off.** §02 1 says
   the app may author thread replies "when the user opts out of identity
   attribution — default is off". Is that opt-out in scope for Phase 1? It
   interacts with F-P13 and the audit trail. Recommend: defer past Phase 1.
6. **Canary cleanup.** The canary issue traverses the full pipeline and produces
   a merged PR adding `FACTORY_CANARY.md`. "Deletable afterwards" — does that
   include reverting the merged commit? Recommend: yes, offered as a one-click
   revert PR.
7. **Baseline honesty window (F-X3).** The gate-latency baseline is derived from
   `issue_state_history` on `insurance-app-base`. How many epics of history
   exist? If it is a handful, the baseline is a number with no error bar and
   should be reported as such.

## 4. What would make this plan wrong

Stated deliberately, because a plan that cannot be falsified is not a plan:

- If the Phase 0 exit criterion (a real G2 review conducted entirely from the
  workspace) **cannot** be met, the read model is missing something the spec did
  not anticipate, and Phase 1 should not start until it is found.
- If the reverse-order replay or truncate-and-rebuild tests cannot be made to
  pass, the rebuildability claim is false and the backup story has to change
  from "only Console-native data" to something larger and more expensive.
- If the marker conformance test finds that `console:*` markers do perturb the
  factory's triggers, the round-trip design needs rework before any Phase 1
  write ships — because the alternative is breaking the pipeline for people who
  do not even use the Console.
