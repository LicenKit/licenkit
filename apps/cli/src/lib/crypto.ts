/**
 * LicenKit CLI Cryptographic Infrastructure
 * Pure native WebCrypto API implementation for offline Ed25519 token verification.
 * Zero external cryptographic library dependencies.
 */

export interface OfflineTokenHeader {
  alg: "Ed25519";
  typ: "LK-TOKEN" | "LK-TRIAL";
  kid: string;
}

export interface OfflineLicenseClaims {
  typ: "license";
  lic_id: string;
  sub: string; // License key, e.g. LIC-XXXX-XXXX-XXXX-XXXX
  acc: string; // Account/Workspace ID
  prd: string; // Product ID
  pol: string; // Policy ID
  fp: string; // Machine Hardware Fingerprint
  iat: number; // Issued at timestamp (seconds)
  exp: number; // Expiration timestamp (seconds)
  fea: string[]; // Enabled feature entitlements
}

export interface OfflineTrialClaims {
  typ: "trial";
  acc: string;
  prd: string;
  fp: string;
  iat: number;
  exp: number;
  fea: string[];
}

export type OfflineTokenClaims = OfflineLicenseClaims | OfflineTrialClaims;

// --- Base64 / Base64Url Utilities ---

export function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64UrlToBase64(base64Url: string): string {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return base64;
}

export function base64UrlToJson<T = any>(base64Url: string): T {
  const base64 = base64UrlToBase64(base64Url);
  const jsonStr = atob(base64);
  return JSON.parse(jsonStr);
}

export function stripPem(pemOrBase64: string): string {
  return pemOrBase64
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
}

/**
 * Verifies Ed25519 cryptographic signature using native WebCrypto API.
 * Accepts raw 32-byte public key (Base64 or SPKI PEM).
 */
export async function verifyEd25519(
  dataToVerify: string,
  signatureBase64: string,
  publicKeyInput: string
): Promise<boolean> {
  try {
    const cleanPub = stripPem(publicKeyInput);
    const rawPubBytes = base64ToBuffer(cleanPub);
    const signatureBytes = base64ToBuffer(signatureBase64);
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(dataToVerify);

    let cryptoKey: CryptoKey;

    if (rawPubBytes.byteLength === 32) {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        rawPubBytes as any,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
    } else {
      cryptoKey = await crypto.subtle.importKey(
        "spki",
        rawPubBytes as any,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
    }

    return await crypto.subtle.verify("Ed25519", cryptoKey, signatureBytes as any, dataBytes as any);
  } catch {
    return false;
  }
}

export interface TokenVerificationResult<T = OfflineTokenClaims> {
  valid: boolean;
  header?: OfflineTokenHeader;
  claims?: T;
  error?: string;
}

/**
 * Pure offline mathematical verification of an Ed25519 structured token.
 * Does NOT require network connectivity.
 */
export async function verifyOfflineToken<T = OfflineTokenClaims>(
  token: string,
  publicKeyInput: string
): Promise<TokenVerificationResult<T>> {
  try {
    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Malformed token format: expected 3 dot-separated Base64Url segments" };
    }

    const [headerB64Url, payloadB64Url, signatureB64Url] = parts;
    const dataToVerify = `${headerB64Url}.${payloadB64Url}`;
    const signatureBase64 = base64UrlToBase64(signatureB64Url);

    // 1. Verify mathematical Ed25519 signature
    const isSigValid = await verifyEd25519(dataToVerify, signatureBase64, publicKeyInput);
    if (!isSigValid) {
      return { valid: false, error: "Cryptographic signature verification failed (Token tampered or wrong public key)" };
    }

    // 2. Decode claims
    const header = base64UrlToJson<OfflineTokenHeader>(headerB64Url);
    const claims = base64UrlToJson<T>(payloadB64Url);

    return {
      valid: true,
      header,
      claims,
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Failed to parse or verify offline token" };
  }
}

export interface LicenseValidationEvaluation {
  valid: boolean;
  reasons: string[];
  isExpired: boolean;
  isFingerprintMatch: boolean;
  expiresInSeconds: number;
}

/**
 * Evaluates verified claims against current system constraints (time, machine fingerprint, feature).
 */
export function evaluateLicenseClaims(
  claims: OfflineTokenClaims,
  currentMachineFingerprint: string,
  requiredFeature?: string
): LicenseValidationEvaluation {
  const reasons: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  const expiresInSeconds = claims.exp - nowSec;
  const isExpired = expiresInSeconds <= 0;

  if (isExpired) {
    reasons.push(`License token expired ${Math.abs(expiresInSeconds)}s ago`);
  }

  const isFingerprintMatch = claims.fp.toLowerCase() === currentMachineFingerprint.toLowerCase();
  if (!isFingerprintMatch) {
    reasons.push(`Machine fingerprint mismatch: token bound to '${claims.fp}', current machine is '${currentMachineFingerprint}'`);
  }

  if (requiredFeature && !claims.fea.includes(requiredFeature)) {
    reasons.push(`Required feature entitlement '${requiredFeature}' is not granted in this license`);
  }

  return {
    valid: !isExpired && isFingerprintMatch && (!requiredFeature || claims.fea.includes(requiredFeature)),
    reasons,
    isExpired,
    isFingerprintMatch,
    expiresInSeconds,
  };
}
