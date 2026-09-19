import pc from "picocolors";
import { getDeviceMetadata } from "../lib/machine";
import { loadStoredLicense, getLicenseFilePath } from "../lib/storage";

export async function infoCommand(): Promise<void> {
  const meta = await getDeviceMetadata();
  const stored = loadStoredLicense();
  console.log(pc.bold(pc.cyan("LicenKit device")));
  console.log(`  ${pc.gray("Fingerprint:")} ${meta.fingerprint}`);
  console.log(`  ${pc.gray("Platform:")} ${meta.platform}-${meta.arch}`);
  console.log(`  ${pc.gray("Config path:")} ${getLicenseFilePath()}`);
  if (!stored) {
    console.log(pc.yellow("No local activation."));
    return;
  }
  console.log(pc.bold(pc.cyan("Local activation")));
  console.log(`  ${pc.gray("Activation ID:")} ${stored.activationId}`);
  console.log(`  ${pc.gray("Account / Product:")} ${stored.accountId} / ${stored.productId}`);
  console.log(`  ${pc.gray("Credential mode:")} ${stored.credentialMode}`);
  console.log(`  ${pc.gray("Release:")} ${stored.releaseVersion} (${stored.releasePlatform})`);
  console.log(`  ${pc.gray("Features:")} ${stored.terms.features.join(", ") || "(none)"}`);
  console.log(`  ${pc.gray("Last online validation:")} ${stored.lastValidatedAt}`);
}
