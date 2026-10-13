## What this changes

<!-- One or two sentences. What does a user or operator see differently? -->

Closes #

## Why

<!-- The problem this solves, or a link to the issue or plan section that explains it. -->

## How it was tested

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm --filter @console/web test:e2e` (UI changes)
- [ ] Tried it by hand: <!-- what you clicked, and what happened -->

## Checklist

- [ ] New or changed API routes call `requireAuth` and scope queries to `ctx.orgIds`
- [ ] Authoritative GitHub writes go through the user-token client only
- [ ] Schema changes add a new migration file. No shipped migration was edited
- [ ] No secrets, tokens, hostnames or personal data in code, tests or screenshots
- [ ] Docs (README, `.env.example`, `docs/`) updated if behaviour or config changed
