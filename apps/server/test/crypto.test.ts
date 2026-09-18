import { describe, it, expect } from "vitest";
import {
  encryptEnvelope,
  decryptEnvelope,
  hashPassword,
  verifyPassword,
  generateEd25519KeyPair,
  validateAndImportEd25519KeyPair,
  signOfflineToken,
  verifyOfflineToken,
  generateLicenseKey,
  sha256Hex,
  normalizeLicenseKey,
  hashLicenseKey,
  generateMachineToken,
  hashMachineToken,
  timingSafeEqual,
  base64ToBuffer,
  bufferToBase64,
  base64UrlToJson,
  jsonToBase64Url,
  type OfflineTokenHeader,
  type OfflineLicenseClaims,
  type OfflineTrialClaims,
} from "../src/infra/crypto";

describe("WebCrypto Infrastructure - AES-256-GCM Envelope Encryption", () => {
  const masterSecretA = "master-secret-key-32-bytes-alpha!";
  const masterSecretB = "master-secret-key-32-bytes-beta!!";

  it("should encrypt and decrypt plaintext accurately", async () => {
    const plaintext = JSON.stringify({
      provider: "stripe",
      webhook_secret: "whsec_test_1234567890abcdef",
      mode: "live",
    });

    const ciphertext = await encryptEnvelope(plaintext, masterSecretA);
    expect(ciphertext).toBeDefined();
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = await decryptEnvelope(ciphertext, masterSecretA);
    expect(decrypted).toBe(plaintext);
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(plaintext));
  });

  it("should fail-fast and throw error when decrypted with wrong secret", async () => {
    const plaintext = "super-confidential-api-key";
    const ciphertext = await encryptEnvelope(plaintext, masterSecretA);

    await expect(decryptEnvelope(ciphertext, masterSecretB)).rejects.toThrow();
  });

  it("should fail-fast when ciphertext is corrupted or tampered", async () => {
    const plaintext = "secret-payload";
    const ciphertext = await encryptEnvelope(plaintext, masterSecretA);

    // Corrupt base64 string
    const bytes = base64ToBuffer(ciphertext);
    bytes[bytes.length - 2] ^= 0xff; // flip bits in authentication tag
    const corruptedCiphertext = bufferToBase64(bytes);

    await expect(decryptEnvelope(corruptedCiphertext, masterSecretA)).rejects.toThrow();
  });
});

