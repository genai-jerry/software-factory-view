import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (user OAuth tokens, cached repo
 * content). MVP uses a single master key from the environment; the per-tenant
 * data-key indirection (spec 01 §7) slots in behind the same interface when a
 * KMS is available.
 */

const ALG = "aes-256-gcm";

export function encryptSecret(plaintext: string, masterKeyB64: string): string {
  const key = keyFrom(masterKeyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(sealed: string, masterKeyB64: string): string {
  const parts = sealed.split(".");
  const [v, ivB64, tagB64, ctB64] = parts;
  // An empty ciphertext is a sealed empty string, not a malformed envelope —
  // base64 of nothing is "". Rejecting it made a legitimately blank secret (an
  // App with no webhook, say) unreadable and took every credential lookup with
  // it. Absent segments are still malformed; base64 never contains a dot, so a
  // well-formed envelope has exactly four parts.
  if (parts.length !== 4 || v !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error("malformed sealed secret");
  }
  const key = keyFrom(masterKeyB64);
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

function keyFrom(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) throw new Error("CONSOLE_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

/** GitHub webhook signature check (X-Hub-Signature-256). Constant-time. */
export function verifyWebhookSignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
