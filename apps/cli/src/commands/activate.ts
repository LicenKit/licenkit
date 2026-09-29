import pc from "picocolors";
import os from "node:os";
import { getMachineFingerprint } from "../lib/machine";
import { apiActivate, ClientContractError, effectiveValidationIntervalSeconds } from "../lib/client-api";
import { parseTrustedSigningKeys, verifyActivationResponse } from "../lib/credentials";
import { SignedTokenError } from "../lib/crypto";
import { describeClientError } from "../lib/errors";
import { saveStoredLicense } from "../lib/storage";

export interface ActivateOptions {
  server?: string;
  product?: string;
  release?: string;
  releasePlatform?: string;
  releaseArch?: string;
  name?: string;
  signingKey?: string | string[];
}

function required(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description} is required`);
  return value;
}

function devicePlatform(): string {
  const platform = os.platform() === "darwin" ? "macos" : os.platform();
  return `${platform}-${os.arch()}`;
}

export async function activateCommand(licenseKey: string, options: ActivateOptions): Promise<void> {
  try {
    const serverUrl = options.server || process.env.LICENKIT_SERVER_URL || "http://localhost:8787";
    const productId = required(options.product || process.env.LICENKIT_PRODUCT_ID, "Product ID");
    const releaseVersion = required(options.release || process.env.LICENKIT_RELEASE_VERSION, "Release version");
    const releasePlatform = required(
      options.releasePlatform || process.env.LICENKIT_RELEASE_PLATFORM,
      "Release platform"
    );
    const releaseArch = required(
      options.releaseArch || process.env.LICENKIT_RELEASE_ARCH,
      "Release architecture"
    );
    if (!licenseKey?.trim()) throw new Error("License key is required");

    const fingerprint = await getMachineFingerprint();
    const diagnosticPlatform = devicePlatform();
    const trustedSigningKeys = parseTrustedSigningKeys(options.signingKey);
    const normalizedLicenseKey = licenseKey.trim();
    const response = await apiActivate({
      serverUrl,
      productId,
      licenseKey: normalizedLicenseKey,
      fingerprint,
      devicePlatform: diagnosticPlatform,
      releaseVersion,
      releasePlatform,
      releaseArch,
      name: options.name || os.hostname(),
    });
    try {
      await verifyActivationResponse(response, trustedSigningKeys, {
        productId,
        activationId: response.activation_id,
        fingerprint,
        releaseVersion,
        releasePlatform,
        releaseArch,
      });
    } catch (error) {
      if (error instanceof SignedTokenError) {
        throw new ClientContractError(
          "Signed activation credential failed verification: " + error.message,
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

    saveStoredLicense({
      serverUrl,
      productId,
      releaseVersion,
      releasePlatform,
      releaseArch,
      devicePlatform: diagnosticPlatform,
      activationId: response.activation_id,
      credentialMode: response.credential_mode,
      signedLicenseToken: response.signed_license_token || undefined,
      signingKeyId: response.signing_key_id || undefined,
      trustedSigningKeys: response.credential_mode === "signed" ? trustedSigningKeys : undefined,
      activatedAt: response.validation.validated_at,
      lastValidatedAt: response.validation.validated_at,
      validationIntervalSeconds: effectiveValidationIntervalSeconds(
        response.validation.validation_interval_seconds
      ),
      offlineGraceSeconds: response.validation.offline_grace_seconds,
      lastValidationRequestId: response.meta.request_id,
      lastEntitlementState: response.state,
      licenseExpiresAt: response.license_expires_at,
      terms: response.terms,
    });

    console.log(pc.bold(pc.green("✔ License activated")));
    console.log(`  ${pc.gray("Activation ID:")} ${response.activation_id}`);
    console.log(`  ${pc.gray("Credential mode:")} ${response.credential_mode}`);
    console.log(`  ${pc.gray("Release:")} ${releaseVersion} (${releasePlatform}/${releaseArch})`);
    console.log("  " + pc.gray("Validated at:") + " " + response.validation.validated_at);
    console.log("  " + pc.gray("Request ID:") + " " + response.meta.request_id);
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