describe("WebCrypto Infrastructure - PBKDF2-HMAC-SHA256 Password Hashing", () => {
  it("should generate salted hash and verify valid password", async () => {
    const password = "SuperSecretPassword123!";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^pbkdf2_sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it("should reject invalid password", async () => {
    const password = "CorrectPassword123!";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword("WrongPassword123!", hash);
    expect(isValid).toBe(false);
  });

  it("should return false on malformed stored hash", async () => {
    const isValid = await verifyPassword("any-pass", "invalid_format_hash");
    expect(isValid).toBe(false);
  });
});

describe("WebCrypto Infrastructure - Ed25519 Asymmetric Key Pair Lifecycle", () => {
  it("should generate a valid Ed25519 keypair with 32-byte raw public key", async () => {
    const keypair = await generateEd25519KeyPair();

    expect(keypair.publicKeyBase64).toBeDefined();
    expect(keypair.privateKeyPkcs8Base64).toBeDefined();

    const rawPub = base64ToBuffer(keypair.publicKeyBase64);
    expect(rawPub.byteLength).toBe(32);
  });

  it("should validate and import matching raw seed and public key via challenge verification", async () => {
    const keypair = await generateEd25519KeyPair();

    const imported = await validateAndImportEd25519KeyPair(
      keypair.privateKeyPkcs8Base64,
      keypair.publicKeyBase64
    );

    expect(imported.publicKeyBase64).toBe(keypair.publicKeyBase64);
    expect(imported.privateKeyPkcs8Base64).toBe(keypair.privateKeyPkcs8Base64);
  });

  it("should fail-fast and throw error when imported public key does NOT match private key", async () => {
    const keypairA = await generateEd25519KeyPair();
    const keypairB = await generateEd25519KeyPair();

    // Mismatched: privateKey from A, publicKey from B
    await expect(
      validateAndImportEd25519KeyPair(keypairA.privateKeyPkcs8Base64, keypairB.publicKeyBase64)
    ).rejects.toThrow("Provided public key does NOT match the provided private key.");
  });

  it("should fail-fast on malformed public key or private key input", async () => {
    await expect(
      validateAndImportEd25519KeyPair("invalid-priv-key", "invalid-pub-key")
    ).rejects.toThrow();
  });
});

describe("WebCrypto Infrastructure - Offline Ed25519 Structured Token", () => {
  it("should sign and verify offline license token with full claims and features", async () => {
    const keypair = await generateEd25519KeyPair();

    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TOKEN",
      kid: "key_product_v1",
    };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expSeconds = nowSeconds + 3600; // 1 hour validity

    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_01j7abc123",
      sub: "LIC-ABCD-1234-EFGH-5678",
      acc: "acc_workspace_01",
      prd: "prd_super_tool",
      pol: "pol_lifetime",
      fp: "mac-fpt-001122334455",
      iat: nowSeconds,
      exp: expSeconds,
      fea: ["pro_export", "unlimited_seats"],
    };

    const token = await signOfflineToken(header, claims, keypair.privateKeyPkcs8Base64);

    expect(token).toBeDefined();
    expect(token.split(".").length).toBe(3);

    // Verify token using raw 32B public key
    const verified = await verifyOfflineToken(token, keypair.publicKeyBase64);

    expect(verified.valid).toBe(true);
    expect(verified.header).toEqual(header);
    expect((verified.claims as OfflineLicenseClaims).lic_id).toBe(claims.lic_id);
    expect((verified.claims as OfflineLicenseClaims).sub).toBe(claims.sub);
    expect((verified.claims as OfflineLicenseClaims).fp).toBe(claims.fp);
    expect((verified.claims as OfflineLicenseClaims).fea).toEqual(["pro_export", "unlimited_seats"]);
  });

  it("should sign and verify offline trial token", async () => {
    const keypair = await generateEd25519KeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TRIAL",
      kid: "key_trial_v1",
    };

    const claims: OfflineTrialClaims = {
      typ: "trial",
      acc: "acc_01",
      prd: "prd_01",
      fp: "machine-fingerprint-trial-99",
      iat: nowSeconds,
      exp: nowSeconds + 86400 * 14,
      fea: ["basic_features"],
    };

    const token = await signOfflineToken(header, claims, keypair.privateKeyPkcs8Base64);
    const verified = await verifyOfflineToken(token, keypair.publicKeyBase64);

    expect(verified.valid).toBe(true);
    expect((verified.claims as OfflineTrialClaims).typ).toBe("trial");
    expect((verified.claims as OfflineTrialClaims).fp).toBe("machine-fingerprint-trial-99");
  });

  it("should fail-fast and reject token when payload has been tampered", async () => {
    const keypair = await generateEd25519KeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TOKEN",
      kid: "key_tamper_test",
    };

    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_tamper_01",
      sub: "LIC-ABCD-1234",
      acc: "acc_01",
      prd: "prd_01",
      pol: "pol_01",
      fp: "fp_orig",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      fea: ["free_tier"],
    };

    const token = await signOfflineToken(header, claims, keypair.privateKeyPkcs8Base64);
    const [headerB64, payloadB64, sigB64] = token.split(".");

    // Tamper payload: change fea from free_tier to enterprise
    const parsedPayload = base64UrlToJson<OfflineLicenseClaims>(payloadB64);
    parsedPayload.fea = ["enterprise_all_features_unlocked"];
    const tamperedPayloadB64 = jsonToBase64Url(parsedPayload);

    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;

    const res = await verifyOfflineToken(tamperedToken, keypair.publicKeyBase64);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Cryptographic signature verification failed");
  });

  it("should correctly detect expired claims in offline token", async () => {
    const keypair = await generateEd25519KeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TOKEN",
      kid: "key_expired",
    };

    const expiredClaims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: "lic_exp_01",
      sub: "LIC-EXPIRED-KEY",
      acc: "acc_01",
      prd: "prd_01",
      pol: "pol_01",
      fp: "fp_exp",
      iat: nowSeconds - 7200,
      exp: nowSeconds - 3600, // Expired 1 hour ago
      fea: [],
    };

    const token = await signOfflineToken(header, expiredClaims, keypair.privateKeyPkcs8Base64);
    const verified = await verifyOfflineToken(token, keypair.publicKeyBase64);

    expect(verified.valid).toBe(true);
    expect(verified.claims).toBeDefined();
    // Verify that client can reliably determine expiry
    const isExpired = (verified.claims?.exp || 0) < nowSeconds;
    expect(isExpired).toBe(true);
  });
});

