import pc from "picocolors";
import os from "node:os";
import { getMachineFingerprint } from "../lib/machine";
import { apiActivate, apiFetchProductPublicKey } from "../lib/client-api";
import { saveStoredLicense, type StoredLicenseData } from "../lib/storage";
import { base64UrlToJson, type OfflineLicenseClaims } from "../lib/crypto";

export interface ActivateOptions {
  server?: string;
  account?: string;
  name?: string;
  pubkey?: string;
}

export async function activateCommand(licenseKey: string, options: ActivateOptions): Promise<void> {
  const serverUrl = options.server || process.env.LICENKIT_SERVER_URL || "http://localhost:8787";
  const accountId = options.account || process.env.LICENKIT_ACCOUNT_ID;

  if (!accountId) {
    console.error(pc.red("Error: Account ID is required. Pass --account <accountId> or set LICENKIT_ACCOUNT_ID."));
    process.exit(1);
  }

  if (!licenseKey) {
    console.error(pc.red("Error: License key is required. Syntax: licenkit activate <licenseKey>"));
    process.exit(1);
  }

  console.log(pc.cyan(`Connecting to LicenKit server: ${serverUrl}`));
  console.log(pc.gray("Collecting unique hardware fingerprint..."));

  const fingerprint = await getMachineFingerprint();
  const machineName = options.name || os.hostname();

  try {
    const result = await apiActivate({
      serverUrl,
      accountId,
      licenseKey: licenseKey.trim(),
      fingerprint,
      platform: os.platform(),
      name: machineName,
    });

    let publicKey = options.pubkey;
    let productId: string | undefined;

    // If Ed25519 token returned, extract product ID and fetch public key if not provided
    if (result.token) {
      try {
        const parts = result.token.split(".");
        if (parts.length === 3) {
          const claims = base64UrlToJson<OfflineLicenseClaims>(parts[1]);
          productId = claims.prd;
        }
      } catch {}

      if (!publicKey && productId) {
        try {
          const keyInfo = await apiFetchProductPublicKey(serverUrl, accountId, productId);
          publicKey = keyInfo.publicKey;
        } catch (e: any) {
          console.warn(pc.yellow(`Warning: Could not automatically cache product public key: ${e.message}`));
        }
      }
    }

    const nowIso = new Date().toISOString();
    const storedData: StoredLicenseData = {
      serverUrl,
      accountId,
      productId,
      licenseKey: licenseKey.trim(),
      token: result.token || "",
      publicKey,
      machineId: result.machine_id,
      activatedAt: nowIso,
      lastValidatedAt: nowIso,
      tokenExpiresAt: result.token_expires_at || undefined,
      licenseExpiresAt: result.license_expires_at,
      policy: result.policy
        ? {
            name: result.policy.name,
            maxMachines: result.policy.max_machines,
            offlineGracePeriod: result.policy.offline_grace_period,
            features: result.policy.features,
          }
        : undefined,
    };

    saveStoredLicense(storedData);

    console.log();
    console.log(pc.bold(pc.green("✔ License activated successfully!")));
    console.log(`  ${pc.gray("Key:")}             ${pc.bold(licenseKey)}`);
    console.log(`  ${pc.gray("Machine Seat ID:")} ${result.machine_id} ${result.reused ? pc.yellow("(Seat Reused)") : pc.green("(New Seat)")}`);
    console.log(`  ${pc.gray("Fingerprint:")}     ${fingerprint}`);
    console.log(`  ${pc.gray("Policy:")}          ${result.policy?.name}`);
    console.log(`  ${pc.gray("Max Machines:")}    ${result.policy?.max_machines}`);
    console.log(`  ${pc.gray("Entitlements:")}    ${result.policy?.features?.length ? result.policy.features.join(", ") : "(None)"}`);
    console.log(`  ${pc.gray("Grace Expires:")}   ${result.token_expires_at || "N/A"}`);
    console.log(`  ${pc.gray("License Expires:")} ${result.license_expires_at || "Perpetual (Never)"}`);
    if (publicKey) {
      console.log(`  ${pc.gray("Public Key:")}      ${pc.green("Cached for offline verification")}`);
    }
    console.log();
  } catch (err: any) {
    console.error();
    console.error(pc.bold(pc.red(`✖ Activation failed [${err.code || "ERROR"}]:`)), err.message);
    console.error();
    process.exit(1);
  }
}
