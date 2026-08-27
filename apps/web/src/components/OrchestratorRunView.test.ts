import { describe, expect, it } from "vitest";
import { explainOrchestratorError, NO_OP_EXPLANATION } from "./OrchestratorRunView.js";

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

describe("no-op outcome", () => {
  it("explains a silent role without blaming credentials", () => {
    expect(NO_OP_EXPLANATION).toMatch(/without posting a comment/i);
    expect(NO_OP_EXPLANATION).toMatch(/not still in progress/i);
    expect(NO_OP_EXPLANATION).not.toMatch(/turn limit/i);
  });
});
