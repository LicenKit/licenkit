import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import { apiValidate } from "../lib/client-api";
import { loadStoredLicense, saveStoredLicense } from "../lib/storage";

export async function validateCommand(): Promise<void> {
  const stored = loadStoredLicense();

  if (!stored) {
    console.error(pc.red("Error: No active license found locally. Run 'licenkit activate <key>' first."));
    process.exit(1);
  }

  console.log(pc.cyan(`Validating license against server: ${stored.serverUrl}`));
  const fingerprint = await getMachineFingerprint();

  try {
    const result = await apiValidate({
      serverUrl: stored.serverUrl,
      accountId: stored.accountId,
      licenseKey: stored.licenseKey,
      fingerprint,
    });

    if (!result.valid) {
      console.error();
      console.error(pc.bold(pc.red("✖ License validation failed on server: ")), result.reason || "LICENSE_INVALID");
      console.error();
      process.exit(1);
    }

    // Update stored token and timestamps
    stored.lastValidatedAt = new Date().toISOString();
    if (result.token) {
      stored.token = result.token;
    }
    if (result.token_expires_at) {
      stored.tokenExpiresAt = result.token_expires_at;
    }
    stored.licenseExpiresAt = result.license_expires_at;

    saveStoredLicense(stored);

    const formatTimestamp = (val: number | string | null | undefined, fallback: string) => {
      if (!val) return fallback;
      if (typeof val === "number") return new Date(val * 1000).toISOString();
      return String(val);
    };

    console.log();
    console.log(pc.bold(pc.green("✔ License validated successfully (Heartbeat recorded)")));
    console.log(`  ${pc.gray("Key:")}            ${pc.bold(stored.licenseKey)}`);
    console.log(`  ${pc.gray("Status:")}         ${pc.green("ACTIVE")}`);
    console.log(`  ${pc.gray("Token Expires:")}  ${formatTimestamp(result.token_expires_at || stored.tokenExpiresAt, "N/A")}`);
    console.log(`  ${pc.gray("Last Heartbeat:")} ${formatTimestamp(result.last_heartbeat_at || stored.lastValidatedAt, "N/A")}`);
    console.log();
  } catch (err: any) {
    console.error();
    console.error(pc.bold(pc.red(`✖ Validation request failed [${err.code || "ERROR"}]:`)), err.message);
    console.error();
    process.exit(1);
  }
}
