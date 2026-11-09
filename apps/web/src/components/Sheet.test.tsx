import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet.js";
import { Banner } from "./Banner.js";

describe("Sheet", () => {
  it("closes on Escape and labelled Close", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Sheet title="More" onClose={onClose}>
        <p>sheet body</p>
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Banner", () => {
  it("keeps technical details collapsed", () => {
    render(
      <Banner tone="error" technical="Redis is down">
        The Console is unavailable.
      </Banner>,
    );
    expect(screen.getByText("The Console is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    const details = document.querySelector(".banner-tech");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
  });
});

describe("Sheet on a page that refreshes", () => {
  it("keeps the reader's place when the page re-renders with a new onClose", () => {
    const closes: string[] = [];
    const ui = (n: number) => (
      <Sheet title="Epic" onClose={() => closes.push(`close-${n}`)}>
        <p>Long text</p>
        <a href="#x">a link further down</a>
      </Sheet>
    );
    const { rerender } = render(ui(1));
    const link = screen.getByRole("link", { name: "a link further down" });
    link.focus();
    rerender(ui(2)); // the 5-second refresh: a new onClose function
    expect(document.activeElement).toBe(link); // focus (and so the scroll) stays where the reader is
    screen.getByRole("dialog").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closes).toEqual(["close-2"]); // Escape still closes, with the latest handler
  });
});
