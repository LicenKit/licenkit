import { describe, expect, it } from "vitest";
import {
  base64ToBuffer,
  base64UrlToJson,
  computeHmacSha256,
  generateEd25519KeyPair,
  generateLicenseKey,
  getStorageEncryptionKey,
  hashLicenseKey,
  hashPassword,
  jsonToBase64Url,
  normalizeLicenseKey,
  signEd25519,
  timingSafeEqual,
  validateAndImportEd25519KeyPair,
  verifyEd25519,
  verifyHmacSha256,
  verifyPassword,
} from "../src/infra/crypto";

describe("V1 cryptographic primitives", () => {
  it.each([undefined, "", "   ", "short_key"])("rejects an unusable storage encryption key %j", (key) => {
    expect(() => getStorageEncryptionKey({ STORAGE_ENCRYPTION_KEY: key }))
      .toThrow(/STORAGE_ENCRYPTION_KEY/);
  });

  it("uses the configured storage key after removing surrounding whitespace", () => {
    const key = "local-test-encryption-key-32-bytes";
    expect(getStorageEncryptionKey({ STORAGE_ENCRYPTION_KEY: `  ${key}\n` })).toBe(key);
  });

  it("hashes passwords with a unique salt and verifies only the original password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong", first)).resolves.toBe(false);
    await expect(verifyPassword("anything", "malformed")).resolves.toBe(false);
  });

  it("keeps HMAC verification strict for the exact payload and key", async () => {
    const signature = await computeHmacSha256("payload", "secret");
    await expect(verifyHmacSha256("payload", "secret", signature)).resolves.toBe(true);
    await expect(verifyHmacSha256("tampered", "secret", signature)).resolves.toBe(false);
    await expect(verifyHmacSha256("payload", "other", signature)).resolves.toBe(false);
  });

  it("round-trips and authenticates Ed25519 signatures", async () => {
    const pair = await generateEd25519KeyPair();
    expect(base64ToBuffer(pair.publicKeyBase64)).toHaveLength(32);
    await expect(validateAndImportEd25519KeyPair(pair.privateKeyPkcs8Base64, pair.publicKeyBase64))
      .resolves.toEqual(pair);
    const signature = await signEd25519("signed-license-input", pair.privateKeyPkcs8Base64);
    await expect(verifyEd25519("signed-license-input", signature, pair.publicKeyBase64)).resolves.toBe(true);
    await expect(verifyEd25519("tampered", signature, pair.publicKeyBase64)).resolves.toBe(false);
  });

  it("normalizes license keys only at the hashing boundary", async () => {
    const key = generateLicenseKey();
    expect(key).toMatch(/^LIC-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){3}-[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(normalizeLicenseKey(`  ${key.toLowerCase()}  `)).toBe(key.replace(/-/g, ""));
    await expect(hashLicenseKey(key)).resolves.toBe(await hashLicenseKey(key.toLowerCase()));
  });

  it("encodes the V1 signed-token JSON without changing its fields", () => {
    const value = { alg: "EdDSA", typ: "licenkit-license+jwt", kid: "key_01" };
    expect(base64UrlToJson(jsonToBase64Url(value))).toEqual(value);
  });

  it("uses constant-shape equality semantics", () => {
    expect(timingSafeEqual("same", "same")).toBe(true);
    expect(timingSafeEqual("same", "different")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
