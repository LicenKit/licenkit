import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, sql } from "drizzle-orm";
import type { AppContext } from "../types";
import { getTenantDB } from "../infra/db";
import { licenses, policies, machines, productTrials, products, cryptoKeys } from "../infra/db/schema";
import {
  decryptEnvelope,
  signOfflineToken,
  getStorageEncryptionKey,
  type OfflineTokenHeader,
  type OfflineLicenseClaims,
  type OfflineTrialClaims,
} from "../infra/crypto";
import { broadcastOutboundEvent } from "../infra/events/broadcast";
import { AppError, ConflictError, NotFoundError } from "../middleware/error";
import { rateLimit } from "../middleware/rate-limit";

export const clientRouter = new Hono<AppContext>();

/**
 * Helper: Retrieve and memory-decrypt the active Ed25519 private key for a product.
 */
async function getActiveProductKey(db: any, accountId: string, productId: string, masterSecret: string) {
  const activeKey = await db
    .select()
    .from(cryptoKeys)
    .where(
      and(
        eq(cryptoKeys.accountId, accountId),
        eq(cryptoKeys.productId, productId),
        eq(cryptoKeys.isActive, true)
      )
    )
    .get();

  if (!activeKey) {
    return null;
  }

  // Decrypt private key material in-memory
  const privateKeyPkcs8 = await decryptEnvelope(activeKey.keyMaterial, masterSecret);
  return {
    kid: activeKey.kid,
    publicKey: activeKey.publicKey,
    privateKeyPkcs8,
  };
}

/**
 * Helper: Calculate offline expiration timestamp given policy grace period and absolute license expiration.
 */
function calculateOfflineExpiration(licenseExpiresAt: string | null, offlineGracePeriod: number): {
  offlineExpTimestamp: number;
  offlineExpIso: string;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceExpSeconds = nowSeconds + offlineGracePeriod;

  let finalExpSeconds = graceExpSeconds;
  if (licenseExpiresAt) {
    const licExpSeconds = Math.floor(new Date(licenseExpiresAt).getTime() / 1000);
    finalExpSeconds = Math.min(licExpSeconds, graceExpSeconds);
  }

  return {
    offlineExpTimestamp: finalExpSeconds,
    offlineExpIso: new Date(finalExpSeconds * 1000).toISOString(),
  };
}

// GET /api/v1/client/products/:id/pubkey
clientRouter.get("/products/:id/pubkey", async (c) => {
  const productId = c.req.param("id");
  const accountId = c.req.query("accountId") || c.req.query("account_id");

  if (!accountId) {
    throw new AppError("MISSING_ACCOUNT_ID", "Query parameter 'accountId' is required", 400);
  }

  const db = getTenantDB(c, accountId);

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)))
    .get();

  if (!product || !product.isActive) {
    return c.json({
      success: false,
      error: { code: "PRODUCT_NOT_FOUND", message: "Product not found or inactive" },
    }, 200);
  }

  const activeKey = await db
    .select({
      kid: cryptoKeys.kid,
      algorithm: cryptoKeys.algorithm,
      publicKey: cryptoKeys.publicKey,
    })
    .from(cryptoKeys)
    .where(
      and(
        eq(cryptoKeys.accountId, accountId),
        eq(cryptoKeys.productId, productId),
        eq(cryptoKeys.isActive, true)
      )
    )
    .get();

  if (!activeKey) {
    return c.json({
      success: false,
      error: { code: "KEY_NOT_FOUND", message: "No active cryptographic public key found for this product" },
    }, 200);
  }

  return c.json({
    success: true,
    data: {
      productId,
      kid: activeKey.kid,
      algorithm: activeKey.algorithm,
      publicKey: activeKey.publicKey,
    },
  });
});

const ActivateSchema = z.object({
  account_id: z.string(),
  license_key: z.string(),
  fingerprint: z.string().min(8),
  platform: z.string().optional(),
  name: z.string().optional(),
});

