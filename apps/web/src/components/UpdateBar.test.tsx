import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateBar, loadedScript } from "./UpdateBar.js";

function loadScript(src: string) {
  const s = document.createElement("script");
  s.setAttribute("src", src);
  s.setAttribute("data-test", "1");
  document.head.appendChild(s);
}

afterEach(() => document.querySelectorAll("script[data-test]").forEach((s) => s.remove()));

describe("UpdateBar", () => {
  it("finds the app script this page loaded", () => {
    loadScript("/assets/index-AbC123.js");
    expect(loadedScript()).toBe("/assets/index-AbC123.js");
  });

  it("asks to reload when a newer Compass is out", async () => {
    loadScript("/assets/index-old111.js");
    const fetchIndex = async () => '<script type="module" src="/assets/index-new222.js"></script>';
    render(<UpdateBar fetchIndex={fetchIndex} />);
    expect(await screen.findByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("stays quiet when the page is current, or in development", async () => {
    loadScript("/assets/index-same333.js");
    const same = async () => '<script type="module" src="/assets/index-same333.js"></script>';
    render(<UpdateBar fetchIndex={same} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
