# Contributing to Compass

Thanks for helping. Compass is the web UI over the
[Claude Software Factory](https://github.com/genai-jerry/claude-software-factory).
Bug reports, fixes, docs and well-scoped features are all welcome.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or file a
  [bug report](https://github.com/genai-jerry/software-factory-view/issues/new?template=bug_report.yml) first if you are not sure it is a bug.
- **Features and anything that changes behaviour:** open a
  [feature request](https://github.com/genai-jerry/software-factory-view/issues/new?template=feature_request.yml)
  first, so we can agree on the approach before you write code.
- **Security issues:** do **not** open a public issue. See [SECURITY.md](SECURITY.md).

### A note on factory automation

This repository is built by the factory itself. Issues from owners, members and
collaborators can start agent runs. Issues from anyone else are left alone
until a maintainer triages them and hands them to the factory. That is
expected, not a sign your issue was ignored.

## Development setup

You need Node.js 20.19+, pnpm 10 (`corepack enable` gives you the pinned
version), and Docker for Postgres and Redis.

```bash
git clone https://github.com/<you>/software-factory-view.git
cd software-factory-view
./scripts/setup.sh     # one-time: .env, install, build, Postgres/Redis, migrate
./scripts/dev.sh       # API + worker + Vite on http://localhost:5173
```

Set `DEV_FAKE_LOGIN=1` in `.env` to browse the UI without registering a GitHub
App. It is read-only, and it must never be enabled in production.

## Before you open a pull request

Run what CI runs:

```bash
pnpm typecheck
pnpm build
pnpm test
```

UI changes also have a Playwright and axe suite at 360, 768 and 1280px:

```bash
pnpm --filter @console/web test:e2e
```

## Conventions

The full list is in [`.factory/profile.json`](.factory/profile.json)
(`conventions` and `review_checklist`). Reviewers check these most often:

- ESM everywhere. Relative imports carry the `.js` extension even in `.ts` files.
- Every authenticated route calls `requireAuth` and scopes every query to
  `ctx.orgIds`. Authorisation goes in the WHERE clause.
- Authoritative GitHub operations (approve, merge, label, comment as the user)
  go through the user-token client only, never the App's installation client.
- Schema changes add a new numbered file in `packages/db/migrations/`.
  Never edit a migration that has already shipped.
- New secrets are encrypted with `encryptSecret`. New environment variables are
  declared in the zod schema in `packages/core/src/config.ts`.
- Comments explain *why*, and cite the plan or spec section where one applies.

## Pull requests

- Keep each PR focused on one change. Small PRs get reviewed sooner.
- Fill in the PR template. Link the issue it closes.
- Add or update tests for behaviour you change.
- All checks must pass, and a code owner must approve, before merge.
- By contributing, you agree that your contribution is licensed under the
  [MIT License](LICENSE).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
taking part, you agree to uphold it.
