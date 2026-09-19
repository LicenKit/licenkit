import pc from "picocolors";
import os from "node:os";
import { getMachineFingerprint } from "../lib/machine";
import { apiActivate } from "../lib/client-api";
import { parseTrustedSigningKeys, verifyCredentialResponse } from "../lib/credentials";
import { describeClientError } from "../lib/errors";
import { saveStoredLicense } from "../lib/storage";

export interface ActivateOptions {
  server?: string;
  account?: string;
  product?: string;
  release?: string;
  releasePlatform?: string;
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
    const accountId = required(options.account || process.env.LICENKIT_ACCOUNT_ID, "Account ID");
    const productId = required(options.product || process.env.LICENKIT_PRODUCT_ID, "Product ID");
    const releaseVersion = required(options.release || process.env.LICENKIT_RELEASE_VERSION, "Release version");
    const releasePlatform = required(
      options.releasePlatform || process.env.LICENKIT_RELEASE_PLATFORM,
      "Release platform"
    );
    if (!licenseKey?.trim()) throw new Error("License key is required");

    const fingerprint = await getMachineFingerprint();
    const diagnosticPlatform = devicePlatform();
    const trustedSigningKeys = parseTrustedSigningKeys(options.signingKey);
    const response = await apiActivate({
      serverUrl,
      accountId,
      productId,
      licenseKey: licenseKey.trim(),
      fingerprint,
      devicePlatform: diagnosticPlatform,
      releaseVersion,
      releasePlatform,
      name: options.name || os.hostname(),
    });
    await verifyCredentialResponse(response, trustedSigningKeys, {
      accountId,
      productId,
      activationId: response.activation_id,
      fingerprint,
      releaseVersion,
      releasePlatform,
    });

    const now = new Date().toISOString();
    saveStoredLicense({
      serverUrl,
      accountId,
      productId,
      releaseVersion,
      releasePlatform,
      devicePlatform: diagnosticPlatform,
      activationId: response.activation_id,
      machineToken: response.machine_token,
      credentialMode: response.credential_mode,
      signedLicenseToken: response.signed_license_token || undefined,
      signingKeyId: response.signing_key_id || undefined,
      trustedSigningKeys: response.credential_mode === "signed" ? trustedSigningKeys : undefined,
      activatedAt: now,
      lastValidatedAt: now,
      licenseExpiresAt: response.license_expires_at,
      terms: response.terms,
    });

    console.log(pc.bold(pc.green("✔ License activated")));
    console.log(`  ${pc.gray("Activation ID:")} ${response.activation_id}`);
    console.log(`  ${pc.gray("Credential mode:")} ${response.credential_mode}`);
    console.log(`  ${pc.gray("Release:")} ${releaseVersion} (${releasePlatform})`);
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
