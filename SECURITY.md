# Security Policy

Factory Console stores GitHub OAuth tokens and a GitHub App private key, and it
acts on GitHub as the signed-in user. We take security reports seriously.

## Supported versions

Only the latest commit on `main` receives security fixes. There are no
long-term support branches yet.

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull
requests.**

Report privately through GitHub instead:
**[Security → Report a vulnerability](https://github.com/genai-jerry/software-factory-view/security/advisories/new)**.

Please include:

- what the issue is and which component it affects (`apps/api`, `apps/web`,
  `apps/worker`, `packages/*`, `infra/`);
- steps to reproduce, or a proof of concept;
- the impact you think it has.

What to expect:

- an acknowledgement within **3 business days**;
- an initial assessment within **10 business days**;
- credit in the advisory once a fix ships, unless you prefer not to be named.

## Scope

In scope: authentication and session handling, CSRF, tenant isolation (data
from one organisation reachable by another), encryption at rest, webhook
signature verification, markdown sanitisation and XSS, and any path where the
Console could act on GitHub as the App instead of the user.

Out of scope: vulnerabilities in GitHub itself, issues that need a compromised
`CONSOLE_MASTER_KEY` or host, and deployments running with `DEV_FAKE_LOGIN=1`
(it is a development-only switch and documented as such).

## Running it safely

- Never set `DEV_FAKE_LOGIN=1` outside local development.
- Back up `CONSOLE_MASTER_KEY` and keep it out of version control. Losing it
  invalidates every stored credential. Leaking it exposes them.
- Serve the Console over HTTPS only. `PUBLIC_ORIGIN` must be an `https://` URL
  in production.
