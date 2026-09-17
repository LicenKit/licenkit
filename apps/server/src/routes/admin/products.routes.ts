import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { eq, and, sql } from "drizzle-orm";
import type { AppContext } from "../../types";
import { getTenantDB } from "../../infra/db";
import { products, cryptoKeys, policies, licenses } from "../../infra/db/schema";
import { generateEd25519KeyPair, validateAndImportEd25519KeyPair, encryptEnvelope } from "../../infra/crypto";
import { requireRole } from "../../middleware/auth";
import { NotFoundError, ConflictError, AppError } from "../../middleware/error";

export const adminProductsRouter = new Hono<AppContext>();

// GET /api/v1/admin/products
adminProductsRouter.get("/", async (c) => {
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const list = await db
    .select({
      id: products.id,
      accountId: products.accountId,
      name: products.name,
      description: products.description,
      trialDays: products.trialDays,
      trialFeatures: products.trialFeatures,
      isActive: products.isActive,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      publicKey: cryptoKeys.publicKey,
      kid: cryptoKeys.kid,
    })
    .from(products)
    .leftJoin(
      cryptoKeys,
      and(eq(cryptoKeys.productId, products.id), eq(cryptoKeys.isActive, true))
    )
    .where(eq(products.accountId, accountId))
    .all();

  return c.json({
    success: true,
    data: {
      items: list.map((p) => {
        const features = JSON.parse(p.trialFeatures || "[]");
        return {
          id: p.id,
          accountId: p.accountId,
          name: p.name,
          description: p.description,
          trialDays: p.trialDays,
          trialFeatures: features,
          isActive: p.isActive,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          publicKey: p.publicKey || null,
          kid: p.kid || null,
        };
      }),
    },
  });
});

const CreateProductSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  trialDays: z.number().int().min(0).default(14),
  trialFeatures: z.array(z.string()).default([]),
  keyMode: z.enum(["auto", "upload"]).default("auto"),
  privateKey: z.string().optional(),
  publicKey: z.string().optional(),
});

