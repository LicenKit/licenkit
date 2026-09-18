import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import { apiDeactivate } from "../lib/client-api";
import { loadStoredLicense, clearStoredLicense } from "../lib/storage";

export async function deactivateCommand(): Promise<void> {
  const stored = loadStoredLicense();

  if (!stored) {
    console.log(pc.yellow("No local license found. Nothing to deactivate."));
    return;
  }

  if (!stored.machineId || !stored.machineToken) {
    console.log(pc.yellow("Local license is missing machine credentials. Clearing local state."));
    clearStoredLicense();
    return;
  }

  console.log(pc.cyan(`Deactivating license on server: ${stored.serverUrl}`));
  const fingerprint = await getMachineFingerprint();

  try {
    const res = await apiDeactivate({
      serverUrl: stored.serverUrl,
      accountId: stored.accountId,
      machineId: stored.machineId,
      machineToken: stored.machineToken,
      fingerprint,
    });

    clearStoredLicense();

    console.log();
    console.log(pc.bold(pc.green("✔ Machine successfully unregistered!")));
    console.log(`  ${pc.gray("Message:")} ${res.message}`);
    console.log(`  ${pc.gray("Local cache cleared.")}`);
    console.log();
  } catch (err: any) {
    console.error();
    console.error(pc.bold(pc.red(`✖ Deactivation failed [${err.code || "ERROR"}]:`)), err.message);
    console.error();
    process.exit(1);
  }
}
