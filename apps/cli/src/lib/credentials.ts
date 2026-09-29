import {
  ClientContractError,
  type ActivationResponse,
  type ActiveLicenseState,
  type CredentialUpdate,
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
    !(typeof terms.updates_until === "string" || terms.updates_until === null)
  ) {
    throw new ClientContractError("Server returned invalid License Terms");
  }
}

function timestampSeconds(value: string | null): number | null {
  return value === null ? null : Math.floor(Date.parse(value) / 1000);
}

function sameFeatures(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((feature, index) => feature === right[index]);
}

function verifyClaimsMatchResponse(
  claims: SignedLicenseClaims,
  credential: CredentialUpdate,
  state: ActiveLicenseState
): void {
  if (claims.lexp !== timestampSeconds(state.expires_at)) {
    throw new SignedTokenError("TOKEN_LICENSE_EXPIRY_MISMATCH", "Token lexp does not match the active License state");
  }
  if (claims.upd !== timestampSeconds(state.terms.updates_until)) {
    throw new SignedTokenError("TOKEN_UPDATE_ENTITLEMENT_MISMATCH", "Token upd does not match the active License state");
  }
  if (!sameFeatures(claims.fea, state.terms.features)) {
    throw new SignedTokenError("TOKEN_FEATURES_MISMATCH", "Token features do not match the active License state");
  }
}

export async function verifyActivationResponse(
  response: ActivationResponse,
  trustedSigningKeys: Record<string, string>,
  context: ClaimsContext
): Promise<SignedLicenseClaims | undefined> {
  if (!response || typeof response !== "object") throw new ClientContractError("Server returned an invalid credential response");
  if (!response.activation_id) {
    throw new ClientContractError("Credential response is missing activation_id");
  }
  assertTerms(response.terms);
  if (response.state.kind !== "license" || response.state.status !== "active") {
    throw new ClientContractError("Successful activation must contain an active License state");
  }

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
  verifyClaimsMatchResponse(claims, response, response.state);
  return claims;
}

export async function verifyValidationCredentialUpdate(
  credential: CredentialUpdate,
  trustedSigningKeys: Record<string, string>,
  context: ClaimsContext,
  state: ActiveLicenseState
): Promise<SignedLicenseClaims | undefined> {
  if (credential.credential_mode === "opaque") {
    if (credential.signed_license_token || credential.signing_key_id) {
      throw new ClientContractError("Opaque credential update unexpectedly contains Signed License Token fields");
    }
    return undefined;
  }
  if (!credential.signed_license_token || !credential.signing_key_id) {
    throw new ClientContractError("Signed credential update is incomplete");
  }
  const header = decodeSignedLicenseHeader(credential.signed_license_token);
  if (credential.signing_key_id !== header.kid) {
    throw new SignedTokenError("TOKEN_KEY_ID_MISMATCH", "Credential update signing_key_id does not match the protected kid");
  }
  const trustedKey = trustedSigningKeys[header.kid];
  if (!trustedKey) {
    throw new SignedTokenError("TRUSTED_SIGNING_KEY_MISSING", "No trusted signing key is configured for the credential update");
  }
  const { claims } = await verifySignedLicenseToken(credential.signed_license_token, trustedKey);
  const evaluation = evaluateSignedLicenseClaims(claims, context);
  if (!evaluation.valid) {
    throw new SignedTokenError(evaluation.code ?? "TOKEN_CLAIMS_INVALID", evaluation.reason ?? "Signed License Token claims are invalid");
  }
  verifyClaimsMatchResponse(claims, credential, state);
  return claims;
}
