# 00 · Overview

Derived from **Factory Console — Product Specification v1.0 draft** (31 pages,
August 2026, GenAI People), read against the live factory in
`genai-jerry/claude-software-factory` (`FACTORY.md`, `templates/`,
`.github/workflows/factory-pipeline.yml`) and the live test estate
`genai-jerry/insurance-app-base`.

## 1. What is being built

A hosted multi-tenant web application (self-hosted enterprise option) with five
capability pillars:

| # | Pillar | Spec doc | Plan section |
|---|---|---|---|
| 1 | Set up any repository and factory-enable it | 03-onboarding | `F-O*` |
| 2 | Org- and project-specific configuration | 04-configuration | `F-C*` |
| 3 | Org users, roles and access | 05-users-and-access | `F-U*` |
| 4 | Threaded per-issue tracking, Q&A for insight, decision capture | 06-epic-workspace | `F-M*`, `F-W*`, `F-I*` |
| 5 | Roadmap: staging deployment and testing | 07-roadmap | `F-D*` |

Plus the platform the five pillars stand on (`F-P*`), the read-model
derivations (`F-R*`), commercialisation (`F-B*`) and cross-cutting operations
(`F-X*`).

## 2. The two rules everything else follows

**Rule 1 — the Console is a lens.** It ingests GitHub webhooks and repository
artifacts into a *rebuildable* read model. Drop the projection tables, run the
reconciler, and the Console is whole again. Only Console-native data (threads
metadata, Q&A, decisions index, onboarding state, membership, billing) is
backed up.

**Rule 2 — the Console is a control panel, not an authority.** Every mutation
that carries authority executes as a GitHub operation **under the acting user's
own OAuth identity**, so the factory's existing router-side enforcement
(`factory-approvers.json`, `FACTORY.md` §2b) and GitHub's own permission checks
keep working unchanged. The Console adds zero new enforcement paths.

The corollary is a hard product constraint, not a nicety: **anyone not using
the Console loses nothing**. Threads, decisions and approvals posted from the
Console are ordinary GitHub comments carrying hidden structural markers, fully
readable in the GitHub UI.

## 3. How this plan is organised

The plan separates three things that are usually tangled together:

1. **Feature inventory** (`01`) — *what* exists, exhaustively, with stable IDs.
   Every feature names the GitHub object it materialises as, which is the
   discipline that keeps rule 1 honest.
2. **Architecture and data model** (`02`, `03`) — *how* it is built, decided
   once, before any epic is filed.
3. **Delivery plan** (`04`) — *when*, as phases → epics → task slices. Epics are
   deliberately sized to the factory's own constraint (`FACTORY.md` §5: one
   OpenSpec change per epic, max ~10 tasks), because the Console's development
   is intended to run through the factory itself.

Feature IDs (`F-W8`) are stable and referenced from epics; epic IDs (`E1.2`) are
referenced from milestones. Nothing in the delivery plan introduces a feature
that is not in the inventory.

## 4. Naming

The spec's working repository name is `factory-console`; this repository is
`software-factory-view`. This plan uses:

- **Factory Console** (or "the Console") — the product.
- **software-factory-view** — this repository, per the instruction to use it as
  the codebase.

Resolving the name is an open decision (`D-1` in `05-decisions-and-risks.md`);
it changes only branding strings and the GitHub App slug, so it does not block
Phase 0.

## 5. Terminology inherited from the factory

| Term | Meaning |
|---|---|
| **Estate** | The set of repos one factory install spans (`FACTORY.md` §2). One tenant may run several. |
| **Coordination repo** | The estate repo that owns the shared contract; multi-repo epics are filed there. |
| **Epic** | An issue carrying a `factory:*` state label that is not a sub-issue of another factory issue. |
| **Task** | A sub-issue of an epic, one PR each. |
| **G1 / G2 / G3** | Spec-approval gate, design-approval gate, production merge gate. G1/G2 open on a comment of exactly `Approved`; **G3 is a human pressing Merge and is deliberately not comment-approvable.** |
| **Change folder** | `openspec/changes/<epic-issue>-<slug>/` — the content of record. |
| **Factory state** | The single mutually-exclusive `factory:*` label on an issue. There are 14 labels. |

## 6. Test estate

`genai-jerry/insurance-app-base` is already factory-enabled (it carries
`.factory/profile.json`, `.github/factory-approvers.json`,
`.github/factory-models.json`, the caller stubs and an `openspec/` tree). It is
the Phase 0 fixture source and the ongoing dogfood target: real epics, real
gates, real webhook traffic, no synthetic data.
