import pc from "picocolors";
import { getDeviceMetadata } from "../lib/machine";
import { loadStoredLicense, getLicenseFilePath } from "../lib/storage";

export async function infoCommand(): Promise<void> {
  const meta = await getDeviceMetadata();
  const stored = loadStoredLicense();

  console.log();
  console.log(pc.bold(pc.cyan("=== LicenKit Machine & Environment Info ===")));
  console.log(`  ${pc.gray("Fingerprint:")}      ${pc.bold(pc.green(meta.fingerprint))}`);
  console.log(`  ${pc.gray("Platform:")}         ${meta.platform} (${meta.osType} ${meta.osRelease})`);
  console.log(`  ${pc.gray("Architecture:")}     ${meta.arch}`);
  console.log(`  ${pc.gray("Hostname:")}         ${meta.hostname}`);
  console.log(`  ${pc.gray("Config Path:")}      ${getLicenseFilePath()}`);
  console.log();

  if (stored) {
    console.log(pc.bold(pc.cyan("=== Local Activated License ===")));
    console.log(`  ${pc.gray("License Key:")}      ${pc.bold(stored.licenseKey)}`);
    console.log(`  ${pc.gray("Account ID:")}       ${stored.accountId}`);
    console.log(`  ${pc.gray("Server URL:")}       ${stored.serverUrl}`);
    console.log(`  ${pc.gray("Machine ID:")}       ${stored.machineId || "N/A"}`);
    console.log(`  ${pc.gray("Policy Name:")}      ${stored.policy?.name || "N/A"}`);
    console.log(`  ${pc.gray("Max Machines:")}     ${stored.policy?.maxMachines ?? "N/A"}`);
    console.log(`  ${pc.gray("Features:")}         ${stored.policy?.features?.length ? stored.policy.features.join(", ") : "(None)"}`);
    console.log(`  ${pc.gray("Token Expires:")}    ${stored.tokenExpiresAt || "N/A"}`);
    console.log(`  ${pc.gray("License Expires:")}  ${stored.licenseExpiresAt || "Perpetual (Never)"}`);
    console.log(`  ${pc.gray("Last Validated:")}   ${stored.lastValidatedAt || "N/A"}`);
  } else {
    console.log(pc.yellow("No local license currently activated. Use 'licenkit activate <key>' to bind."));
  }
  console.log();
}
