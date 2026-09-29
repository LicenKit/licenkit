import { jsonToBase64Url, signEd25519, base64ToBase64Url } from "../../infra/crypto";

export interface SignedLicenseClaims {
  lic: string;
  act: string;
  ins: string;
  prd: string;
  env: "sandbox" | "live";
  ver: string;
  plt: string;
  arc: string;
  fp: string;
  iat: number;
  lexp: number | null;
  upd: number | null;
  fea: string[];
}

export async function createSignedLicenseToken(input: {
  keyId: string;
  privateKeyPkcs8: string;
  claims: SignedLicenseClaims;
}): Promise<string> {
  const header = {
    alg: "EdDSA",
    typ: "licenkit-license+jwt",
    kid: input.keyId,
  };
  const encodedHeader = jsonToBase64Url(header);
  const encodedPayload = jsonToBase64Url(input.claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signEd25519(signingInput, input.privateKeyPkcs8);
  return `${signingInput}.${base64ToBase64Url(signature)}`;
}

export function signedClaimInstant(value: Date | string): Date {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Signed License Token claim time must be a valid instant.");
  }
  return new Date(Math.floor(timestamp / 1000) * 1000);
}