// POST /api/v1/client/activate
clientRouter.post(
  "/activate",
  rateLimit({ limit: 30, windowSeconds: 60, keyPrefix: "client_activate" }),
  async (c) => {
  const body = await c.req.json();
  const input = ActivateSchema.parse(body);

  const db = getTenantDB(c, input.account_id);
  const encKey = getStorageEncryptionKey(c.env);

  // 1. Fetch license and linked policy
  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.accountId, input.account_id), eq(licenses.key, input.license_key)))
    .get();

  if (!license) {
    return c.json({
      success: false,
      error: { code: "LICENSE_NOT_FOUND", message: "License key not found" },
    }, 200);
  }

  if (license.status !== "active") {
    return c.json({
      success: false,
      error: { code: "LICENSE_NOT_ACTIVE", message: `License is currently ${license.status}` },
    }, 200);
  }

  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    return c.json({
      success: false,
      error: { code: "LICENSE_EXPIRED", message: "License has expired" },
    }, 200);
  }

  const policy = await db
    .select()
    .from(policies)
    .where(and(eq(policies.accountId, input.account_id), eq(policies.id, license.policyId)))
    .get();

  if (!policy || !policy.isActive) {
    return c.json({
      success: false,
      error: { code: "POLICY_DISABLED", message: "License policy is inactive or disabled" },
    }, 200);
  }

  // 2. Check if this machine is already activated
  const existingMachine = await db
    .select()
    .from(machines)
    .where(and(eq(machines.licenseId, license.id), eq(machines.fingerprint, input.fingerprint)))
    .get();

  const now = new Date().toISOString();
  let machineId: string;
  let isReused = false;

  if (existingMachine) {
    // Update heartbeat and metadata
    await db
      .update(machines)
      .set({
        lastHeartbeatAt: now,
        name: input.name || existingMachine.name,
        platform: input.platform || existingMachine.platform,
      })
      .where(eq(machines.id, existingMachine.id));

    machineId = existingMachine.id;
    isReused = true;
  } else {
    // 3. Check seat limit with concurrency protection
    const machineCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(machines)
      .where(eq(machines.licenseId, license.id))
      .get();

    const currentCount = machineCountResult?.count || 0;
    if (currentCount >= policy.maxMachines) {
      return c.json({
        success: false,
        error: {
          code: "SEAT_LIMIT_EXCEEDED",
          message: `Seat limit reached (${currentCount}/${policy.maxMachines}). Please deactivate an old machine first.`,
        },
      }, 200);
    }

    // 4. Create new machine binding
    machineId = `mac_${ulid().toLowerCase()}`;
    const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

    // Double-check seat limit immediately prior to insert to prevent concurrent over-allocation
    const doubleCheck = await db
      .select({ count: sql<number>`count(*)` })
      .from(machines)
      .where(eq(machines.licenseId, license.id))
      .get();

    if ((doubleCheck?.count || 0) >= policy.maxMachines) {
      return c.json({
        success: false,
        error: {
          code: "SEAT_LIMIT_EXCEEDED",
          message: `Seat limit reached (${doubleCheck?.count || 0}/${policy.maxMachines}). Please deactivate an old machine first.`,
        },
      }, 200);
    }

    await db.insert(machines).values({
      id: machineId,
      licenseId: license.id,
      fingerprint: input.fingerprint,
      name: input.name || null,
      platform: input.platform || null,
      ip: clientIp,
      lastHeartbeatAt: now,
      createdAt: now,
    });
  }

  // 5. Generate Offline Ed25519 Token if scheme == 'ed25519'
  const features = typeof policy.features === "string" ? JSON.parse(policy.features || "[]") : policy.features || [];
  let token: string | null = null;
  let tokenExpiresTimestamp: number | null = null;
  let tokenExpiresIso: string | null = null;

  if (policy.scheme === "ed25519") {
    const keyInfo = await getActiveProductKey(db, input.account_id, license.productId, encKey);
    if (!keyInfo) {
      throw new AppError("CRYPTO_KEY_MISSING", "Product cryptographic signing key is not configured", 500);
    }

    const offlineGracePeriod = policy.offlineGracePeriod ?? 2592000;
    const expInfo = calculateOfflineExpiration(license.expiresAt, offlineGracePeriod);
    tokenExpiresTimestamp = expInfo.offlineExpTimestamp;
    tokenExpiresIso = expInfo.offlineExpIso;

    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TOKEN",
      kid: keyInfo.kid,
    };

    const claims: OfflineLicenseClaims = {
      typ: "license",
      lic_id: license.id,
      sub: license.key,
      acc: input.account_id,
      prd: license.productId,
      pol: policy.id,
      fp: input.fingerprint,
      iat: Math.floor(Date.now() / 1000),
      exp: expInfo.offlineExpTimestamp,
      fea: features,
    };

    token = await signOfflineToken(header, claims, keyInfo.privateKeyPkcs8);
  }

  await broadcastOutboundEvent(
    c.env,
    db,
    input.account_id,
    "client.activated",
    {
      licenseId: license.id,
      key: license.key,
      machineId,
      fingerprint: input.fingerprint,
      platform: input.platform || null,
      reused: isReused,
    },
    license.productId
  );

  const licenseExpTimestamp = license.expiresAt ? Math.floor(new Date(license.expiresAt).getTime() / 1000) : null;

  return c.json({
    success: true,
    data: {
      activated: true,
      reused: isReused,
      machine_id: machineId,
      scheme: policy.scheme,
      token,
      token_expires_at: tokenExpiresTimestamp,
      license_expires_at: licenseExpTimestamp,
      token_expires_at_iso: tokenExpiresIso,
      license_expires_at_iso: license.expiresAt,
      policy: {
        name: policy.name,
        max_machines: policy.maxMachines,
        offline_grace_period: policy.offlineGracePeriod,
        features,
      },
    },
  });
});

