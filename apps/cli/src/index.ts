import { cac } from "cac";
import pc from "picocolors";
import { infoCommand } from "./commands/info";
import { activateCommand } from "./commands/activate";
import { validateCommand } from "./commands/validate";
import { verifyCommand } from "./commands/verify";
import { deactivateCommand } from "./commands/deactivate";

const cli = cac("licenkit");

// 1. Info Command
cli
  .command("info", "Print current device hardware fingerprint, OS information and local license status")
  .action(async () => {
    await infoCommand();
  });

// 2. Activate Command
cli
  .command("activate <key>", "Activate a license key and bind current device seat")
  .option("-s, --server <url>", "LicenKit API server URL (default: http://localhost:8787)")
  .option("-i, --instance <instanceId>", "LicenKit Instance ID")
  .option("-p, --product <productId>", "LicenKit Product ID")
  .option("-r, --release <version>", "Immutable Product Release version")
  .option("--release-platform <platform>", "Immutable Product Release artifact platform")
  .option("-n, --name <name>", "Friendly machine name (default: hostname)")
  .option("--signing-key <key...>", "Trusted signed-mode key as <key-id>=<base64-or-pem-public-key>")
  .action(async (key: string, options) => {
    await activateCommand(key, options);
  });

// 3. Validate Command
cli
  .command("validate", "Validate the current authorization online and print its exact Server state")
  .action(async () => {
    await validateCommand();
  });

// 4. Verify Command (Offline Mathematical Verification)
cli
  .command("verify-token [token]", "Verify a signed credential within its current periodic online-validation window")
  .alias("verify")
  .option("-f, --feature <feature>", "Check if a specific feature entitlement is granted")
  .option("--fingerprint <fp>", "Override current host fingerprint (for testing)")
  .action(async (token: string | undefined, options) => {
    await verifyCommand(token, options);
  });

// 5. Deactivate Command
cli
  .command("deactivate", "Deactivate the remote seat, then clear local credentials")
  .action(async () => {
    await deactivateCommand();
  });

// Global options
cli.help();
cli.version("1.0.0");

try {
  cli.parse();
} catch (err: any) {
  console.error(pc.red(`Error: ${err.message}`));
  process.exit(1);
}
