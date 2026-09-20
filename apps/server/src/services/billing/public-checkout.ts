import { evaluateBillingOfferReadiness, getBillingOfferReadinessRow } from "./readiness";

interface PublicProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  billing_environment: "sandbox" | "live" | null;
}

interface PublicOfferRow {
  id: string;
  external_price_id: string;
  purchase_type: "one_time" | "subscription";
  name: string;
}

export type PublicCheckoutConfiguration =
  | { found: false }
  | {
      found: true;
      product: { slug: string; name: string; description?: string };
      checkout:
        | { available: false; reasonCodes: string[] }
        | {
            available: true;
            provider: "paddle";
            environment: "sandbox" | "live";
            clientSideToken: string;
          };
      offers: Array<{
        id: string;
        name: string;
        purchaseType: "one_time" | "subscription";
        priceId: string;
        quantity: 1;
      }>;
    };

export async function loadPublicCheckoutConfiguration(
  db: D1Database,
  accountSlug: string,
  productSlug: string,
  now = new Date(),
): Promise<PublicCheckoutConfiguration> {
  const product = await db.prepare(
    `SELECT product.id, product.slug, product.name, product.description,
            product.status, product.billing_environment
     FROM products AS product
     JOIN accounts AS account ON account.id = product.account_id
     WHERE account.slug = ?1
       AND account.status = 'active'
       AND product.account_id = account.id
       AND product.slug = ?2
     LIMIT 1`,
  ).bind(accountSlug, productSlug).first<PublicProductRow>();
  if (!product) return { found: false };

  const publicProduct = {
    slug: product.slug,
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
  };
  if (product.status !== "active") {
    return {
      found: true,
      product: publicProduct,
      checkout: { available: false, reasonCodes: ["PRODUCT_UNAVAILABLE"] },
      offers: [],
    };
  }
  if (!product.billing_environment) {
    return {
      found: true,
      product: publicProduct,
      checkout: { available: false, reasonCodes: ["PRODUCT_BILLING_ENVIRONMENT_NOT_CONFIGURED"] },
      offers: [],
    };
  }

  const account = await db.prepare(`SELECT id FROM accounts WHERE slug = ?1 AND status = 'active' LIMIT 1`)
    .bind(accountSlug).first<{ id: string }>();
  if (!account) return { found: false };
  const offerResult = await db.prepare(
    `SELECT offer.id, offer.external_price_id, offer.purchase_type, plan.name
     FROM billing_offers AS offer
     JOIN billing_providers AS provider
       ON provider.account_id = offer.account_id AND provider.id = offer.billing_provider_id
     JOIN license_plans AS plan
       ON plan.account_id = offer.account_id AND plan.id = offer.license_plan_id
     WHERE offer.account_id = ?1
       AND offer.product_id = ?2
       AND offer.status = 'active'
       AND provider.environment = ?3
     ORDER BY offer.created_at ASC
     LIMIT 100`,
  ).bind(account.id, product.id, product.billing_environment).all<PublicOfferRow>();
  if (offerResult.results.length === 0) {
    return {
      found: true,
      product: publicProduct,
      checkout: { available: false, reasonCodes: ["NO_ACTIVE_OFFER"] },
      offers: [],
    };
  }

  const readyOffers: PublicOfferRow[] = [];
  const reasonCodes = new Set<string>();
  let providerEnvironment: "sandbox" | "live" | null = null;
  let clientSideToken: string | null = null;
  for (const offer of offerResult.results) {
    const row = await getBillingOfferReadinessRow(db, account.id, offer.id);
    if (!row) {
      reasonCodes.add("CHECKOUT_CONFIGURATION_PENDING");
      continue;
    }
    const readiness = await evaluateBillingOfferReadiness(db, row, { now });
    if (!readiness.ready) {
      readiness.publicReasonCodes.forEach((code) => reasonCodes.add(code));
      continue;
    }
    if (
      (providerEnvironment && providerEnvironment !== row.provider_environment) ||
      (clientSideToken && clientSideToken !== row.client_side_token)
    ) {
      reasonCodes.add("CHECKOUT_CONFIGURATION_PENDING");
      continue;
    }
    providerEnvironment = row.provider_environment;
    clientSideToken = row.client_side_token;
    readyOffers.push(offer);
  }

  if (readyOffers.length === 0 || !providerEnvironment || !clientSideToken) {
    return {
      found: true,
      product: publicProduct,
      checkout: {
        available: false,
        reasonCodes: reasonCodes.size > 0 ? [...reasonCodes] : ["CHECKOUT_CONFIGURATION_PENDING"],
      },
      offers: [],
    };
  }

  return {
    found: true,
    product: publicProduct,
    checkout: {
      available: true,
      provider: "paddle",
      environment: providerEnvironment,
      clientSideToken,
    },
    offers: readyOffers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      purchaseType: offer.purchase_type,
      priceId: offer.external_price_id,
      quantity: 1,
    })),
  };
}