const ValidateSchema = z.object({
  account_id: z.string(),
  license_key: z.string(),
  fingerprint: z.string().min(8),
});

// POST /api/v1/client/validate
clientRouter.post("/validate", async (c) => {
  const body = await c.req.json();
  const input = ValidateSchema.parse(body);

  const db = getTenantDB(c, input.account_id);
  const encKey = getStorageEncryptionKey(c.env);

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.accountId, input.account_id), eq(licenses.key, input.license_key)))
    .get();

  if (!license || license.status !== "active") {
    return c.json({
      success: true,
      data: { valid: false, reason: "LICENSE_INVALID_OR_REVOKED" },
    });
  }

  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) {
    return c.json({
      success: true,
      data: { valid: false, reason: "LICENSE_EXPIRED" },
    });
  }

  const machine = await db
    .select()
    .from(machines)
    .where(and(eq(machines.licenseId, license.id), eq(machines.fingerprint, input.fingerprint)))
    .get();

  if (!machine) {
    return c.json({
      success: true,
      data: { valid: false, reason: "MACHINE_NOT_ACTIVATED" },
    });
  }

  const policy = await db
    .select()
    .from(policies)
    .where(and(eq(policies.accountId, input.account_id), eq(policies.id, license.policyId)))
    .get();

  if (!policy || !policy.isActive) {
    return c.json({
      success: true,
      data: { valid: false, reason: "POLICY_INACTIVE_OR_DISABLED" },
    });
  }

  // Update heartbeat
  const now = new Date().toISOString();
  await db.update(machines).set({ lastHeartbeatAt: now }).where(eq(machines.id, machine.id));

  // If Ed25519 scheme, refresh offline signed token with extended grace period
  let token: string | null = null;
  let tokenExpiresTimestamp: number | null = null;
  let tokenExpiresIso: string | null = null;

  if (policy.scheme === "ed25519") {
    const keyInfo = await getActiveProductKey(db, input.account_id, license.productId, encKey);
    if (keyInfo) {
      const features = typeof policy.features === "string" ? JSON.parse(policy.features || "[]") : policy.features || [];
      const offlineGracePeriod = policy.offlineGracePeriod ?? 2592000;
      const expInfo = calculateOfflineExpiration(license.expiresAt, offlineGracePeriod);
      tokenExpiresTimestamp = expInfo.offlineExpTimestamp;
      tokenExpiresIso = expInfo.offlineExpIso;

      const header: OfflineTokenHeader = {
        alg: "Ed25519",
        typ: "LK-TOKEN",
        kid: keyInfo.kid,
      };

      const claims: OfflineLicenseClaims = {
        typ: "license",
        lic_id: license.id,
        sub: license.key,
        acc: input.account_id,
        prd: license.productId,
        pol: policy.id,
        fp: input.fingerprint,
        iat: Math.floor(Date.now() / 1000),
        exp: expInfo.offlineExpTimestamp,
        fea: features,
      };

      token = await signOfflineToken(header, claims, keyInfo.privateKeyPkcs8);
    }
  }

  const licenseExpTimestamp = license.expiresAt ? Math.floor(new Date(license.expiresAt).getTime() / 1000) : null;
  const heartbeatTimestamp = Math.floor(new Date(now).getTime() / 1000);

  return c.json({
    success: true,
    data: {
      valid: true,
      scheme: policy.scheme,
      token,
      token_expires_at: tokenExpiresTimestamp,
      license_expires_at: licenseExpTimestamp,
      token_expires_at_iso: tokenExpiresIso,
      license_expires_at_iso: license.expiresAt,
      last_heartbeat_at: heartbeatTimestamp,
      last_heartbeat_at_iso: now,
    },
  });
});

