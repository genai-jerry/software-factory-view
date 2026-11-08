import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { TelegramPage } = await import("./Telegram.js");

/** Connecting Telegram (openspec telegram-decisions): off, not connected, connected. */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TelegramPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(api.get).mockReset());

describe("the Telegram page", () => {
  it("says when the bot is not set up", async () => {
    vi.mocked(api.get).mockResolvedValue({ enabled: false });
    renderPage();
    expect(await screen.findByText(/not set up on this Compass yet/)).toBeTruthy();
  });

  it("opens the one-time link when you connect", async () => {
    vi.mocked(api.get).mockResolvedValue({ enabled: true, botUsername: "compass_bot", linked: false });
    vi.mocked(api.post).mockResolvedValue({ url: "https://t.me/compass_bot?start=abc" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    expect(api.post).toHaveBeenCalledWith("/api/me/telegram/link");
    expect(open).toHaveBeenCalledWith("https://t.me/compass_bot?start=abc", "_blank", "noopener");
  });

  it("shows the connected chat with pause and disconnect", async () => {
    vi.mocked(api.get).mockResolvedValue({ enabled: true, botUsername: "compass_bot", linked: true, tgUsername: "jerry", paused: false });
    renderPage();
    expect(await screen.findByText(/@jerry with @compass_bot/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});
