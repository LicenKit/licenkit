import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import { apiDeactivate, ClientContractError } from "../lib/client-api";
import { describeClientError } from "../lib/errors";
import { loadStoredLicense, clearStoredLicense } from "../lib/storage";

export async function deactivateCommand(): Promise<void> {
  const stored = loadStoredLicense();
  if (!stored) {
    console.log(pc.yellow("No local activation. Nothing to deactivate."));
    return;
  }

  try {
    const fingerprint = await getMachineFingerprint();
    const response = await apiDeactivate({
      serverUrl: stored.serverUrl,
      accountId: stored.accountId,
      productId: stored.productId,
      activationId: stored.activationId,
      machineToken: stored.machineToken,
      fingerprint,
    });
    if (response.status !== "deactivated" || response.activation_id !== stored.activationId) {
      throw new ClientContractError("Server did not confirm deactivation of the requested activation");
    }
    clearStoredLicense();
    console.log(pc.bold(pc.green("✔ Remote activation deactivated and local credentials cleared")));
  } catch (error) {
    console.error(pc.yellow("Local credentials were preserved because remote deactivation did not complete."));
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