const DeactivateSchema = z.object({
  account_id: z.string(),
  license_key: z.string(),
  fingerprint: z.string().min(8),
});

// POST /api/v1/client/deactivate
clientRouter.post("/deactivate", async (c) => {
  const body = await c.req.json();
  const input = DeactivateSchema.parse(body);

  const db = getTenantDB(c, input.account_id);

  const license = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.accountId, input.account_id), eq(licenses.key, input.license_key)))
    .get();

  if (!license) {
    return c.json({
      success: false,
      error: { code: "LICENSE_NOT_FOUND", message: "License key not found" },
    }, 200);
  }

  await db
    .delete(machines)
    .where(and(eq(machines.licenseId, license.id), eq(machines.fingerprint, input.fingerprint)));

  await broadcastOutboundEvent(
    c.env,
    db,
    input.account_id,
    "client.deactivated",
    {
      licenseId: license.id,
      key: license.key,
      fingerprint: input.fingerprint,
    },
    license.productId
  );

  return c.json({
    success: true,
    data: {
      deactivated: true,
      message: "Machine successfully unregistered from license",
    },
  });
});

const TrialSchema = z.object({
  account_id: z.string(),
  product_id: z.string(),
  fingerprint: z.string().min(8),
});

// POST /api/v1/client/trial
clientRouter.post("/trial", async (c) => {
  const body = await c.req.json();
  const input = TrialSchema.parse(body);

  const db = getTenantDB(c, input.account_id);
  const encKey = getStorageEncryptionKey(c.env);

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.accountId, input.account_id), eq(products.id, input.product_id)))
    .get();

  if (!product || !product.isActive) {
    return c.json({
      success: false,
      error: { code: "PRODUCT_NOT_FOUND", message: "Product not found or inactive" },
    }, 200);
  }

  if (product.trialDays <= 0) {
    return c.json({
      success: false,
      error: { code: "TRIAL_NOT_AVAILABLE", message: "Trial is not enabled for this product" },
    }, 200);
  }

  const trialFeatures: string[] = JSON.parse(product.trialFeatures || "[]");
  const keyInfo = await getActiveProductKey(db, input.account_id, product.id, encKey);

  const existingTrial = await db
    .select()
    .from(productTrials)
    .where(
      and(
        eq(productTrials.accountId, input.account_id),
        eq(productTrials.productId, input.product_id),
        eq(productTrials.fingerprint, input.fingerprint)
      )
    )
    .get();

  if (existingTrial) {
    const isExpired = new Date(existingTrial.expiresAt).getTime() < Date.now();
    let token: string | null = null;

    if (!isExpired && keyInfo) {
      const header: OfflineTokenHeader = {
        alg: "Ed25519",
        typ: "LK-TRIAL",
        kid: keyInfo.kid,
      };

      const claims: OfflineTrialClaims = {
        typ: "trial",
        acc: input.account_id,
        prd: input.product_id,
        fp: input.fingerprint,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(new Date(existingTrial.expiresAt).getTime() / 1000),
        fea: trialFeatures,
      };

      token = await signOfflineToken(header, claims, keyInfo.privateKeyPkcs8);
    }

    return c.json({
      success: true,
      data: {
        trial_claimed: true,
        already_claimed: true,
        expired: isExpired,
        claimed_at: existingTrial.claimedAt,
        expires_at: existingTrial.expiresAt,
        token,
        features: trialFeatures,
      },
    });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + product.trialDays * 86400 * 1000);

  await db.insert(productTrials).values({
    accountId: input.account_id,
    productId: input.product_id,
    fingerprint: input.fingerprint,
    claimedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  let token: string | null = null;
  if (keyInfo) {
    const header: OfflineTokenHeader = {
      alg: "Ed25519",
      typ: "LK-TRIAL",
      kid: keyInfo.kid,
    };

    const claims: OfflineTrialClaims = {
      typ: "trial",
      acc: input.account_id,
      prd: input.product_id,
      fp: input.fingerprint,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
      fea: trialFeatures,
    };

    token = await signOfflineToken(header, claims, keyInfo.privateKeyPkcs8);
  }

  return c.json({
    success: true,
    data: {
      trial_claimed: true,
      already_claimed: false,
      expired: false,
      claimed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      token,
      features: trialFeatures,
    },
  });
});

