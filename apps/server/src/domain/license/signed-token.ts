import { jsonToBase64Url, signEd25519, base64ToBase64Url } from "../../infra/crypto";

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

export function signedTokenExpiration(input: {
  issuedAt: Date;
  ttlSeconds: number;
  licenseExpiresAt: string | null;
}): Date {
  const ttlExpiry = input.issuedAt.getTime() + input.ttlSeconds * 1000;
  if (!input.licenseExpiresAt) return new Date(ttlExpiry);
  return new Date(Math.min(ttlExpiry, new Date(input.licenseExpiresAt).getTime()));
}