// POST /api/v1/admin/products
adminProductsRouter.post("/", requireRole(["owner", "admin"]), async (c) => {
  const body = await c.req.json();
  const input = CreateProductSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;
  const productId = `prd_${ulid().toLowerCase()}`;
  const now = new Date().toISOString();

  let keyPair: { publicKeyBase64: string; privateKeyPkcs8Base64: string };
  let source: "platform" | "uploaded" = "platform";

  if (input.keyMode === "upload") {
    if (!input.privateKey || !input.privateKey.trim()) {
      throw new AppError("MISSING_PRIVATE_KEY", "Private key is required when keyMode is 'upload'", 400);
    }
    if (!input.publicKey || !input.publicKey.trim()) {
      throw new AppError(
        "MISSING_PUBLIC_KEY",
        "Public key is required when uploading an existing keypair to ensure key verification",
        400
      );
    }
    try {
      keyPair = await validateAndImportEd25519KeyPair(input.privateKey.trim(), input.publicKey.trim());
      source = "uploaded";
    } catch (err: any) {
      throw new AppError("INVALID_KEYPAIR", err?.message || "Invalid Ed25519 keypair provided", 400);
    }
  } else {
    // Generate initial Ed25519 keypair for product
    keyPair = await generateEd25519KeyPair();
  }

  const kid = `kid_${ulid().toLowerCase()}`;
  const encKey = c.env.STORAGE_ENCRYPTION_KEY || "licenkit-default-storage-key-32b";
  const encryptedKeyMaterial = await encryptEnvelope(keyPair.privateKeyPkcs8Base64, encKey);

  await db.batch([
    db.insert(products).values({
      id: productId,
      accountId,
      name: input.name,
      description: input.description || null,
      trialDays: input.trialDays,
      trialFeatures: JSON.stringify(input.trialFeatures),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(cryptoKeys).values({
      kid,
      accountId,
      productId,
      algorithm: "Ed25519",
      source,
      publicKey: keyPair.publicKeyBase64,
      keyMaterial: encryptedKeyMaterial,
      isActive: true,
      createdAt: now,
    }),
  ]);

  return c.json(
    {
      success: true,
      data: {
        id: productId,
        name: input.name,
        description: input.description,
        trialDays: input.trialDays,
        trialFeatures: input.trialFeatures,
        isActive: true,
        publicKey: keyPair.publicKeyBase64,
        privateKey: keyPair.privateKeyPkcs8Base64, // Returned ONCE on creation for download!
        keySource: source,
        kid,
      },
    },
    201
  );
});

// GET /api/v1/admin/products/:id
adminProductsRouter.get("/:id", async (c) => {
  const productId = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  const activeKey = await db
    .select({ kid: cryptoKeys.kid, publicKey: cryptoKeys.publicKey })
    .from(cryptoKeys)
    .where(and(eq(cryptoKeys.productId, productId), eq(cryptoKeys.isActive, true)))
    .get();

  const features = JSON.parse(product.trialFeatures || "[]");
  return c.json({
    success: true,
    data: {
      id: product.id,
      accountId: product.accountId,
      name: product.name,
      description: product.description,
      trialDays: product.trialDays,
      trialFeatures: features,
      isActive: product.isActive,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      publicKey: activeKey?.publicKey || null,
      kid: activeKey?.kid || null,
    },
  });
});

const UpdateProductSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  trialDays: z.number().int().min(0).optional(),
  trialFeatures: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

// PATCH /api/v1/admin/products/:id
adminProductsRouter.patch("/:id", requireRole(["owner", "admin"]), async (c) => {
  const productId = c.req.param("id");
  const body = await c.req.json();
  const input = UpdateProductSchema.parse(body);

  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  const now = new Date().toISOString();
  const updateData: Record<string, any> = { updatedAt: now };

  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.trialDays !== undefined) updateData.trialDays = input.trialDays;
  if (input.trialFeatures !== undefined) updateData.trialFeatures = JSON.stringify(input.trialFeatures);
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  await db
    .update(products)
    .set(updateData)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)));

  const updatedProduct = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)))
    .get();

  const features = JSON.parse(updatedProduct!.trialFeatures || "[]");
  return c.json({
    success: true,
    data: {
      id: updatedProduct!.id,
      accountId: updatedProduct!.accountId,
      name: updatedProduct!.name,
      description: updatedProduct!.description,
      trialDays: updatedProduct!.trialDays,
      trialFeatures: features,
      isActive: updatedProduct!.isActive,
      createdAt: updatedProduct!.createdAt,
      updatedAt: updatedProduct!.updatedAt,
    },
  });
});

// DELETE /api/v1/admin/products/:id
adminProductsRouter.delete("/:id", requireRole(["owner", "admin"]), async (c) => {
  const productId = c.req.param("id");
  const db = getTenantDB(c);
  const accountId = c.get("accountId")!;

  const product = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.accountId, accountId)))
    .get();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  // Check if policies or licenses exist
  const existingPolicy = await db
    .select({ count: sql<number>`count(*)` })
    .from(policies)
    .where(and(eq(policies.productId, productId), eq(policies.accountId, accountId)))
    .get();

  if (existingPolicy && existingPolicy.count > 0) {
    throw new ConflictError(
      "PRODUCT_IN_USE",
      `Cannot delete product: ${existingPolicy.count} licensing policies are associated with this product. Please deactivate it or delete the policies first.`
    );
  }

  const existingLicense = await db
    .select({ count: sql<number>`count(*)` })
    .from(licenses)
    .where(and(eq(licenses.productId, productId), eq(licenses.accountId, accountId)))
    .get();

  if (existingLicense && existingLicense.count > 0) {
    throw new ConflictError(
      "PRODUCT_IN_USE",
      `Cannot delete product: ${existingLicense.count} licenses have been issued for this product. Please deactivate it instead.`
    );
  }

  await db.batch([
    db.delete(products).where(and(eq(products.id, productId), eq(products.accountId, accountId))),
    db.delete(cryptoKeys).where(and(eq(cryptoKeys.productId, productId), eq(cryptoKeys.accountId, accountId))),
  ]);

  return c.json({
    success: true,
    data: { message: "Product deleted successfully" },
  });
});
