import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one-time start token behind `t.me/<bot>?start=<token>` (openspec
 * telegram-decisions, design §7). Telegram allows 64 characters of
 * [A-Za-z0-9_-]; this is 38 bytes in base64url (51 characters):
 * user uuid (16) · expiry, unix seconds (4) · nonce (6) · HMAC-SHA256 truncated (12).
 * Single use is enforced by the caller recording the nonce.
 */
const TTL_SECONDS = 15 * 60;

function key(masterKey: string): Buffer {
  return createHash("sha256").update(`telegram-link:${masterKey}`).digest();
}

function uuidBytes(id: string): Buffer {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("not a uuid");
  return Buffer.from(hex, "hex");
}

function uuidOf(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function makeLinkToken(masterKey: string, userId: string, now = Date.now()): string {
  const body = Buffer.alloc(26);
  uuidBytes(userId).copy(body, 0);
  body.writeUInt32BE(Math.floor(now / 1000) + TTL_SECONDS, 16);
  randomBytes(6).copy(body, 20);
  const mac = createHmac("sha256", key(masterKey)).update(body).digest().subarray(0, 12);
  return Buffer.concat([body, mac]).toString("base64url");
}

export type LinkTokenCheck = { ok: true; userId: string; nonce: string } | { ok: false; reason: "invalid" | "expired" };

export function readLinkToken(masterKey: string, token: string, now = Date.now()): LinkTokenCheck {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return { ok: false, reason: "invalid" };
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== 38) return { ok: false, reason: "invalid" };
  const body = raw.subarray(0, 26);
  const mac = createHmac("sha256", key(masterKey)).update(body).digest().subarray(0, 12);
  if (!timingSafeEqual(mac, raw.subarray(26))) return { ok: false, reason: "invalid" };
  if (body.readUInt32BE(16) * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true, userId: uuidOf(body.subarray(0, 16)), nonce: body.subarray(20, 26).toString("base64url") };
}
