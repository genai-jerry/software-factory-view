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
