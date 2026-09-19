export interface SignedLicenseHeader {
  alg: "EdDSA";
  typ: "licenkit-license+jwt";
  kid: string;
}

export interface SignedLicenseClaims {
  lic: string;
  act: string;
  acc: string;
  prd: string;
  rel: string;
  ver: string;
  plt: string;
  rat: number;
  fp: string;
  iat: number;
  exp: number;
  lexp: number | null;
  upd: number | null;
  fea: string[];
}

export class SignedTokenError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SignedTokenError";
  }
}

export function base64ToBuffer(base64: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Buffer.from(bytes).toString("base64");
}

export function base64UrlToBuffer(base64Url: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(base64Url)) {
    throw new SignedTokenError("TOKEN_BASE64URL_INVALID", "Token contains invalid Base64URL characters");
  }
  return base64ToBuffer(base64Url.replace(/-/g, "+").replace(/_/g, "/"));
}

export function stripPem(pemOrBase64: string): string {
  return pemOrBase64
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
}

function assertNoDuplicateTopLevelKeys(json: string): void {
  const keys = new Set<string>();
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(json[index] ?? "")) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const char = json[index++];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        return JSON.parse(json.slice(start, index));
      }
    }
    throw new SignedTokenError("TOKEN_JSON_INVALID", "Unterminated JSON string");
  };

  skipWhitespace();
  if (json[index++] !== "{") throw new SignedTokenError("TOKEN_JSON_INVALID", "Token segment must be a JSON object");
  while (index < json.length) {
    skipWhitespace();
    if (json[index] === "}") return;
    if (json[index] !== '"') throw new SignedTokenError("TOKEN_JSON_INVALID", "Token object key must be a string");
    const key = scanString();
    if (keys.has(key)) throw new SignedTokenError("TOKEN_DUPLICATE_CLAIM", `Duplicate token field '${key}'`);
    keys.add(key);
    skipWhitespace();
    if (json[index++] !== ":") throw new SignedTokenError("TOKEN_JSON_INVALID", "Token object field is missing ':'");

    let nestedDepth = 0;
    let inString = false;
    let escaped = false;
    while (index < json.length) {
      const char = json[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") nestedDepth += 1;
      else if (char === "}" || char === "]") {
        if (nestedDepth === 0 && char === "}") break;
        nestedDepth -= 1;
      } else if (char === "," && nestedDepth === 0) break;
      index += 1;
    }
    if (json[index] === ",") index += 1;
  }
  throw new SignedTokenError("TOKEN_JSON_INVALID", "Token object is not closed");
}

