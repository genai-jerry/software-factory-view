import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, verifyWebhookSignature } from "../src/crypto.js";
import { createHmac } from "node:crypto";

describe("envelope encryption", () => {
  const key = randomBytes(32).toString("base64");
  it("round-trips", () => {
    const sealed = encryptSecret("gho_token123", key);
    expect(sealed).not.toContain("gho_token123");
    expect(decryptSecret(sealed, key)).toBe("gho_token123");
  });
  it("tampered ciphertext fails closed", () => {
    const sealed = encryptSecret("secret", key);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered!").toString("base64");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });
  it("rejects a short master key", () => {
    expect(() => encryptSecret("x", Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("webhook signature verification", () => {
  const secret = "whsec";
  const payload = Buffer.from(JSON.stringify({ action: "opened" }));
  const sig = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(true);
  });
  it("rejects a bad signature", () => {
    expect(verifyWebhookSignature(secret, payload, "sha256=" + "0".repeat(64))).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifyWebhookSignature(secret, payload, undefined)).toBe(false);
  });
});
