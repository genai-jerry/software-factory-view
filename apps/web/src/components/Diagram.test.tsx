import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mermaidLiveUrl, svgSize } from "../lib/diagram.js";
import { Diagram } from "./Diagram.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><text>Leads page</text></svg>';
const render$ = vi.fn(async (_id: string, code: string) => {
  if (code.includes("broken")) throw new Error("Parse error on line 2");
  return { svg: SVG };
});
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: (id: string, code: string) => render$(id, code) } }));

const pdfSvg = vi.fn(async () => undefined);
const pdfSave = vi.fn();
vi.mock("jspdf", () => ({
  jsPDF: vi.fn().mockImplementation((opts: unknown) => ({ opts, svg: pdfSvg, save: pdfSave })),
}));
vi.mock("svg2pdf.js", () => ({}));

async function inflate(url: string): Promise<Record<string, unknown>> {
  const b64 = url.split("#pako:")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate"));
  return JSON.parse(await new Response(stream).text()) as Record<string, unknown>;
}

beforeEach(() => {
  render$.mockClear();
  pdfSvg.mockClear();
  pdfSave.mockClear();
});

describe("mermaidLiveUrl", () => {
  it("carries the diagram in the editor's pako state, which inflates back to it", async () => {
    const code = 'flowchart LR\n  A["Caller"] --> B["beacon-api"]';
    const url = await mermaidLiveUrl(code);
    expect(url.startsWith("https://mermaid.live/edit#pako:")).toBe(true);
    // URL-safe base64: nothing a browser would re-encode in a fragment.
    expect(url.split("#pako:")[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await inflate(url)).toMatchObject({ code, autoSync: true });
  });
});

describe("svgSize", () => {
  it("reads the viewBox, and falls back when there is none", () => {
    expect(svgSize(SVG)).toEqual({ width: 320, height: 120 });
    expect(svgSize("<svg></svg>")).toEqual({ width: 800, height: 600 });
  });
});

describe("Diagram", () => {
  it("draws the diagram, links it to Mermaid Live, and keeps the code one tab away", async () => {
    render(<Diagram code={'flowchart LR\n  A["Leads page"] --> B'} n={1} />);
    expect(await screen.findByText("Leads page")).toBeInTheDocument();
    const live = await screen.findByRole("link", { name: "Open in Mermaid Live" });
    expect(live.getAttribute("href")).toMatch(/^https:\/\/mermaid\.live\/edit#pako:/);
    expect(live.getAttribute("rel")).toContain("noopener");
    await userEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByText(/A\["Leads page"\] --> B/)).toBeInTheDocument();
  });

  it("saves a PDF the size of the drawing", async () => {
    render(<Diagram code="flowchart LR\n  A --> B" n={2} />);
    await screen.findByText("Leads page");
    await userEvent.click(screen.getByRole("button", { name: "PDF" }));
    await waitFor(() => expect(pdfSave).toHaveBeenCalledWith("diagram-2.pdf"));
    expect(pdfSvg).toHaveBeenCalledWith(expect.anything(), { x: 24, y: 24, width: 320, height: 120 });
  });

  it("says what Mermaid could not read, instead of a blank card", async () => {
    render(<Diagram code={"flowchart LR\n  broken -->"} n={3} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Parse error on line 2");
    expect(screen.getByRole("button", { name: "PDF" })).toBeDisabled();
  });
});
