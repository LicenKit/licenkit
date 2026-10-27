import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "../src/infra/crypto";
import { createSignedLicenseToken } from "../src/domain/license/signed-token";
import { evaluateSignedLicenseClaims, verifySignedLicenseToken } from "../../cli/src/lib/crypto";

describe("Server and CLI Signed License Token contract", () => {
  it.each(["live", "sandbox"] as const)("verifies a Server-issued %s Token in the CLI", async (environment) => {
    const keys = await generateEd25519KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      lic: "lic_contract", act: "act_contract", ins: "instance_contract", prd: "prd_contract",
      env: environment, ver: "1.0.0", plt: "macos", arc: "arm64", fp: "contract-device",
      iat: now, lexp: null, upd: null, fea: ["pro"],
    };
    const token = await createSignedLicenseToken({
      keyId: "key_contract", privateKeyPkcs8: keys.privateKeyPkcs8Base64, claims,
    });
    const verified = await verifySignedLicenseToken(token, keys.publicKeyBase64);
    expect(verified.claims).toEqual(claims);
    const context = {
      productId: claims.prd, activationId: claims.act, fingerprint: claims.fp,
      billingEnvironment: environment, releaseVersion: claims.ver,
      releasePlatform: claims.plt, releaseArch: claims.arc, nowSeconds: now,
    };
    expect(evaluateSignedLicenseClaims(verified.claims, context)).toEqual({ valid: true });
    expect(evaluateSignedLicenseClaims(verified.claims, {
      ...context, billingEnvironment: environment === "live" ? "sandbox" : "live",
    })).toMatchObject({ valid: false, code: "TOKEN_ENVIRONMENT_MISMATCH" });
  });
});
