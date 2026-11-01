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

/**
 * Rewrite img src attributes to the Console media proxy for one repo. The
 * issue number, when the HTML is an issue's body or one of its comments, is
 * what lets the proxy find a signed URL for an attachment GitHub will not
 * serve to the tokens the Console holds (see `signedAttachmentUrl`).
 */
export function rewriteGitHubMediaUrls(html: string, repoId: string, issueNumber?: number | null): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (_match, before, src, after) => {
    if (!isGitHubMediaUrl(src)) return `${before}${src}${after}`;
    const issue = issueNumber ? `&issue=${issueNumber}` : "";
    const proxied = `/api/media/${encodeURIComponent(repoId)}?url=${encodeURIComponent(src)}${issue}`;
    return `${before}${proxied}${after}`;
  });
}

/** The asset id of a github.com/user-attachments/assets/<id> URL, or null. */
export function attachmentAssetId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "github.com") return null;
    const m = /^\/user-attachments\/assets\/([0-9a-f-]{20,})$/i.exec(u.pathname);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Signed attachment URLs GitHub hands out expire in five minutes; keep them a little less. */
const signedCache = new Map<string, { url: string; until: number }>();
const SIGNED_TTL_MS = 4 * 60_000;

/**
 * A short-lived signed URL for a private repository's attachment.
 *
 * GitHub serves `github.com/user-attachments/assets/…` only to a classic
 * OAuth token with `repo` scope; an App installation token and an App
 * user-to-server token — the two the Console holds — both get 404. The
 * Issues API, asked for HTML, renders the same body with each attachment
 * already swapped for a `private-user-images.githubusercontent.com` URL
 * carrying a JWT, and that URL serves the image with no Authorization at
 * all. So: fetch the issue (then its comments) as HTML, find the img whose
 * path carries this asset id, and use that.
 */
export async function signedAttachmentUrl(
  apiUrl: string,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  assetId: string,
): Promise<string | null> {
  const key = `${owner}/${repo}#${issueNumber}:${assetId}`;
  const hit = signedCache.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.html+json",
    "User-Agent": "factory-console",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `${apiUrl.replace(/\/$/, "")}/repos/${owner}/${repo}/issues/${issueNumber}`;
  const find = (html: string | undefined): string | null => {
    if (!html) return null;
    const re = /<img\b[^>]*\bsrc="(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)"/gi;
    for (const m of html.matchAll(re)) {
      const src = m[1]!.replace(/&amp;/g, "&");
      if (src.toLowerCase().includes(assetId)) return src;
    }
    return null;
  };
  const issueRes = await fetch(base, { headers });
  if (!issueRes.ok) return null;
  let url = find(((await issueRes.json()) as { body_html?: string }).body_html);
  for (let page = 1; !url && page <= 5; page += 1) {
    const res = await fetch(`${base}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) break;
    const list = (await res.json()) as Array<{ body_html?: string }>;
    for (const c of list) {
      url = find(c.body_html);
      if (url) break;
    }
    if (list.length < 100) break;
  }
  if (url) signedCache.set(key, { url, until: Date.now() + SIGNED_TTL_MS });
  return url;
}

/** Fetch a signed attachment URL: no Authorization, or S3 refuses it. */
export async function fetchSignedMedia(url: string): Promise<{ body: Buffer; contentType: string }> {
  const res = await fetch(url, { headers: { Accept: "image/*", "User-Agent": "factory-console" }, redirect: "follow" });
  if (!res.ok) throw new Error(`GitHub media fetch failed: ${res.status} ${res.statusText}`);
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
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
