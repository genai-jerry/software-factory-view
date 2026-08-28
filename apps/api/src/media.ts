/**
 * GitHub issue bodies embed images on hosts that require authentication
 * (user-attachments, private-user-images, camo). The SPA cannot load those
 * directly — proxy them through the Console with an installation or user token.
 */

const GITHUB_MEDIA_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "raw.githubusercontent.com",
]);

/** Paths on github.com that carry uploaded issue/comment media. */
const GITHUB_COM_MEDIA_PREFIXES = ["/user-attachments/assets/"];

export function isGitHubMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (GITHUB_MEDIA_HOSTS.has(u.hostname) && u.hostname !== "github.com") return true;
    if (u.hostname === "github.com") {
      return GITHUB_COM_MEDIA_PREFIXES.some((p) => u.pathname.startsWith(p));
    }
    return false;
  } catch {
    return false;
  }
}

/** Rewrite img src attributes to the Console media proxy for one repo. */
export function rewriteGitHubMediaUrls(html: string, repoId: string): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (_match, before, src, after) => {
    if (!isGitHubMediaUrl(src)) return `${before}${src}${after}`;
    const proxied = `/api/media/${encodeURIComponent(repoId)}?url=${encodeURIComponent(src)}`;
    return `${before}${proxied}${after}`;
  });
}

export async function fetchGitHubMedia(url: string, token: string): Promise<{ body: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "image/*",
      "User-Agent": "factory-console",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`GitHub media fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body: buf, contentType };
}
