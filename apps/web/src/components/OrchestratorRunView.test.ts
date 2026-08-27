import { describe, expect, it } from "vitest";
import { explainOrchestratorError } from "./OrchestratorRunView.js";

describe("explainOrchestratorError", () => {
  it("turns a GitHub 401 into a re-run hint", () => {
    const raw =
      "HTTPStatusError: Client error '401 Unauthorized' for url 'https://api.github.com/repos/acme/api/issues/7'";
    expect(explainOrchestratorError(raw)).toMatch(/mints a fresh installation token/i);
    expect(explainOrchestratorError(raw)).not.toBe(raw);
  });

  it("leaves unrelated errors unchanged", () => {
    expect(explainOrchestratorError("No Anthropic credential is available.")).toBe(
      "No Anthropic credential is available.",
    );
  });
});
