import pc from "picocolors";
import { getMachineFingerprint } from "../lib/machine";
import {
  decodeSignedLicenseHeader,
  evaluateSignedLicenseClaims,
  verifySignedLicenseToken,
} from "../lib/crypto";
import { describeClientError } from "../lib/errors";
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
      instanceId: stored.instanceId,
      productId: stored.productId,
      activationId: stored.activationId,
      fingerprint,
      releaseVersion: stored.releaseVersion,
      releasePlatform: stored.releasePlatform,
    });
    if (!evaluation.valid) throw new Error(`${evaluation.code}: ${evaluation.reason}`);
    if (options.feature && !claims.fea.includes(options.feature)) {
      throw new Error(`FEATURE_NOT_GRANTED: '${options.feature}' is not present in the signed claims`);
    }
    console.log(pc.bold(pc.green("✔ Signed License Token is valid locally")));
    console.log(`  ${pc.gray("License ID:")} ${claims.lic}`);
    console.log(`  ${pc.gray("Activation ID:")} ${claims.act}`);
    console.log(`  ${pc.gray("Release:")} ${claims.ver} (${claims.plt})`);
    console.log(`  ${pc.gray("Features:")} ${claims.fea.join(", ") || "(none)"}`);
  } catch (error) {
    for (const line of describeClientError(error)) console.error(pc.red(line));
    process.exitCode = 1;
  }
}
