import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  explainOrchestratorError,
  NO_OP_EXPLANATION,
  OrchestratorRunBody,
  runEvents,
} from "./OrchestratorRunView.js";

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

describe("run events timeline", () => {
  it("lists phase notifications from the orchestrator event log", () => {
    render(
      <OrchestratorRunBody
        run={{
          role: "fasttrack",
          outcome: "running",
          events: [
            { ts: "2026-08-28T03:00:00Z", kind: "phase", message: "waiting for tests" },
            { ts: "2026-08-28T03:01:00Z", kind: "phase", message: "pushing the branch" },
          ],
        }}
      />,
    );
    const list = screen.getByRole("list", { name: "Run events" });
    expect(list).toHaveTextContent("waiting for tests");
    expect(list).toHaveTextContent("pushing the branch");
  });

  it("hides the timeline when the orchestrator has not sent events yet", () => {
    render(<OrchestratorRunBody run={{ role: "intake", outcome: "running" }} />);
    expect(screen.queryByRole("list", { name: "Run events" })).toBeNull();
  });

  it("ignores malformed event rows", () => {
    expect(
      runEvents({
        events: [{ message: "cloning the repo" }, { kind: "phase" }, "nope"],
      }),
    ).toEqual([{ ts: undefined, kind: undefined, message: "cloning the repo" }]);
  });
});
