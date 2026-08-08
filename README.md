# Software Factory View — Factory Console

A web application that sits on top of the [Software Factory](https://github.com/genai-jerry/claude-software-factory)
and gives the humans in the loop one place to set it up, configure it, staff it,
and — above all — **review and decide without drowning**.

It is a lens and a control panel over GitHub. It is never a second source of
truth: GitHub stays the state machine, OpenSpec stays the content, and every
Console action materialises as a GitHub operation the factory already
understands.

## Status

**Planning.** No application code yet. This repository currently holds the
implementation plan derived from the Factory Console product specification
(v1.0 draft, August 2026).

## Where to start

| Document | What it answers |
|---|---|
| [`docs/plan/00-overview.md`](docs/plan/00-overview.md) | What we are building, how the plan is organised, naming and terminology |
| [`docs/plan/01-feature-inventory.md`](docs/plan/01-feature-inventory.md) | Every feature in the spec, catalogued with an ID, pillar, phase and GitHub materialisation |
| [`docs/plan/02-architecture-baseline.md`](docs/plan/02-architecture-baseline.md) | Stack, monorepo layout, the token model, tenancy, and the invariants that must hold |
| [`docs/plan/03-data-model-and-ingestion.md`](docs/plan/03-data-model-and-ingestion.md) | Schema build order, projections vs Console-native, the ingestion contract |
| [`docs/plan/04-delivery-plan.md`](docs/plan/04-delivery-plan.md) | Phases → epics → task slices, sequencing, exit criteria |
| [`docs/plan/05-decisions-and-risks.md`](docs/plan/05-decisions-and-risks.md) | Decisions needed before coding, risks, and how each is mitigated |

## The one-line thesis

The factory scaled the production of artifacts; nothing scaled their
consumption. A gate approver reconstructs state from six GitHub surfaces before
they can responsibly type `Approved`. That reconstruction cost — not agent
quality — is the bottleneck this product removes.
