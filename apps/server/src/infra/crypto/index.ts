/**
 * LicenKit WebCrypto Infrastructure
 * Uses standard WebCrypto API native to Cloudflare Workers runtime.
 * Zero external cryptographic library dependencies.
 */

export class ConfigurationError extends Error {
  code = "CONFIGURATION_ERROR";
  status = 500;
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// --- Base64 Utilities ---
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- 1. Password Hashing (PBKDF2-HMAC-SHA256) ---
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8
  );

  const saltB64 = bufferToBase64(salt);
  const hashB64 = bufferToBase64(derivedBits);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${saltB64}$${hashB64}`;
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return diff === 0;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") {
    return false;
  }
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBuffer(parts[2]);
  const expectedHash = parts[3];

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8
  );

  const calculatedHash = bufferToBase64(derivedBits);
  return timingSafeEqual(calculatedHash, expectedHash);
}

/**
 * Retrieves and strictly validates the Storage Encryption Key (KEK).
 * Zero in-code fallback: throws ConfigurationError if missing or insecure.
 */
export function getStorageEncryptionKey(env: { STORAGE_ENCRYPTION_KEY?: string }): string {
  const key = env?.STORAGE_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new ConfigurationError(
      "STORAGE_ENCRYPTION_KEY is required. Please configure it in .dev.vars (local development) or via 'npx wrangler secret put STORAGE_ENCRYPTION_KEY' (production)."
    );
  }
  if (key.length < 16) {
    throw new ConfigurationError(
      "STORAGE_ENCRYPTION_KEY must be at least 16 characters long for secure AES-256-GCM envelope encryption."
    );
  }
  return key;
}

// --- 2. HMAC-SHA256 ---
export function hexToBuffer(hex: string): Uint8Array {
  const cleanHex = hex.trim().toLowerCase();
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function computeHmacSha256(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bufferToHex(signature);
}

export async function verifyHmacSha256(
  payload: string,
  secret: string,
  expectedSignatureHex: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signatureBytes = hexToBuffer(expectedSignatureHex);
    return await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}

/**
 * Standard formatted license key generator: `LIC-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX`
 * Uses standard Crockford base32 alphabet (excludes ambiguous I, L, O, and U).
 * Extracts 26 characters (26 * 5 = 130 bits of true WebCrypto CSPRNG entropy)
 * with zero modulo bias via `b & 31`.
 */
export function generateLicenseKey(prefix = "LIC"): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Standard Crockford, excluding I L O U
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => chars[b & 31]).join(""); // 26 * 5 = 130 bits
  return `${prefix}-${body.slice(0, 6)}-${body.slice(6, 12)}-${body.slice(12, 18)}-${body.slice(18, 24)}-${body.slice(24)}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

export function normalizeLicenseKey(rawKey: string): string {
  return rawKey
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "");
}

export async function hashLicenseKey(cleanKey: string): Promise<string> {
  return sha256Hex(normalizeLicenseKey(cleanKey));
}

// --- 3. Ed25519 Key Generation, Import, Signing & Verification ---
export function stripPem(pemOrBase64: string): string {
  return pemOrBase64
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
}

export function formatPem(base64: string, type: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const clean = stripPem(base64);
  const chunks = clean.match(/.{1,64}/g)?.join("\n") || clean;
  return `-----BEGIN ${type}-----\n${chunks}\n-----END ${type}-----\n`;
}

