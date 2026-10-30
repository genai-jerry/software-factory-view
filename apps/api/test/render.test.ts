import { describe, expect, it, vi } from "vitest";
import { fetchGitHubMedia, isGitHubMediaUrl, rewriteGitHubMediaUrls } from "../src/media.js";
import { renderMarkdown } from "../src/render.js";

describe("isGitHubMediaUrl", () => {
  it("accepts user-attachments on github.com", () => {
    expect(isGitHubMediaUrl("https://github.com/user-attachments/assets/abc-123")).toBe(true);
  });

  it("accepts private-user-images and camo hosts", () => {
    expect(isGitHubMediaUrl("https://private-user-images.githubusercontent.com/123/abc.png")).toBe(true);
    expect(isGitHubMediaUrl("https://camo.githubusercontent.com/abc/def")).toBe(true);
  });

  it("rejects arbitrary hosts", () => {
    expect(isGitHubMediaUrl("https://evil.example/steal.png")).toBe(false);
    expect(isGitHubMediaUrl("http://github.com/user-attachments/assets/x")).toBe(false);
    expect(isGitHubMediaUrl("https://github.com/acme/repo/blob/main/x.png")).toBe(false);
  });
});

describe("rewriteGitHubMediaUrls", () => {
  it("rewrites img src to the Console media proxy", () => {
    const html =
      '<p><img alt="Image" src="https://github.com/user-attachments/assets/abc123"></p>';
    const out = rewriteGitHubMediaUrls(html, "repo-uuid");
    expect(out).toContain('/api/media/repo-uuid?url=');
    expect(out).toContain(encodeURIComponent("https://github.com/user-attachments/assets/abc123"));
  });

  it("leaves non-GitHub images unchanged", () => {
    const html = '<img src="https://example.com/x.png">';
    expect(rewriteGitHubMediaUrls(html, "repo-uuid")).toBe(html);
  });
});

describe("renderMarkdown images", () => {
  it("renders markdown image syntax", () => {
    const html = renderMarkdown("![screenshot](https://github.com/user-attachments/assets/abc123)");
    expect(html).toContain("<img");
    expect(html).toContain('src="https://github.com/user-attachments/assets/abc123"');
    expect(html).toContain('alt="screenshot"');
  });

  it("rewrites GitHub media when repoId is provided", () => {
    const html = renderMarkdown("![screenshot](https://github.com/user-attachments/assets/abc123)", {
      repoId: "repo-1",
    });
    expect(html).toContain('/api/media/repo-1?url=');
  });

  it("preserves inline HTML img tags from GitHub issue bodies", () => {
    const html = renderMarkdown(
      'Before\n<img width="300" alt="Image" src="https://github.com/user-attachments/assets/abc123">\nAfter',
      { repoId: "repo-1" },
    );
    expect(html).toContain("/api/media/repo-1?url=");
  });
});

describe("fetchGitHubMedia", () => {
  it("passes the bearer token and returns the response body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const got = await fetchGitHubMedia("https://github.com/user-attachments/assets/x", "ghs_test");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/user-attachments/assets/x",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghs_test" }) }),
    );
    expect(got.contentType).toBe("image/png");
    expect(got.body.length).toBe(4);
    vi.unstubAllGlobals();
  });
});

describe("issue and PR references", () => {
  const link = (n: string, repo = "o/r") =>
    `<a href="https://github.com/${repo}/issues/${n}" target="_blank" rel="noopener noreferrer">`;

  it("links a bare #21 to the repo the text came from, and owner/repo#21 to its own", () => {
    const html = renderMarkdown("read the blocking comment on #21, and see acme/api#7.", { repoFullName: "o/r" });
    expect(html).toContain(`${link("21")}#21</a>`);
    expect(html).toContain(`${link("7", "acme/api")}acme/api#7</a>`);
  });

  it("leaves code, existing links, entities, hex colours and unknown repos alone", () => {
    const html = renderMarkdown(
      "`#21` and [fix #22](https://example.com/x) and it's #fff, #12abc, a&#39;b",
      { repoFullName: "o/r" },
    );
    expect(html).not.toContain("issues/21");
    expect(html).not.toContain("issues/22");
    expect(html).not.toContain("issues/12");
    expect(renderMarkdown("see #21", {})).not.toContain("<a ");
  });

  it("links references inside lists and bold text", () => {
    const html = renderMarkdown("**You need to:** read #21\n\n- merged in #22", { repoFullName: "o/r" });
    expect(html).toContain(`${link("21")}#21</a>`);
    expect(html).toContain(`${link("22")}#22</a>`);
  });
});
