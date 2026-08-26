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
