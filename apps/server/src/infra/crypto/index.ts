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
  return calculatedHash === expectedHash;
}

// --- 2. Envelope Encryption (AES-256-GCM) ---
async function deriveAesKey(masterKeyHexOrStr: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const rawKey = encoder.encode(masterKeyHexOrStr.padEnd(32, "0").slice(0, 32));
  return await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptEnvelope(plaintext: string, masterSecret: string): Promise<string> {
  const key = await deriveAesKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encoded
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return bufferToBase64(combined);
}

export async function decryptEnvelope(encryptedBase64: string, masterSecret: string): Promise<string> {
  const key = await deriveAesKey(masterSecret);
  const combined = base64ToBuffer(encryptedBase64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

// --- 3. JWT Session Tokens (HMAC-SHA256) ---
export interface JWTPayload {
  userId: string;
  accountId: string;
  email: string;
  role: "owner" | "admin" | "member";
  exp: number; // Unix timestamp in seconds
  iat: number;
}

export async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = bufferToBase64(encoder.encode(JSON.stringify(header)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const encodedPayload = bufferToBase64(encoder.encode(JSON.stringify(payload)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(dataToSign));
  const encodedSignature = bufferToBase64(signature)
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return `${dataToSign}.${encodedSignature}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const dataToSign = `${headerB64}.${payloadB64}`;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Reconstruct standard Base64
    const b64 = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
    const signatureBytes = base64ToBuffer(padded);

    const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(dataToSign));
    if (!valid) return null;

    // Decode payload
    const payloadJson = new TextDecoder().decode(
      base64ToBuffer(payloadB64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadB64.length / 4) * 4, "="))
    );
    const payload = JSON.parse(payloadJson) as JWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
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

/**
 * Retrieves and strictly validates the JWT Authentication Secret.
 * Zero in-code fallback: throws ConfigurationError if missing or insecure.
 */
export function getJwtSecret(env: { JWT_SECRET?: string }): string {
  const secret = env?.JWT_SECRET?.trim();
  if (!secret) {
    throw new ConfigurationError(
      "JWT_SECRET is required. Please configure it in .dev.vars (local development) or via 'npx wrangler secret put JWT_SECRET' (production)."
    );
  }
  if (secret.length < 16) {
    throw new ConfigurationError(
      "JWT_SECRET must be at least 16 characters long."
    );
  }
  return secret;
}

// --- 4. Webhook HMAC-SHA256 Signature Verification ---
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
 * Verifies official Paddle Billing webhook signature (`Paddle-Signature` header).
 * Format: `ts=1695287625;h1=028b03063806013a270f2095f32b4b248a318f7...`
 * Signature is computed over `${ts}:${rawBody}` using the webhook endpoint secret.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secretKey: string,
  toleranceSeconds: number = 300
): Promise<boolean> {
  if (!signatureHeader || !secretKey) return false;

  try {
    const parts = signatureHeader.split(";").map((p) => p.trim());
    let ts: string | null = null;
    let h1: string | null = null;

    for (const part of parts) {
      const [k, v] = part.split("=");
      if (k === "ts") ts = v;
      if (k === "h1") h1 = v;
    }

    if (!ts || !h1) return false;

    // Check timestamp drift (anti-replay)
    const timestampSec = parseInt(ts, 10);
    if (isNaN(timestampSec)) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampSec) > toleranceSeconds) {
      return false;
    }

    const dataToSign = `${ts}:${rawBody}`;
    return await verifyHmacSha256(dataToSign, secretKey, h1);
  } catch {
    return false;
  }
}

/**
 * Verifies official Stripe webhook signature (`Stripe-Signature` header).
 * Format: `t=1492774577,v1=5257a869e7ece2259f4a0ce354813b2bdec514f7263cb372f9e8a78624f97759,v0=...`
 * Signature is computed over `${t}.${rawBody}` using the endpoint secret (`whsec_...`).
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secretKey: string,
  toleranceSeconds: number = 300
): Promise<boolean> {
  if (!signatureHeader || !secretKey) return false;

  try {
    const items = signatureHeader.split(",").map((i) => i.trim());
    let timestamp: string | null = null;
    const signatures: string[] = [];

    for (const item of items) {
      const [k, v] = item.split("=");
      if (k === "t") timestamp = v;
      if (k === "v1" && v) signatures.push(v);
    }

    if (!timestamp || signatures.length === 0) return false;

    const timestampSec = parseInt(timestamp, 10);
    if (isNaN(timestampSec)) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampSec) > toleranceSeconds) {
      return false;
    }

    const dataToSign = `${timestamp}.${rawBody}`;
    for (const sig of signatures) {
      const isValid = await verifyHmacSha256(dataToSign, secretKey, sig);
      if (isValid) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Verifies Lemon Squeezy webhook signature (`x-signature` header).
 * Signature is computed over `rawBody` using the endpoint secret.
 */
export async function verifyLemonSqueezySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secretKey: string
): Promise<boolean> {
  if (!signatureHeader || !secretKey) return false;
  return await verifyHmacSha256(rawBody, secretKey, signatureHeader);
}

/**
 * Standard formatted license key generator: `LIC-XXXX-XXXX-XXXX-XXXX`
 * Uses Crockford base32 alphabet (no easily confused 0, O, 1, I).
 */
export function generateLicenseKey(prefix = "LIC"): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = (len: number) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${prefix}-${part(4)}-${part(4)}-${part(4)}-${part(4)}`;
}

// --- 5. Ed25519 Key Generation, Import, Signing & Verification ---
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

// --- 6. Offline Ed25519 License Token Assembly & Verification ---
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

export interface OfflineTokenHeader {
  alg: "Ed25519";
  typ: "LK-TOKEN" | "LK-TRIAL";
  kid?: string;
}

export interface OfflineLicenseClaims {
  typ: "license";
  lic_id: string; // 内部 License ID
  sub: string;    // License Key (e.g. LIC-ABCD-1234-EFGH-5678)
  acc: string;    // Account ID
  prd: string;    // Product ID
  pol: string;    // Policy ID
  fp: string;     // Machine Fingerprint
  iat: number;    // Issued At (Unix timestamp in seconds)
  exp: number;    // Offline Grace Expiration (Unix timestamp in seconds)
  fea?: string[]; // Features list
  meta?: Record<string, any>;
}

export interface OfflineTrialClaims {
  typ: "trial";
  acc: string;    // Account ID
  prd: string;    // Product ID
  fp: string;     // Machine Fingerprint
  iat: number;    // Issued At (Unix timestamp in seconds)
  exp: number;    // Trial Expiration (Unix timestamp in seconds)
  fea?: string[]; // Features list
}

export type OfflineTokenClaims = OfflineLicenseClaims | OfflineTrialClaims;

export async function signOfflineToken(
  header: OfflineTokenHeader,
  claims: OfflineTokenClaims,
  privateKeyPkcs8Base64: string
): Promise<string> {
  const headerB64 = jsonToBase64Url(header);
  const claimsB64 = jsonToBase64Url(claims);
  const dataToSign = `${headerB64}.${claimsB64}`;

  const sigBase64 = await signEd25519(dataToSign, privateKeyPkcs8Base64);
  const sigB64Url = base64ToBase64Url(sigBase64);

  return `${dataToSign}.${sigB64Url}`;
}

export async function verifyOfflineToken(
  token: string,
  publicKeyBase64: string
): Promise<{
  valid: boolean;
  header?: OfflineTokenHeader;
  claims?: OfflineTokenClaims;
  error?: string;
}> {
  try {
    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Malformed token: expected 3 dot-separated parts" };
    }

    const [headerB64, claimsB64, signatureB64Url] = parts;
    const dataToVerify = `${headerB64}.${claimsB64}`;
    const signatureBase64 = base64UrlToBase64(signatureB64Url);

    // Verify Ed25519 signature
    const isSigValid = await verifyEd25519(dataToVerify, signatureBase64, publicKeyBase64);
    if (!isSigValid) {
      return { valid: false, error: "Cryptographic signature verification failed" };
    }

    // Decode header and claims
    const header = base64UrlToJson<OfflineTokenHeader>(headerB64);
    const claims = base64UrlToJson<OfflineTokenClaims>(claimsB64);

    return {
      valid: true,
      header,
      claims,
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Failed to decode or verify token" };
  }
}

