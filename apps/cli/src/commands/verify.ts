import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import { verifyOfflineToken, evaluateLicenseClaims } from "../lib/crypto";
import { loadStoredLicense } from "../lib/storage";

export interface VerifyOptions {
  pubkey?: string;
  feature?: string;
  fingerprint?: string;
}

export async function verifyCommand(rawTokenArg: string | undefined, options: VerifyOptions): Promise<void> {
  const stored = loadStoredLicense();

  const token = rawTokenArg || stored?.token;
  if (!token) {
    console.error(pc.red("Error: No offline token provided and no local license found. Pass a token or activate first."));
    process.exit(1);
  }

  const publicKey = options.pubkey || stored?.publicKey;
  if (!publicKey) {
    console.error(pc.red("Error: Public key is required for offline verification. Pass --pubkey <base64Key>."));
    process.exit(1);
  }

  const currentFingerprint = options.fingerprint || (await getMachineFingerprint());

  console.log();
  console.log(pc.bold(pc.cyan("=== Offline Cryptographic Token Verification ===")));
  console.log(pc.gray("Running pure local mathematical verification (Zero Network)..."));

  // 1. Ed25519 Cryptographic Verification
  const verification = await verifyOfflineToken(token, publicKey);

  if (!verification.valid || !verification.claims) {
    console.error();
    console.error(pc.bold(pc.red("✖ Verification Failed: ")), verification.error || "Invalid cryptographic signature");
    console.error();
    process.exit(1);
  }

  const claims = verification.claims;
  const evaluation = evaluateLicenseClaims(claims, currentFingerprint, options.feature);

  console.log();
  if (evaluation.valid) {
    console.log(pc.bold(pc.green("✔ OFFLINE VERIFICATION PASSED (Genuine & Active)")));
  } else {
    console.log(pc.bold(pc.red("✖ OFFLINE VERIFICATION FAILED")));
    for (const reason of evaluation.reasons) {
      console.log(`  ${pc.red("•")} ${pc.red(reason)}`);
    }
  }

  console.log();
  console.log(pc.bold(pc.cyan("Token Claims & Metadata:")));
  console.log(`  ${pc.gray("Type:")}              ${verification.header?.typ}`);
  console.log(`  ${pc.gray("Key ID (kid):")}      ${verification.header?.kid}`);
  console.log(`  ${pc.gray("Subject / Key:")}     ${pc.bold("sub" in claims ? claims.sub : "N/A")}`);
  console.log(`  ${pc.gray("Account ID:")}        ${claims.acc}`);
  console.log(`  ${pc.gray("Product ID:")}        ${claims.prd}`);
  console.log(`  ${pc.gray("Bound Fingerprint:")} ${claims.fp} ${evaluation.isFingerprintMatch ? pc.green("(Matches host)") : pc.red("(Mismatch!)")}`);
  console.log(`  ${pc.gray("Host Fingerprint:")}  ${currentFingerprint}`);
  console.log(`  ${pc.gray("Issued At:")}         ${new Date(claims.iat * 1000).toISOString()}`);
  console.log(`  ${pc.gray("Expires At:")}        ${new Date(claims.exp * 1000).toISOString()} ${evaluation.isExpired ? pc.red("(Expired)") : pc.green(`(${Math.floor(evaluation.expiresInSeconds / 86400)}d remaining)`)}`);
  console.log(`  ${pc.gray("Entitlements:")}      ${claims.fea.length ? pc.green(claims.fea.join(", ")) : "(None)"}`);

  if (options.feature) {
    const granted = claims.fea.includes(options.feature);
    console.log(`  ${pc.gray("Checked Feature:")}   ${options.feature} ${granted ? pc.green("(Granted)") : pc.red("(Denied)")}`);
  }

  console.log();

  if (!evaluation.valid) {
    process.exit(1);
  }
}
