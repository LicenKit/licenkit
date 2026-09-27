import pc from "picocolors";
import { describeEntitlementState } from "../lib/entitlement";
import { getDeviceMetadata } from "../lib/machine";
import { loadStoredLicense, getLicenseFilePath } from "../lib/storage";

export async function infoCommand(): Promise<void> {
  const meta = await getDeviceMetadata();
  const stored = loadStoredLicense();
  console.log(pc.bold(pc.cyan("LicenKit device")));
  console.log("  " + pc.gray("Fingerprint:") + " " + meta.fingerprint);
  console.log("  " + pc.gray("Platform:") + " " + meta.platform + "-" + meta.arch);
  console.log("  " + pc.gray("Config path:") + " " + getLicenseFilePath());
  if (!stored) {
    console.log(pc.yellow("No local activation."));
    return;
  }
  console.log(pc.bold(pc.cyan("Local authorization")));
  console.log("  " + pc.gray("Activation ID:") + " " + stored.activationId);
  console.log("  " + pc.gray("Product:") + " " + stored.productId);
  console.log("  " + pc.gray("Credential mode:") + " " + stored.credentialMode);
  console.log("  " + pc.gray("Release:") + " " + stored.releaseVersion + " (" + stored.releasePlatform + "/" + stored.releaseArch + ")");
  for (const line of describeEntitlementState(stored.lastEntitlementState)) console.log("  " + line);
  console.log("  " + pc.gray("Last Server validation:") + " " + stored.lastValidatedAt);
  console.log(
    "  " + pc.gray("Validation interval:") + " " + stored.effectiveValidationIntervalSeconds
    + "s (server: " + (stored.receivedValidationIntervalSeconds ?? "default") + ")"
  );
  if (stored.lastValidationRequestId) {
    console.log("  " + pc.gray("Request ID:") + " " + stored.lastValidationRequestId);
  }
}
