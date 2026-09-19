import {
  ClientContractError,
  type ClientCredentialResponse,
  type LicenseTerms,
} from "./client-api";
import {
  decodeSignedLicenseHeader,
  evaluateSignedLicenseClaims,
  SignedTokenError,
  verifySignedLicenseToken,
  type ClaimsContext,
  type SignedLicenseClaims,
} from "./crypto";

export function parseTrustedSigningKeys(values: string[] | string | undefined): Record<string, string> {
  if (!values) return {};
  const result: Record<string, string> = {};
  for (const value of Array.isArray(values) ? values : [values]) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new ClientContractError("Signing keys must use --signing-key <key-id>=<base64-or-pem-public-key>");
    }
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function assertTerms(value: unknown): asserts value is LicenseTerms {
  const terms = value as LicenseTerms;
  if (
    !terms ||
    !Number.isSafeInteger(terms.max_activations) ||
    terms.max_activations < 1 ||
    !Array.isArray(terms.features) ||
    terms.features.some((feature) => typeof feature !== "string") ||
    !(["string", "number"].includes(typeof terms.updates_until) || terms.updates_until === null)
  ) {
    throw new ClientContractError("Server returned invalid License Terms");
  }
}

export async function verifyCredentialResponse(
  response: ClientCredentialResponse,
  trustedSigningKeys: Record<string, string>,
  context: ClaimsContext
): Promise<SignedLicenseClaims | undefined> {
  if (!response || typeof response !== "object") throw new ClientContractError("Server returned an invalid credential response");
  if (!response.activation_id || !response.machine_token) {
    throw new ClientContractError("Credential response is missing activation_id or machine_token");
  }
  assertTerms(response.terms);

  if (response.credential_mode === "opaque") {
    if (response.signed_license_token) {
      throw new ClientContractError("Opaque credential response unexpectedly contains a Signed License Token");
    }
    return undefined;
  }
  if (response.credential_mode !== "signed") {
    throw new ClientContractError(`Unknown credential_mode '${String(response.credential_mode)}'`);
  }
  if (!response.signed_license_token) throw new ClientContractError("Signed credential response is missing signed_license_token");
  const header = decodeSignedLicenseHeader(response.signed_license_token);
  if (!response.signing_key_id || response.signing_key_id !== header.kid) {
    throw new SignedTokenError("TOKEN_KEY_ID_MISMATCH", "Response signing_key_id does not match the protected kid");
  }
  const trustedKey = trustedSigningKeys[header.kid];
  if (!trustedKey) throw new SignedTokenError("TRUSTED_SIGNING_KEY_MISSING", `No trusted signing key is configured for '${header.kid}'`);
  const { claims } = await verifySignedLicenseToken(response.signed_license_token, trustedKey);
  const evaluation = evaluateSignedLicenseClaims(claims, { ...context, activationId: response.activation_id });
  if (!evaluation.valid) throw new SignedTokenError(evaluation.code ?? "TOKEN_CLAIMS_INVALID", evaluation.reason ?? "Signed License Token claims are invalid");
  return claims;
}