describe("WebCrypto Infrastructure - License Key Generation (Crockford Base32 130-bit Entropy)", () => {
  it("should generate 26-char Crockford Base32 key with standard 6-6-6-6-2 grouping", () => {
    const key = generateLicenseKey();
    // Format: LIC-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX (prefix + 26 chars)
    expect(key).toMatch(/^LIC-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{2}$/);
    
    // Total raw entropy characters (excluding hyphens and prefix)
    const rawChars = key.replace(/^LIC-/, "").replace(/-/g, "");
    expect(rawChars.length).toBe(26);
  });

  it("should support custom prefix", () => {
    const key = generateLicenseKey("PRO");
    expect(key.startsWith("PRO-")).toBe(true);
    expect(key).toMatch(/^PRO-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{2}$/);
  });

  it("should strictly exclude ambiguous characters I, L, O, and U", () => {
    const forbidden = /[ILOUilou]/;
    for (let i = 0; i < 50; i++) {
      const key = generateLicenseKey();
      const body = key.slice(4); // exclude 'LIC-' prefix
      expect(forbidden.test(body)).toBe(false);
    }
  });

  it("should generate uniformly unique keys across multiple invocations", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateLicenseKey());
    }
    expect(keys.size).toBe(100);
  });
});

describe("WebCrypto Infrastructure - License Key Hashing & Machine Token Utilities", () => {
  it("normalizeLicenseKey should uppercase, strip spaces and hyphens", () => {
    expect(normalizeLicenseKey("lic-abcd-1234-efgh-5678-jk")).toBe("LICABCD1234EFGH5678JK");
    expect(normalizeLicenseKey("  lic-abcd-1234  ")).toBe("LICABCD1234");
    expect(normalizeLicenseKey("lic_abcd 1234")).toBe("LIC_ABCD1234");
  });

  it("hashLicenseKey should produce consistent 64-char hex SHA-256 hash regardless of formatting", async () => {
    const raw = "LIC-234567-ABCDEF-GHJKMN-PQRSTV-WX";
    const formattedWithSpaces = " lic-234567-abcdef-ghjkmn-pqrstv-wx ";
    const hash1 = await hashLicenseKey(raw);
    const hash2 = await hashLicenseKey(formattedWithSpaces);

    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
  });

  it("generateMachineToken and hashMachineToken should generate CSPRNG 256-bit token and matching hash", async () => {
    const token = generateMachineToken();
    expect(token).toMatch(/^mct_[0-9a-f]{64}$/);

    const tokenHash = await hashMachineToken(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);

    const tokenHash2 = await hashMachineToken(token);
    expect(tokenHash2).toBe(tokenHash);

    const token2 = generateMachineToken();
    expect(token2).not.toBe(token);
  });

  it("timingSafeEqual should accurately compare strings in constant time", () => {
    expect(timingSafeEqual("abc12345", "abc12345")).toBe(true);
    expect(timingSafeEqual("abc12345", "abc12346")).toBe(false);
    expect(timingSafeEqual("abc12345", "abc1234")).toBe(false);
    expect(timingSafeEqual("abc12345", "abc123456")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a", "")).toBe(false);
  });
});


