# 03 · Data Model and Ingestion Plan

Two schema areas with **different lifecycle guarantees**, and no table that
mixes them. This separation is the single most important structural property of
the database: it is what lets "drop the projections and rebuild" be a routine
operation rather than a disaster recovery drill.

## 1. Projections (rebuildable, never backed up)

Every projection row carries `tenant_id`, the GitHub `node_id` as natural key,
and `gh_updated_at` for last-writer-wins against out-of-order delivery.

### Estate / repo

| Table | Key fields | Notes |
|---|---|---|
| `estates` | `tenant_id`, `name`, `coordination_repo_id` | An estate = the set of repos one factory install spans. One tenant may run several |
| `repos` | `estate_id`, `gh_node_id`, `full_name`, `default_branch`, `staging_branch`, `factory_enabled`, `profile_sha` | `staging_branch` / profile facts denormalised from the last-fetched `.factory/profile.json` |

### Pipeline objects

| Table | Key fields | Notes |
|---|---|---|
| `issues` | `repo_id`, `number`, `title`, `state`, `author`, `kind` (epic \| task \| plain), `parent_issue_id`, `factory_state`, `gh_updated_at` | `kind` derived: has sub-issues + factory label → epic; `task(...)` title / sub-issue link → task. `factory_state` = the current `factory:*` label (exactly one) |
| `issue_state_history` | `issue_id`, `from_state`, `to_state`, `actor`, `source_event_id`, `occurred_at` | **Append-only.** Built from `labeled`/`unlabeled` events. Powers the timeline rail, cycle-time analytics and the gate-latency baseline |
| `comments` | `issue_id`, `gh_node_id`, `author`, `body`, `is_agent`, `console_markers` jsonb, `created_at` | `is_agent` from `<!-- factory-agent -->`; `console_markers` = parsed `<!-- console:… -->` structure so threading survives a rebuild |
| `pull_requests` | `repo_id`, `number`, `kind` (spec \| design \| task \| promotion \| other), `issue_id`, `head_ref`, `base_ref`, `state`, `draft`, `mergeable`, `ci_status` | `kind` derived from branch naming: `factory/<n>-spec`, `factory/<n>-design`, `factory/<n>-<slug>`, `staging→main` |
| `pr_reviews`, `pr_review_comments` | `pr_id`, `author`, `state`, `body`, `path`, `line` | Line-level agent/human review remarks |
| `runs` | `repo_id`, `workflow`, `role`, `trigger_event`, `conclusion`, `gh_run_id`, `log_excerpt_url`, `started_at` | One row per factory-pipeline run; `role` parsed from run inputs/log so a workspace can say which agent acted and why |

### Artifacts

| Table | Key fields | Notes |
|---|---|---|
| `artifact_cache` | `repo_id`, `path`, `commit_sha`, `content`, `fetched_at` | Immutable per `(path, sha)`; content encrypted at rest |
| `changes` | `estate_id`, `epic_issue_id`, `slug`, per-repo folder paths, `status` (active \| archived) | The OpenSpec change folder as an entity; discovered from spec-PR file lists |
| `change_artifacts` | `change_id`, `repo_id`, `kind` (proposal \| spec \| design \| tasks), `path`, `latest_sha`, `merged_sha` | Tracks "as proposed" (branch tip) **and** "as approved" (merged) refs — **the gate panel diffs these** |

## 2. Console-native (backed up)

### Identity & access

| Table | Key fields |
|---|---|
| `orgs` | `name`, `plan`, `billing_customer_id`, `insight_budget` |
| `users` | `gh_user_id`, `login`, `name`, `avatar`, `encrypted_oauth_token` |
| `memberships` | `org_id`, `user_id`, `role` (owner \| admin \| member \| viewer) |
| `gate_assignments` | `estate_id`, `repo_id` (nullable), `gate` (spec \| design \| implementation \| release), `user_id`, `synced_from_sha` |

`synced_from_sha` is what makes drift detectable: the mirror knows which commit
of `factory-approvers.json` it reflects, so a direct edit is visible as a
mismatch rather than as a silent divergence.

### Workspace overlay

| Table | Key fields |
|---|---|
| `threads` | `epic_issue_id`, `topic_kind` (artifact \| gate \| task \| decision \| free), `topic_ref`, `title`, `status` (open \| resolved), `created_by` |
| `thread_entries` | `thread_id`, `source` (gh_comment \| console_note), `comment_id` (nullable), `body` (nullable), `author`, `created_at` |
| `decisions` | `epic_issue_id`, `thread_id`, `title`, `context`, `options` jsonb, `chosen`, `consequences`, `decided_by`, `gh_comment_id`, `status` (proposed \| decided \| superseded) |
| `qa_conversations` / `qa_messages` | `epic_issue_id`, `user_id`, `visibility` (private \| shared); messages carry `citations` jsonb (source kind, path/sha or comment node_id, line range) |

