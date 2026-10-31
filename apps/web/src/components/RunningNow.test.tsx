import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { EpicWorkspace } from "../types.js";
import { RunningNow } from "./RunningNow.js";

const task = (number: number, over: Record<string, unknown> = {}) => ({
  id: `t${number}`, number, title: `task ${number}`, open: true, running: false, runningRole: null, ...over,
});

function show(tasks: unknown[]) {
  const data = { epic: { id: "e1" }, tasks } as unknown as EpicWorkspace;
  return render(<MemoryRouter><RunningNow data={data} /></MemoryRouter>);
}

describe("RunningNow", () => {
  it("names each live run and links it to its run log, with the thread beside it", () => {
    show([
      task(11, { running: true, runningRole: "Implementer", runId: "run-abc" }),
      task(62, { running: true, runningRole: "Reviewer" }),
      task(64),
    ]);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Running now — Implementer on #11 (thread), Reviewer on #62.");
    expect(screen.getByRole("link", { name: "#11" }).getAttribute("href")).toBe("/runs/run-abc");
    expect(screen.getAllByRole("link", { name: "thread" })[0]!.getAttribute("href")).toBe("/epics/e1?tab=threads&thread=task%2F11");
    // No run known: the number opens the thread, as before.
    expect(screen.getByRole("link", { name: "#62" }).getAttribute("href")).toBe("/epics/e1?tab=threads&thread=task%2F62");
  });

  it("shows nothing when no run is live, or the task is closed", () => {
    const { container } = show([task(11), task(12, { running: true, runningRole: "QA", open: false })]);
    expect(container).toBeEmptyDOMElement();
  });
});
