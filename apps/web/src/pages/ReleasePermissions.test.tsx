import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { ReleasePermissions } from "./Settings.js";

const data = { repos: ["o/api"], production: ["jerry"], staging: [], mixed: false, members: ["jerry", "sowmya"] };

function show(canEdit = true, over = {}) {
  vi.spyOn(api, "get").mockResolvedValue({ ...data, ...over });
  const post = vi.spyOn(api, "post").mockResolvedValue({ ok: true, results: [] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ReleasePermissions projectId="p1" name="Beacon" canEdit={canEdit} /></QueryClientProvider>);
  return post;
}

afterEach(() => vi.restoreAllMocks());

describe("ReleasePermissions", () => {
  it("saves a changed production list", async () => {
    const post = show();
    await screen.findByText("Who can release Beacon");
    fireEvent.click(screen.getAllByLabelText("@sowmya")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/p1/permissions", { production: ["jerry", "sowmya"], staging: [] }));
  });

  it("will not save production with nobody on it", async () => {
    show();
    await screen.findByText("Who can release Beacon");
    fireEvent.click(screen.getAllByLabelText("@jerry")[0]!);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose someone for production.")).toBeTruthy();
  });

  it("is read-only without admin rights, and flags repos that disagree", async () => {
    show(false, { mixed: true });
    await screen.findByText(/different lists/);
    expect((screen.getAllByLabelText("@jerry")[0] as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
