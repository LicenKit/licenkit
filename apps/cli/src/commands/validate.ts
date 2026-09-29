import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import {
  apiValidate,
  ClientContractError,
  effectiveValidationIntervalSeconds,
} from "../lib/client-api";
import { verifyValidationCredentialUpdate } from "../lib/credentials";
import { SignedTokenError } from "../lib/crypto";
import { describeEntitlementState, entitlementStateIsUsable } from "../lib/entitlement";
import { describeClientError } from "../lib/errors";
import { clearStoredLicense, loadStoredLicense, saveStoredLicense } from "../lib/storage";

export async function validateCommand(): Promise<void> {
  try {
    const stored = loadStoredLicense();
    if (!stored) throw new Error("No local activation. Run 'licenkit activate <key>' first.");
    const fingerprint = await getMachineFingerprint();
    const response = await apiValidate({
      serverUrl: stored.serverUrl,
      productId: stored.productId,
      fingerprint,
      releaseVersion: stored.releaseVersion,
      releasePlatform: stored.releasePlatform,
      releaseArch: stored.releaseArch,
      credential: {
        kind: "license",
        activation_id: stored.activationId,
      },
    });
    const effectiveInterval = effectiveValidationIntervalSeconds(
      response.validation.validation_interval_seconds
    );
    let nextStored = {
      ...stored,
      lastValidatedAt: response.validation.validated_at,
      validationIntervalSeconds: effectiveInterval,
      offlineGraceSeconds: response.validation.offline_grace_seconds,
      lastValidationRequestId: response.meta.request_id,
      lastEntitlementState: response.state,
    };

    if (response.state.kind === "license" && response.state.status === "active") {
      if (stored.credentialMode === "signed" && !response.credential_update) {
        throw new ClientContractError(
          "Signed License validation did not return a credential update",
          200,
          response.meta.request_id
        );
      }
      if (response.credential_update) {
        if (response.credential_update.credential_mode !== stored.credentialMode) {
          throw new ClientContractError(
            "Validation response changed the credential mode",
            200,
            response.meta.request_id
          );
        }
        try {
          await verifyValidationCredentialUpdate(
            response.credential_update,
            stored.trustedSigningKeys ?? {},
            {
              productId: stored.productId,
              activationId: stored.activationId,
              fingerprint,
              releaseVersion: stored.releaseVersion,
              releasePlatform: stored.releasePlatform,
              releaseArch: stored.releaseArch,
            },
            response.state
          );
        } catch (error) {
          if (error instanceof SignedTokenError) {
            throw new ClientContractError(
              "Signed credential update failed verification: " + error.message,
              200,
              response.meta.request_id,
              { signed_error_code: error.code }
            );
          }
          if (error instanceof ClientContractError) {
            throw new ClientContractError(error.message, 200, response.meta.request_id, error.details);
          }
          throw error;
        }
        nextStored = {
          ...nextStored,
          credentialMode: response.credential_update.credential_mode,
          signedLicenseToken: response.credential_update.signed_license_token || undefined,
          signingKeyId: response.credential_update.signing_key_id || undefined,
        };
      }
      nextStored = {
        ...nextStored,
        licenseExpiresAt: response.state.expires_at,
        terms: response.state.terms,
      };
    }

    saveStoredLicense(nextStored);
    const usable = entitlementStateIsUsable(response.state);
    console.log(
      usable
        ? pc.bold(pc.green("✔ Authorization validated online"))
        : pc.bold(pc.yellow("Authorization is not usable"))
    );
    for (const line of describeEntitlementState(response.state)) console.log("  " + line);
    console.log("  " + pc.gray("Validated at:") + " " + response.validation.validated_at);
    console.log(
      "  " + pc.gray("Validation interval:") + " " + effectiveInterval
      + "s"
    );
    console.log(
      "  " + pc.gray("Offline grace:") + " "
      + (response.validation.offline_grace_seconds === null
        ? "not applicable"
        : response.validation.offline_grace_seconds + "s")
    );
    console.log("  " + pc.gray("Request ID:") + " " + response.meta.request_id);

    if (response.state.kind === "license" && response.state.status === "activation_deactivated") {
      clearStoredLicense();
      console.log(pc.yellow("  Local credentials cleared because the Activation is deactivated."));
    }
    if (!usable) process.exitCode = 2;
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
