# Create a repository for a new product

## Why
Shape can shape a new product with no repository (scope `new`), but opening it
as work needed an existing repository: a person had to create one on GitHub,
connect it in Onboarding and run every setup step before the first epic could
open.

## What Changes
- **Open as work → "A new repository for this product"** (default for a new
  product): pick the account (your own, or an organisation the Compass App is
  installed on), the name (from the title) and private/public.
- Compass creates it **as the person** (`POST /user/repos` or
  `/orgs/{org}/repos`, `auto_init`), then, with the App's token: commits the
  factory's files onto the default branch (no setup PR: an empty repository
  has nothing to review), cuts `staging` from it, creates the labels, and
  queues OpenSpec's scaffold. It registers the repository in a new project
  named after the idea with the factory on, and opens the requirement there.
- The profile says the stack is **not chosen yet**; the first epic's design
  chooses it and the scaffolding task fills the profile (claude-software-factory
  FACTORY.md §2c, "A new repository").
- The Compass App asks for **Administration: write**. An existing App gets it
  only when its owner adds it in the App's settings and the installation
  accepts it.

## Out of scope
- Templates or starter code: the factory's design chooses the stack.
- Repositories on the GitHub Actions engine: no Actions secrets are written.
- Adding the repository to an installation on selected repositories (the
  result says to add it on GitHub and finish on Onboarding).
