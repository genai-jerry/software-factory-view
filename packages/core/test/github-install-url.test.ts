import { describe, expect, it } from "vitest";
import { githubAppInstallUrl } from "../src/github.js";

describe("githubAppInstallUrl", () => {
  it("pre-selects an account with suggested_target_id, not target_id", () => {
    expect(
      githubAppInstallUrl({ webUrl: "https://github.com", slug: "factory-console", accountId: 42 }),
    ).toBe("https://github.com/apps/factory-console/installations/new/permissions?suggested_target_id=42");
  });

  it("pre-selects repositories so GitHub does not default to All repositories", () => {
    expect(
      githubAppInstallUrl({
        webUrl: "https://github.com",
        slug: "factory-console",
        accountId: 42,
        repositoryIds: [11, 22],
      }),
    ).toBe(
      "https://github.com/apps/factory-console/installations/new/permissions?suggested_target_id=42&repository_ids[]=11&repository_ids[]=22",
    );
  });

  it("falls back to the account picker when no account is known", () => {
    expect(githubAppInstallUrl({ webUrl: "https://github.com", slug: "factory-console" })).toBe(
      "https://github.com/apps/factory-console/installations/new",
    );
  });
});