**GitHub comments are referenced, never copied.** A `thread_entries` row with
`source = gh_comment` holds a `comment_id` and nothing else; the body is read
from the projection. `console_note` rows are private notes deliberately not
posted, and are the only workspace content that a projection rebuild cannot
recover.

### Operations

| Table | Key fields |
|---|---|
| `onboarding_runs` | `estate_id`, `repo_id`, `step`, `status`, `detail` jsonb — resumable wizard state |
| `config_edits` | `repo_id`, `file`, `base_sha`, `proposed` jsonb, `pr_number`, `status` — config-as-PR lifecycle |
| `notifications` / `notification_prefs` | `user_id`, `kind`, `channel` (web \| email \| slack), `delivered_at` |
| `audit_log` | `org_id`, `actor_user_id`, `action`, `target`, `payload` jsonb, `at` — every Console-initiated write, **including the GitHub operation it produced** |
| `webhook_deliveries` | `delivery_guid`, `event`, `processed_at` — idempotency ledger, 30-day retention |

## 3. Derivations to pin down before coding

These are the places where an implementation is likeliest to quietly invent a
second source of truth.

**Epic detection.** An issue is an epic when it (a) carries any `factory:*`
state label and (b) is not a sub-issue of another factory issue. Task issues are
sub-issues of an epic. `factory:fast-track` issues render as lightweight
epics — no change folder, so the workspace shows PR + CI only.

**Pipeline stage** of an epic **is exactly its current label**. The Console
computes nothing. What it adds is *aggregation*: for a `factory:design-approved`
epic, the workspace derives a task rollup (n ready / in-review / in-test / done,
blocked list, dependency graph from sub-issue relationships) — all from
projections, all discardable.

**Attention queue** is a **query, not a table**:

- gates where I am an assigned approver and the epic sits in a `*-ready` state;
- `factory:blocked` issues in my estates;
- task issues awaiting an implementation `Approved` where I am on the
  implementation list;
- release trains awaiting my merge.

Ordered by age. **This query is the product's home page**, so it gets an index
plan of its own rather than being discovered as a performance problem later.

## 4. Schema build order

The order matters because each step unblocks a testable slice.

| Step | Tables | Unblocks |
|---|---|---|
| 1 | `orgs`, `users`, `memberships`, sessions | Sign-in |
| 2 | `estates`, `repos`, `webhook_deliveries` | Installation + ingestion smoke test |
| 3 | `issues`, `issue_state_history`, `comments`, labels | Pipeline board, timeline, **metrics baseline (F-X3)** |
| 4 | `pull_requests`, `pr_reviews`, `pr_review_comments`, `runs` | Workspace substrate |
| 5 | `artifact_cache`, `changes`, `change_artifacts` | Artifact reader + as-proposed/as-approved diff |
| 6 | `threads`, `thread_entries` | Threads (read) |
| 7 | `gate_assignments` | Attention queue "why you" |
| 8 | `audit_log`, `decisions` | Phase 1 write path |
| 9 | `qa_conversations`, `qa_messages` | Phase 2 |
| 10 | `onboarding_runs`, `config_edits` | Phase 3 |
| 11 | `notifications`, `notification_prefs`, billing | Phase 1 / 4 |

Step 3 is deliberately early: `issue_state_history` derived from the existing
label events in `insurance-app-base` is what produces the honest **gate-latency
baseline before any UI ships** (spec §07 7.4).

## 5. Retention & deletion

- Uninstalling the App or deleting an estate **hard-deletes** its projections
  and artifact cache within 24h.
- Console-native data (decisions, Q&A) is **export-then-delete** on org request
  (GDPR-shaped).
- Q&A conversations: retained until deleted by user/org policy, configurable
  auto-expiry, **default 12 months**.
- `audit_log`: retained for the life of the org; export available.
- Raw webhook payloads: 30 days.

## 6. Ingestion implementation notes

- **One queue per concern** (`ingest`, `reconcile`, `prefetch`, `insight`) so a
  slow artifact fetch never delays state projection.
- **De-dupe before work, not after**: the `webhook_deliveries` insert is the
  idempotency gate; a conflict short-circuits the job.
- **Upsert guard**: `… ON CONFLICT (gh_node_id) DO UPDATE … WHERE excluded.gh_updated_at > table.gh_updated_at`.
  Out-of-order delivery then becomes a no-op rather than a regression.
- **Reconciler scope**: per estate, ETag-conditional, backoff-aware, and it
  reports a **drift count** — the health metric for the entire read model. A
  drift count that stops being ~0 is the earliest signal that ingestion has a
  bug.
- **Fixture corpus**: capture a real day of deliveries from `insurance-app-base`
  early and commit it as test fixtures. The reverse-order + duplicate replay
  test (`02` §4) runs against it in CI.
