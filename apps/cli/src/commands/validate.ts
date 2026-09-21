import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import { apiValidate } from "../lib/client-api";
import { verifyCredentialResponse } from "../lib/credentials";
import { describeClientError } from "../lib/errors";
import { loadStoredLicense, saveStoredLicense } from "../lib/storage";

export async function validateCommand(): Promise<void> {
  try {
    const stored = loadStoredLicense();
    if (!stored) throw new Error("No local activation. Run 'licenkit activate <key>' first.");
    const fingerprint = await getMachineFingerprint();
    const response = await apiValidate({
      serverUrl: stored.serverUrl,
      instanceId: stored.instanceId,
      productId: stored.productId,
      activationId: stored.activationId,
      machineToken: stored.machineToken,
      fingerprint,
      devicePlatform: stored.devicePlatform,
      releaseVersion: stored.releaseVersion,
      releasePlatform: stored.releasePlatform,
    });
    if (response.activation_id !== stored.activationId) {
      throw new Error("Server validation response changed the activation identity");
    }
    await verifyCredentialResponse(response, stored.trustedSigningKeys ?? {}, {
      instanceId: stored.instanceId,
      productId: stored.productId,
      activationId: stored.activationId,
      fingerprint,
      releaseVersion: stored.releaseVersion,
      releasePlatform: stored.releasePlatform,
    });

    saveStoredLicense({
      ...stored,
      machineToken: response.machine_token,
      credentialMode: response.credential_mode,
      signedLicenseToken: response.signed_license_token || undefined,
      signingKeyId: response.signing_key_id || undefined,
      lastValidatedAt: new Date().toISOString(),
      licenseExpiresAt: response.license_expires_at,
      terms: response.terms,
    });
    console.log(pc.bold(pc.green("✔ License validated online")));
    console.log(`  ${pc.gray("Activation ID:")} ${response.activation_id}`);
    console.log(`  ${pc.gray("Credential mode:")} ${response.credential_mode}`);
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
