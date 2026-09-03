import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const VIEWPORTS = [
  { name: "phone", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desk", width: 1280, height: 800 },
] as const;

async function noPagePan(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("expedited workspace and the GS panel do not pan", async ({ page }) => {
      await page.goto("/e2e.html?screen=expedite");
      await expect(page.getByText("auto — Implementer next")).toBeVisible();
      await noPagePan(page);

      await page.goto("/e2e.html?screen=gate-staging");
      await expect(page.getByRole("heading", { name: /GS — release to staging/ })).toBeVisible();
      await noPagePan(page);
    });

    test("system test cases do not pan", async ({ page }) => {
      await page.goto("/e2e.html?screen=system-tests");
      // Cases are their own tab, never a column among the code tasks.
      await expect(page.getByRole("heading", { name: /System tests \(1\/3 passed\)/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Pass" })).toBeVisible();
      await noPagePan(page);
    });

    test("the Tests tab of an epic with no plan does not pan", async ({ page }) => {
      await page.goto("/e2e.html?screen=plan-tests");
      // The tab exists to be the offer when there is nothing to list.
      await expect(page.getByText(/No test plan on this epic yet/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Plan tests" })).toBeVisible();
      await noPagePan(page);
    });

    // Split from the case list above on purpose: the gate screens render
    // `GateTab`, which fetches, so they need the API up — the same reason the
    // GS/G3 tests next door do. Keeping the case list separate means it stays
    // runnable against the static harness alone.
    test("the GS test matrix does not pan", async ({ page }) => {
      await page.goto("/e2e.html?screen=gate-staging-tests");
      await expect(page.getByRole("heading", { name: "System tests" })).toBeVisible();
      await expect(page.getByText(/1 case not passed/)).toBeVisible();
      // The warning informs the decision; it never withholds it.
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
      await noPagePan(page);
    });

    test("signed-in shell does not pan", async ({ page }) => {
      await page.goto("/e2e.html?screen=shell");
      await expect(page.getByRole("link", { name: "Factory Console" })).toBeVisible();
      if (vp.width < 1024) {
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
        await expect(page.getByRole("link", { name: "My work" })).toBeVisible();
        await expect(page.getByRole("button", { name: "More" })).toBeVisible();
      } else {
        await expect(page.getByRole("link", { name: "My work" })).toBeVisible();
      }
      await noPagePan(page);
    });
  });
}

test.describe("phone jobs 360px", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("axe on signed-in shell", async ({ page }) => {
    await page.goto("/e2e.html?screen=shell");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, results.violations.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);
  });

  test("More sheet closes on Escape", async ({ page }) => {
    await page.goto("/e2e.html?screen=shell");
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
  });

  test("needs-you peek shows reply composer without pan", async ({ page }) => {
    await page.goto("/e2e.html?screen=peek");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByPlaceholder(/Reply to unblock/)).toBeVisible();
    await noPagePan(page);
  });

  test("G1 gate shows spec and Approve; non-approver does not", async ({ page }) => {
    await page.goto("/e2e.html?screen=gate");
    await expect(page.getByRole("heading", { name: "Spec" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve as @tester/ })).toBeVisible();
    await noPagePan(page);

    await page.goto("/e2e.html?screen=gate-non-approver");
    await expect(page.getByRole("heading", { name: "Spec" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await noPagePan(page);
  });

  test("expedited epic: badge, auto chips, no approvals to give", async ({ page }) => {
    await page.goto("/e2e.html?screen=expedite");
    await expect(page.getByTitle(/factory:expedite/).first()).toBeVisible();
    // The task board says what runs by itself, and asks for nothing.
    await expect(page.getByText("auto — Implementer next")).toBeVisible();
    await expect(page.getByText("auto — QA next")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start QA" })).toHaveCount(0);
    // The manual start is reachable, just not the first thing offered.
    await page.getByText("Start it by hand").first().click();
    await expect(page.getByRole("button", { name: "Start QA" }).or(page.getByRole("button", { name: "Approve" })).first()).toBeVisible();
    await noPagePan(page);
  });

  test("the confirm step lists what expedite waives and what it keeps", async ({ page }) => {
    await page.goto("/e2e.html?screen=expedite-confirm");
    await page.getByRole("button", { name: "Expedite…" }).click();
    const dialog = page.getByRole("dialog", { name: "Turn expedite on?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/G1 — the spec gate/)).toBeVisible();
    await expect(dialog.getByText(/G2 — the design gate/)).toBeVisible();
    await expect(dialog.getByText(/Implementation starts/)).toBeVisible();
    await expect(dialog.getByText(/GS — the release to staging/)).toBeVisible();
    await expect(dialog.getByText(/G3 — the promotion to production/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Turn expedite on" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await noPagePan(page);
  });

  test("GS panels the assembly and approves to staging, not production", async ({ page }) => {
    await page.goto("/e2e.html?screen=gate-staging");
    await expect(page.getByRole("heading", { name: /GS — release to staging/ })).toBeVisible();
    await expect(page.getByText(/staging, not production/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "What was assembled" })).toBeVisible();
    await expect(page.getByText("all tasks landed")).toBeVisible();
    await expect(page.getByText(/Assembly green/)).toBeVisible();
    // The `staging` list is unset on this estate — the panel says whose list it is showing.
    await expect(page.getByText(/the release approvers stand in/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await noPagePan(page);
  });

  test("G3 is unchanged: merge buttons, no comment approval", async ({ page }) => {
    await page.goto("/e2e.html?screen=gate-g3");
    await expect(page.getByRole("heading", { name: /G3 — promotion to production/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /the merge button is the gate/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Merge as @tester" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "What was assembled" })).toHaveCount(0);
    await noPagePan(page);
  });

  test("axe on the expedited workspace and the GS panel", async ({ page }) => {
    // The two system-test screens are not in this loop. Their own chips are
    // contrast-clean (`badge test-run`), but the Tasks tab goes h1 -> h4 with
    // no h3 between, which axe reads as a heading-order skip — a property of
    // the workspace that predates system tests and is not this change's to
    // silently absorb. Their render and no-pan coverage is above.
    for (const screen of ["expedite", "gate-staging"]) {
      await page.goto(`/e2e.html?screen=${screen}`);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `${screen}: ${results.violations.map((v) => `${v.id}: ${v.help}`).join("\n")}`).toEqual([]);
    }
  });

  test("sign-in station is full-width", async ({ page }) => {
    await page.goto("/e2e.html?screen=home");
    await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await noPagePan(page);
  });

  test("one onboarding step expanded, later steps collapsed", async ({ page }) => {
    await page.goto("/e2e.html?screen=onboarding");
    const labels = page.locator("details[data-step='labels']");
    const secrets = page.locator("details[data-step='secrets']");
    const stubs = page.locator("details[data-step='stubs']");
    await expect(labels).toHaveAttribute("open", "");
    await expect(secrets).not.toHaveAttribute("open");
    await expect(stubs).not.toHaveAttribute("open");
    await expect(page.getByRole("button", { name: "Reset factory…" })).toBeVisible();
    await noPagePan(page);
  });
});