export async function generateEd25519KeyPair(): Promise<{
  publicKeyBase64: string;
  privateKeyPkcs8Base64: string;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const rawPublic = (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer;
  const pkcs8Private = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;

  return {
    publicKeyBase64: bufferToBase64(rawPublic),
    privateKeyPkcs8Base64: bufferToBase64(pkcs8Private),
  };
}

// RFC 8410 PKCS#8 prefix for 32-byte Ed25519 private seed
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export async function validateAndImportEd25519KeyPair(
  privateKeyInput: string,
  publicKeyInput?: string
): Promise<{
  publicKeyBase64: string;
  privateKeyPkcs8Base64: string;
}> {
  const cleanPriv = stripPem(privateKeyInput);
  let privBytes: Uint8Array;
  try {
    privBytes = base64ToBuffer(cleanPriv);
  } catch {
    throw new Error("Invalid private key: not a valid Base64 / PEM encoding");
  }

  let pkcs8Bytes: Uint8Array;
  if (privBytes.byteLength === 32) {
    // Raw 32-byte seed - wrap into standard PKCS#8
    pkcs8Bytes = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
    pkcs8Bytes.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8Bytes.set(privBytes, ED25519_PKCS8_PREFIX.length);
  } else if (privBytes.byteLength === 48 || privBytes.byteLength > 32) {
    pkcs8Bytes = privBytes;
  } else {
    throw new Error(`Invalid private key length: expected 32 (raw seed) or 48 (PKCS#8) bytes, got ${privBytes.byteLength}`);
  }

  // Attempt WebCrypto import of private key
  let privateCryptoKey: CryptoKey;
  try {
    privateCryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Bytes,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
  } catch (err: any) {
    throw new Error(`Failed to parse Ed25519 private key: ${err?.message || "invalid format"}`);
  }

  // Handle Public Key
  let finalPublicKeyBase64 = "";
  if (publicKeyInput && publicKeyInput.trim()) {
    const cleanPub = stripPem(publicKeyInput);
    let pubBytes: Uint8Array;
    try {
      pubBytes = base64ToBuffer(cleanPub);
    } catch {
      throw new Error("Invalid public key: not a valid Base64 / PEM encoding");
    }

    let publicCryptoKey: CryptoKey;
    if (pubBytes.byteLength === 32) {
      publicCryptoKey = await crypto.subtle.importKey(
        "raw",
        pubBytes,
        { name: "Ed25519" },
        true,
        ["verify"]
      );
      finalPublicKeyBase64 = cleanPub;
    } else if (pubBytes.byteLength === 44) {
      // SPKI format
      publicCryptoKey = await crypto.subtle.importKey(
        "spki",
        pubBytes,
        { name: "Ed25519" },
        true,
        ["verify"]
      );
      const rawPub = (await crypto.subtle.exportKey("raw", publicCryptoKey)) as ArrayBuffer;
      finalPublicKeyBase64 = bufferToBase64(rawPub);
    } else {
      throw new Error(`Invalid public key length: expected 32 (raw) or 44 (SPKI) bytes, got ${pubBytes.byteLength}`);
    }

    // Verify keypair matching by signing and verifying a test challenge
    const testData = new TextEncoder().encode("LicenKit-Keypair-Verification-Challenge");
    const testSig = await crypto.subtle.sign({ name: "Ed25519" }, privateCryptoKey, testData);
    const isValid = await crypto.subtle.verify({ name: "Ed25519" }, publicCryptoKey, testSig, testData);

    if (!isValid) {
      throw new Error("Provided public key does NOT match the provided private key.");
    }
  } else {
    // If public key is omitted, in WebCrypto we can derive or require public key.
    // If no public key provided and PKCS#8 doesn't embed public key, require user to provide matching public key
    throw new Error("Public key is required when uploading an existing private key to ensure cryptographic integrity.");
  }

  return {
    publicKeyBase64: finalPublicKeyBase64,
    privateKeyPkcs8Base64: bufferToBase64(pkcs8Bytes),
  };
}

export async function signEd25519(
  data: string | Uint8Array,
  privateKeyPkcs8Base64: string
): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const privBuffer = base64ToBuffer(stripPem(privateKeyPkcs8Base64));
  const key = await crypto.subtle.importKey("pkcs8", privBuffer, { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return bufferToBase64(signature);
}

export async function verifyEd25519(
  data: string | Uint8Array,
  signatureBase64: string,
  publicKeyBase64: string
): Promise<boolean> {
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const pubBuffer = base64ToBuffer(stripPem(publicKeyBase64));
    const sigBuffer = base64ToBuffer(stripPem(signatureBase64));
    const key = await crypto.subtle.importKey("raw", pubBuffer, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBuffer, bytes);
  } catch {
    return false;
  }
}

// --- 4. Base64URL helpers used by the V1 signed-license contract ---
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBase64(base64Url: string): string {
  const b64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  return pad ? b64 + "=".repeat(4 - pad) : b64;
}

export function jsonToBase64Url(obj: any): string {
  const encoder = new TextEncoder();
  return base64ToBase64Url(bufferToBase64(encoder.encode(JSON.stringify(obj))));
}

export function base64UrlToJson<T = any>(base64Url: string): T {
  const decoder = new TextDecoder();
  const bytes = base64ToBuffer(base64UrlToBase64(base64Url));
  return JSON.parse(decoder.decode(bytes)) as T;
}

