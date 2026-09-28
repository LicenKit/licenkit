import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import {
  decodeSignedLicenseHeader,
  evaluateSignedLicenseClaims,
  verifySignedLicenseToken,
} from "../lib/crypto";
import { describeClientError } from "../lib/errors";
import { describeEntitlementState } from "../lib/entitlement";
import { loadStoredLicense } from "../lib/storage";

export interface VerifyOptions {
  feature?: string;
  fingerprint?: string;
}

export async function verifyCommand(rawTokenArg: string | undefined, options: VerifyOptions): Promise<void> {
  try {
    const stored = loadStoredLicense();
    if (!stored) throw new Error("Offline verification requires a local signed activation context");
    if (stored.credentialMode === "opaque") {
      console.log(pc.yellow("Online validation required: opaque machine credentials are not offline-verifiable."));
      process.exitCode = 2;
      return;
    }
    const token = rawTokenArg || stored.signedLicenseToken;
    if (!token) throw new Error("Local signed activation is missing its Signed License Token");
    const header = decodeSignedLicenseHeader(token);
    const publicKey = stored.trustedSigningKeys?.[header.kid];
    if (!publicKey) throw new Error(`No trusted signing key is configured for '${header.kid}'`);
    const { claims } = await verifySignedLicenseToken(token, publicKey);
    const fingerprint = options.fingerprint || (await getMachineFingerprint());
    const evaluation = evaluateSignedLicenseClaims(claims, {
      productId: stored.productId,
      activationId: stored.activationId,
      fingerprint,
      releaseVersion: stored.releaseVersion,
      releasePlatform: stored.releasePlatform,
      releaseArch: stored.releaseArch,
    });
    if (!evaluation.valid) throw new Error(`${evaluation.code}: ${evaluation.reason}`);
    if (stored.lastEntitlementState.kind !== "license" || stored.lastEntitlementState.status !== "active") {
      console.log(pc.yellow("Online validation required: the last Server state is not an active License."));
      for (const line of describeEntitlementState(stored.lastEntitlementState)) console.log("  " + line);
      process.exitCode = 2;
      return;
    }
    const validatedAt = Date.parse(stored.lastValidatedAt);
    const now = Date.now();
    if (!Number.isFinite(validatedAt) || now < validatedAt) {
      throw new Error("LOCAL_CLOCK_INVALID: last Server validation is in the future");
    }
    if (options.feature && !claims.fea.includes(options.feature)) {
      throw new Error(`FEATURE_NOT_GRANTED: '${options.feature}' is not present in the signed claims`);
    }
    console.log(pc.bold(pc.green("✔ Signed License Token is valid locally")));
    console.log(`  ${pc.gray("License ID:")} ${claims.lic}`);
    console.log(`  ${pc.gray("Activation ID:")} ${claims.act}`);
    console.log(`  ${pc.gray("Release:")} ${claims.ver} (${claims.plt}/${claims.arc})`);
    console.log(`  ${pc.gray("Features:")} ${claims.fea.join(", ") || "(none)"}`);
    const elapsedSeconds = Math.floor((now - validatedAt) / 1000);
    if (stored.offlineGraceSeconds !== null && elapsedSeconds >= stored.offlineGraceSeconds) {
      console.log(pc.bold(pc.yellow("⚠ Offline grace exceeded; online validation is strongly recommended.")));
    } else if (elapsedSeconds >= stored.validationIntervalSeconds) {
      console.log(pc.yellow("Online validation is due; local authorization remains usable."));
    }
    console.log(
      "  " + pc.gray("Next online validation attempt due:") + " "
      + new Date(validatedAt + stored.validationIntervalSeconds * 1000).toISOString()
    );
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