function parseStrictObject<T>(segment: string): T {
  const json = new TextDecoder().decode(base64UrlToBuffer(segment));
  assertNoDuplicateTopLevelKeys(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SignedTokenError("TOKEN_JSON_INVALID", error instanceof Error ? error.message : "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SignedTokenError("TOKEN_JSON_INVALID", "Token segment must decode to an object");
  }
  return parsed as T;
}

export function decodeSignedLicenseHeader(token: string): SignedLicenseHeader {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new SignedTokenError("TOKEN_FORMAT_INVALID", "Expected three JWS segments");
  const header = parseStrictObject<Record<string, unknown>>(parts[0]);
  const unknown = Object.keys(header).filter((key) => !["alg", "typ", "kid"].includes(key));
  if (unknown.length) throw new SignedTokenError("TOKEN_HEADER_UNSUPPORTED", `Unsupported protected header '${unknown[0]}'`);
  if (header.alg !== "EdDSA") throw new SignedTokenError("TOKEN_ALGORITHM_INVALID", "Protected alg must be EdDSA");
  if (header.typ !== "licenkit-license+jwt") {
    throw new SignedTokenError("TOKEN_TYPE_INVALID", "Protected typ must be licenkit-license+jwt");
  }
  if (typeof header.kid !== "string" || !header.kid) throw new SignedTokenError("TOKEN_KEY_ID_MISSING", "Protected kid is required");
  return header as unknown as SignedLicenseHeader;
}

export async function verifySignedLicenseToken(
  token: string,
  publicKeyInput: string
): Promise<{ header: SignedLicenseHeader; claims: SignedLicenseClaims }> {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new SignedTokenError("TOKEN_FORMAT_INVALID", "Expected three JWS segments");
  const header = decodeSignedLicenseHeader(token);
  const cleanPublicKey = stripPem(publicKeyInput);
  const publicKeyBytes = base64ToBuffer(cleanPublicKey);
  const signature = base64UrlToBuffer(parts[2]);
  const publicKeyBuffer = Uint8Array.from(publicKeyBytes).buffer;
  const signatureBuffer = Uint8Array.from(signature).buffer;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      publicKeyBytes.byteLength === 32 ? "raw" : "spki",
      publicKeyBuffer,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch (error) {
    throw new SignedTokenError("TRUSTED_KEY_INVALID", error instanceof Error ? error.message : "Invalid Ed25519 public key");
  }
  const verified = await crypto.subtle.verify(
    "Ed25519",
    key,
    signatureBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!verified) throw new SignedTokenError("TOKEN_SIGNATURE_INVALID", "Ed25519 signature verification failed");

  const claims = parseStrictObject<Record<string, unknown>>(parts[1]);
  const requiredStrings = ["lic", "act", "acc", "prd", "rel", "ver", "plt", "fp"] as const;
  for (const field of requiredStrings) {
    if (typeof claims[field] !== "string" || claims[field] === "") {
      throw new SignedTokenError("TOKEN_CLAIMS_INVALID", `Claim '${field}' must be a non-empty string`);
    }
  }
  for (const field of ["rat", "iat", "exp"] as const) {
    if (!Number.isSafeInteger(claims[field])) {
      throw new SignedTokenError("TOKEN_CLAIMS_INVALID", `Claim '${field}' must be an integer timestamp`);
    }
  }
  for (const field of ["lexp", "upd"] as const) {
    if (claims[field] !== null && !Number.isSafeInteger(claims[field])) {
      throw new SignedTokenError("TOKEN_CLAIMS_INVALID", `Claim '${field}' must be null or an integer timestamp`);
    }
  }
  if (!Array.isArray(claims.fea) || claims.fea.some((feature) => typeof feature !== "string")) {
    throw new SignedTokenError("TOKEN_CLAIMS_INVALID", "Claim 'fea' must be an array of strings");
  }
  const typed = claims as unknown as SignedLicenseClaims;
  if (typed.exp <= typed.iat) throw new SignedTokenError("TOKEN_CLAIMS_INVALID", "Token exp must be later than iat");
  if (typed.lexp !== null && typed.exp > typed.lexp) {
    throw new SignedTokenError("TOKEN_CLAIMS_INVALID", "Token exp cannot be later than License expiration");
  }
  return { header, claims: typed };
}

export interface ClaimsContext {
  accountId: string;
  productId: string;
  activationId: string;
  fingerprint: string;
  releaseVersion: string;
  releasePlatform: string;
  nowSeconds?: number;
}

export interface ClaimsEvaluation {
  valid: boolean;
  code?: string;
  reason?: string;
}

export function evaluateSignedLicenseClaims(claims: SignedLicenseClaims, context: ClaimsContext): ClaimsEvaluation {
  const now = context.nowSeconds ?? Math.floor(Date.now() / 1000);
  const comparisons: Array<[boolean, string, string]> = [
    [claims.acc === context.accountId, "TOKEN_ACCOUNT_MISMATCH", "Token account does not match configuration"],
    [claims.prd === context.productId, "TOKEN_PRODUCT_MISMATCH", "Token product does not match configuration"],
    [claims.act === context.activationId, "TOKEN_ACTIVATION_MISMATCH", "Token activation does not match server response"],
    [claims.fp.toLowerCase() === context.fingerprint.toLowerCase(), "TOKEN_FINGERPRINT_MISMATCH", "Token fingerprint does not match this device"],
    [claims.ver === context.releaseVersion, "TOKEN_RELEASE_VERSION_MISMATCH", "Token release version does not match this build"],
    [claims.plt === context.releasePlatform, "TOKEN_RELEASE_PLATFORM_MISMATCH", "Token release platform does not match this build"],
    [claims.iat <= now + 300, "TOKEN_ISSUED_IN_FUTURE", "Token issue time is in the future"],
    [claims.exp > now, "TOKEN_EXPIRED", "Signed License Token has expired"],
    [claims.lexp === null || claims.lexp > now, "LICENSE_EXPIRED", "License has expired"],
    [claims.upd === null || claims.rat <= claims.upd, "UPDATE_ENTITLEMENT_REQUIRED", "This build was released after the update entitlement ended"],
  ];
  const failure = comparisons.find(([matches]) => !matches);
  return failure ? { valid: false, code: failure[1], reason: failure[2] } : { valid: true };
}
