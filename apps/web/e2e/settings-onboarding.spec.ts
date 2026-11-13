import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * Epic #178, spec "Settings rows on a phone" and the Settings/Onboarding part of
 * "Every route checked": at 360px the real Settings and Onboarding pages are no
 * wider than the screen, and each repository name and time on a Settings row is
 * fully visible. The pages fetch through `api.get`; every `/api/*` call is
 * answered here, so the check runs against the static harness alone.
 */

const LONG_REPO = "genai-jerry/a-really-long-repository-name-that-will-not-fit-on-a-phone";
const LONG_ESTATE = "an-organisation-with-a-very-long-estate-name-for-phones";
const when = "2026-11-13T04:44:00.000Z";

const ORG = "org-1";

const answers: Record<string, unknown> = {
  "/api/setup/status": {
    configured: true, source: "database", appSlug: "factory", appId: "1", clientId: "c", hasWebhookSecret: true,
    canEditApp: true, hasMasterKey: true, credentialError: null,
    publicOrigin: "https://compass.example-with-a-long-host-name.invalid",
    insightEnabled: true, devLogin: false, appReset: false,
  },
  "/api/ops/ingestion": {
    summary: { lastReceivedAt: when, lastProcessedAt: when, pending: 1, failing: 1, total: 3 },
    deliveries: [
      {
        deliveryGuid: "g1", event: "pull_request_review_comment", action: "created", repo: LONG_REPO,
        receivedAt: when, processedAt: null,
        error: "projection failed: https://api.github.com/repos/genai-jerry/a-really-long-repository-name/pulls/123456 returned 502",
      },
      { deliveryGuid: "g2", event: "issues", action: "labeled", repo: LONG_REPO, receivedAt: when, processedAt: when, error: null },
    ],
    reconciles: [
      {
        id: "r1", estateName: LONG_ESTATE, trigger: "nightly", startedAt: when, finishedAt: when,
        reposWalked: 12, issuesSeen: 340, pullsSeen: 120, errors: ["rate limited by GitHub secondary-rate-limit endpoint"],
      },
    ],
  },
  [`/api/orgs/${ORG}/settings`]: {
    id: ORG, name: LONG_ESTATE, role: "owner",
    orchestrator: { engine: "software-factory", githubActionsEnabled: false },
    insight: { provider: "anthropic", model: null, hasKey: true, defaultModel: "claude-sonnet-5", globalKeyConfigured: true, providers: ["anthropic", "openai"] },
    branches: { defaultBranch: "main", stagingBranch: "staging" },
    allowedSecrets: ["ANTHROPIC_API_KEY", "FACTORY_CROSS_REPO_TOKEN"],
    retainedSecrets: [{ name: "FACTORY_CROSS_REPO_TOKEN", updatedAt: when, updatedBy: "a-person-with-a-long-github-login" }],
  },
  "/api/projects": {
    projects: [{ id: "p1", orgId: ORG, name: "A project with a fairly long name for a phone", repos: [{ id: "r1", fullName: LONG_REPO }] }],
    unassigned: [{ id: "r2", orgId: ORG, fullName: `${LONG_REPO}-two` }],
  },
  "/api/projects/p1/permissions": {
    repos: [LONG_REPO], production: ["a-person-with-a-long-github-login"], staging: [], mixed: false,
    members: ["a-person-with-a-long-github-login", "tester"],
  },
  "/api/estates": {
    estates: [{ id: "e1", name: LONG_ESTATE, lastSyncedAt: when, stale: false, repos: [] }],
  },
  "/api/estates/e1/onboarding": {
    estateId: "e1",
    orchestrator: { engine: "software-factory", githubActionsEnabled: false },
    repos: [
      {
        repoId: "r1", fullName: LONG_REPO, factoryEnabled: false,
        steps: {
          labels: { status: "ok", detail: { found: 20, created: 12, fixed: 0 }, updatedAt: when },
          openspec: {
            status: "failed",
            detail: { error: "npx @fission-ai/openspec@latest init failed: ENOENT /home/runner/work/a-really-long-repository-name/openspec" },
            updatedAt: when,
          },
        },
      },
    ],
  },
  "/api/installations": {
    installations: [
      {
        installationId: 1, accountId: 1, account: "an-account-with-a-very-long-github-name", accountType: "Organization",
        avatarUrl: null, estateId: "e1", estateName: LONG_ESTATE, installUrl: null, settingsUrl: null, repos: [],
      },
    ],
  },
};

async function answerApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path in answers) return route.fulfill({ json: answers[path] });
    return route.fulfill({ status: 404, json: { error: "not in this fixture" } });
  });
}

async function noPagePan(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/** On screen, inside the viewport, and not cut off by its own box. */
async function fullyVisible(el: Locator, width: number) {
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  const clipped = await el.evaluate((n) => n.scrollWidth - n.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
}

test.describe("Settings and Onboarding at 360px", () => {
  const width = 360;
  test.use({ viewport: { width, height: 800 } });

  test("Settings rows on a phone: page fits, every repository name and time is fully visible", async ({ page }) => {
    await answerApi(page);
    await page.goto("/e2e.html?screen=settings-page");
    await expect(page.getByRole("heading", { name: "Ingestion log" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await noPagePan(page);

    const names = page.locator(".check-row .check-row-name, .project-row .check-row-name");
    const times = page.locator(".check-row .check-row-time");
    // 2 webhook rows + 1 reconcile row + 2 project rows.
    await expect(names).toHaveCount(5);
    await expect(times).toHaveCount(3);
    for (const el of await names.all()) await fullyVisible(el, width);
    for (const el of await times.all()) await fullyVisible(el, width);
    // The name is the full text, not an ellipsis.
    await expect(names.first()).toHaveText(LONG_REPO);
    await expect(page.locator(".check-row .check-row-name", { hasText: LONG_ESTATE })).toHaveCount(1);
  });

  test("Onboarding fits a phone", async ({ page }) => {
    await answerApi(page);
    await page.goto("/e2e.html?screen=onboarding-page");
    const repo = page.getByRole("heading", { level: 3, name: new RegExp(LONG_REPO) });
    await fullyVisible(repo, width);
    await noPagePan(page);
    // Open every step, so the long step text and the failed OpenSpec error are laid out too.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    await expect(page.getByText(/ENOENT/).first()).toBeVisible();
    await noPagePan(page);
  });
});
