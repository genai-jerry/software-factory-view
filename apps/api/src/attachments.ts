/**
 * Image attachments the Console stores itself (Shape, Add work): what is
 * accepted and how a JSON upload is checked. GitHub's API takes no uploads,
 * so the Console keeps the bytes and the issue links to them.
 */

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** The JSON body limit for an upload route: the base64 of a 5 MB image, with room. */
export const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;

export type ImageUpload = { name: string; mime: string; dataB64: string; size: number };

/** The upload, checked; or the status and plain reason to send back. */
export function checkImageUpload(body: { name?: string; mime?: string; dataB64?: string } | undefined): ImageUpload | { status: number; error: string } {
  const mime = (body?.mime ?? "").toLowerCase();
  if (!IMAGE_MIMES.has(mime)) return { status: 400, error: "only PNG, JPEG, GIF and WebP images can be attached" };
  const dataB64 = (body?.dataB64 ?? "").replace(/^data:[^,]*,/, "").trim();
  if (!dataB64) return { status: 400, error: "the image is empty" };
  const size = Buffer.from(dataB64, "base64").length;
  if (size === 0) return { status: 400, error: "the image is empty" };
  if (size > MAX_ATTACHMENT_BYTES) return { status: 413, error: "an image can be at most 5 MB" };
  const name = (body?.name ?? "image").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "image";
  return { name, mime, dataB64, size };
}

/** The "## Attachments" section an issue body carries for Console-held images. */
export function attachmentsSection(origin: string, items: Array<{ id: string; name: string }>, path: string): string {
  if (items.length === 0) return "";
  const base = origin.replace(/\/+$/, "");
  return "## Attachments\n\nThese need a Compass sign-in to open.\n\n" + items.map((a) => `- [${a.name}](${base}${path}/${a.id})`).join("\n");
}
