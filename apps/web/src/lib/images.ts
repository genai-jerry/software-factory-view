/** Images a person picks to send with a message or a work item, held locally until sent. */
export interface PendingImage {
  key: string;
  name: string;
  mime: string;
  dataUrl: string;
}

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGES = 6;

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** The image files among `files`, read for preview; non-images are left out. */
export async function pickImages(files: FileList | File[]): Promise<PendingImage[]> {
  const picked: PendingImage[] = [];
  for (const f of Array.from(files)) {
    if (!IMAGE_MIMES.has(f.type)) continue;
    picked.push({ key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, name: f.name || "image.png", mime: f.type, dataUrl: await readAsDataUrl(f) });
  }
  return picked;
}

/** The base64 payload of a data URL, as the upload routes take it. */
export function dataB64Of(p: PendingImage): string {
  return p.dataUrl.slice(p.dataUrl.indexOf(",") + 1);
}
