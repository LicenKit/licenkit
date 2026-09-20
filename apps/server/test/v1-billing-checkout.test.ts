import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { computeHmacSha256, sha256Hex } from "../src/infra/crypto";
import { encryptBillingProviderSecret, encryptInboundPayload } from "../src/infra/billing/storage";
import { processBillingInboundEvent, processDueBillingInboundEvents } from "../src/services/billing/fulfillment";
import {
  getSystemIssueDetail,
  listSystemIssues,
  recordProviderSystemIssue,
  resolveSystemIssue,
  retryResolvedSystemIssueEvents,
} from "../src/services/billing/system-issues";
import { reconcileBillingCustomer } from "../src/services/billing/customer-sync";
import { createCustomerPortalSession } from "../src/services/billing/customer-portal";
import { evaluateBillingOfferReadiness, getBillingOfferReadinessRow } from "../src/services/billing/readiness";
import { clearExpiredInboundEventPayloads } from "../src/services/runtime/retention";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const accountId = "acc_billing_v1";
const providerId = "bpr_sandbox_v1";
const webhookSecret = "pdl_ntfsec_v1_test_secret_123456789";
const nowIso = "2026-09-19T08:00:00.000Z";

function addFirstToMockD1(d1: any): void {
  const originalPrepare = d1.prepare.bind(d1);
  const decorate = (statement: any): any => {
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...params: unknown[]) => decorate(originalBind(...params));
    statement.first = async () => statement.get();
    return statement;
  };
  d1.prepare = (query: string) => decorate(originalPrepare(query));
}

function eventPayload(eventId: string, eventType: string, data: Record<string, unknown>, occurredAt = nowIso): string {
  return JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: occurredAt, data });
}

describe("V1 Paddle billing and fulfillment contracts", () => {
  let testEnv: TestEnvContext;

  beforeEach(async () => {
    testEnv = createTestEnv({ ENVIRONMENT: "test", STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    addFirstToMockD1(testEnv.d1);
    testEnv.env.DB = testEnv.d1;
    const db = testEnv.sqliteDb;
    db.prepare(
      `INSERT INTO system_settings (id, instance_name, app_url, site_url, initialized_at, updated_at)
       VALUES ('current', 'LicenKit', 'https://licenses.example.test', 'https://licenses.example.test', ?, ?)`,
    ).run(nowIso, nowIso);
    db.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, 'Billing V1', 'billing-v1', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      accountId,
      providerId,
      "webhook_secret_ciphertext",
    );
    db.prepare(
      `INSERT INTO billing_providers (
         id, account_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'sandbox', 'test_client_token_v1', ?, 'active', ?, ?)`,
    ).run(providerId, accountId, encryptedSecret, nowIso, nowIso);
    db.prepare(
      `INSERT INTO products (
         id, account_id, slug, name, billing_environment, status, created_at, updated_at
       ) VALUES ('prd_one', ?, 'one', 'One Time', 'sandbox', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_one', ?, 'prd_one', 'One Time', 'perpetual', 'opaque',
         0, '[]', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    db.prepare(
      `INSERT INTO billing_offers (
         id, account_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_one', ?, ?, 'pri_one123', 'prd_one', 'pln_one',
         'one_time', 'active', ?, ?)`,
    ).run(accountId, providerId, nowIso, nowIso);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function postEvent(rawBody: string, secret = webhookSecret, destinationProviderId = providerId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await computeHmacSha256(`${timestamp}:${rawBody}`, secret);
    const response = await app.request(
      `/api/v1/webhooks/payments/billing-v1/${destinationProviderId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "paddle-signature": `ts=${timestamp};h1=${signature}` },
        body: rawBody,
      },
      testEnv.env,
    );
    return { response, body: await response.json() as any };
  }

  async function processEvent(inboundEventId: string, processingNow = new Date(Date.now() + 1_000)) {
    return processBillingInboundEvent({
      env: testEnv.env,
      accountId,
      eventId: inboundEventId,
      workerId: `test_${inboundEventId}`,
      now: processingNow,
    });
  }

  function seedLinkedCustomer(externalCustomerId = "ctm_buyer1", email = "buyer@example.test"): void {
    testEnv.sqliteDb.prepare(
      `INSERT INTO customers (id, account_id, email, name, status, created_at, updated_at)
       VALUES ('cus_buyer', ?, ?, 'Buyer', 'active', ?, ?)`,
    ).run(accountId, email, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_customers (
         id, account_id, billing_provider_id, customer_id, external_customer_id,
         provider_email, provider_status, link_status, last_sync_source,
         external_updated_at, created_at, updated_at
       ) VALUES ('bcu_buyer', ?, ?, 'cus_buyer', ?, ?, 'active', 'linked',
         'webhook', ?, ?, ?)`,
    ).run(accountId, providerId, externalCustomerId, email, nowIso, nowIso, nowIso);
  }

  async function issueOneTimeLicense(transactionId = "txn_purchase1"): Promise<{ eventId: string; licenseId: string }> {
    const payload = eventPayload(`evt_${transactionId}`, "transaction.completed", {
      id: transactionId,
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    });
    const posted = await postEvent(payload);
    expect(posted.response.status).toBe(200);
    const result = await processEvent(posted.body.data.eventId);
    expect(result.status).toBe("processed");
    const license = testEnv.sqliteDb.prepare(
      "SELECT id FROM licenses WHERE source_external_transaction_id = ?",
    ).get(transactionId) as { id: string };
    return { eventId: posted.body.data.eventId, licenseId: license.id };
  }

  async function configureProviderApiKey(apiKey = "pdl_sdbx_apikey_v1"): Promise<void> {
    const encrypted = await encryptBillingProviderSecret(
      apiKey,
      testEnv.env,
      accountId,
      providerId,
      "api_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      "UPDATE billing_providers SET api_secret_ciphertext = ? WHERE account_id = ? AND id = ?",
    ).run(encrypted, accountId, providerId);
  }

  it("verifies the raw signature and persists one encrypted event idempotently", async () => {
    const payload = eventPayload("evt_customer_signature", "customer.updated", {
      id: "ctm_signature1",
      email: "signed@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    const rejected = await postEvent(payload, "wrong-secret");
    expect(rejected.response.status).toBe(401);
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get()).toEqual({ count: 0 });

    const first = await postEvent(payload);
    const duplicate = await postEvent(payload);
    expect(first.response.status).toBe(200);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body.data.duplicate).toBe(true);
    expect(duplicate.body.data.payloadRefreshed).toBe(false);
    const rows = testEnv.sqliteDb.prepare(
      "SELECT payload_ciphertext, payload_hash FROM inbound_events WHERE external_event_id = ?",
    ).all("evt_customer_signature") as Array<{ payload_ciphertext: string; payload_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_ciphertext).not.toContain("signed@example.test");
    expect(rows[0].payload_hash).toBe(await sha256Hex(payload));

    const conflicting = await postEvent(eventPayload("evt_customer_signature", "customer.updated", {
      id: "ctm_signature1",
      email: "different@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    }));
    expect(conflicting.response.status).toBe(409);
    expect(conflicting.body.error.code).toBe("BILLING_WEBHOOK_EVENT_ID_CONFLICT");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get()).toEqual({ count: 1 });
  });

  it("refreshes an expired payload only for the identical unfinished Paddle event", async () => {
    const payload = eventPayload("evt_payload_refresh", "customer.updated", {
      id: "ctm_refresh1",
      email: "refresh@example.test",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    });
    const first = await postEvent(payload);
    testEnv.sqliteDb.prepare(
      `UPDATE inbound_events
       SET status = 'needs_attention', payload_expires_at = '2026-09-18T00:00:00.000Z',
           last_error_code = 'BILLING_EVENT_PAYLOAD_EXPIRED',
           last_error_detail = '{"message":"expired"}'
       WHERE id = ?`,
    ).run(first.body.data.eventId);
    await expect(clearExpiredInboundEventPayloads(testEnv.d1, {
      now: new Date("2026-09-19T08:01:00.000Z"),
    })).resolves.toEqual({ cleared: 1 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT payload_ciphertext, payload_cleared_at FROM inbound_events WHERE id = ?",
    ).get(first.body.data.eventId)).toEqual({
      payload_ciphertext: null,
      payload_cleared_at: "2026-09-19T08:01:00.000Z",
    });

    const replay = await postEvent(payload);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      eventId: first.body.data.eventId,
      duplicate: true,
      payloadRefreshed: true,
      status: "needs_attention",
    });
    const refreshed = testEnv.sqliteDb.prepare(
      `SELECT status, payload_ciphertext, payload_expires_at, payload_cleared_at, last_error_code
       FROM inbound_events WHERE id = ?`,
    ).get(first.body.data.eventId) as any;
    expect(refreshed.status).toBe("needs_attention");
    expect(refreshed.payload_ciphertext).toBeTruthy();
    expect(Date.parse(refreshed.payload_expires_at)).toBeGreaterThan(Date.now());
    expect(refreshed.payload_cleared_at).toBeNull();
    expect(refreshed.last_error_code).toBe("BILLING_EVENT_PAYLOAD_EXPIRED");
  });

  it("keeps an out-of-order subscription purchase pending, then fulfills once trusted dependencies arrive", async () => {
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (id, account_id, slug, name, billing_environment, status, created_at, updated_at)
       VALUES ('prd_sub', ?, 'sub', 'Subscription', 'sandbox', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_sub', ?, 'prd_sub', 'Subscription', 'subscription', 'opaque',
         86400, '[]', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, account_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_sub', ?, ?, 'pri_sub123', 'prd_sub', 'pln_sub',
         'subscription', 'active', ?, ?)`,
    ).run(accountId, providerId, nowIso, nowIso);

    const transaction = await postEvent(eventPayload("evt_txn_early", "transaction.completed", {
      id: "txn_early1",
      customer_id: "ctm_early1",
      subscription_id: "sub_early1",
      items: [{ price: { id: "pri_sub123" }, quantity: 1 }],
    }));
    expect((await processEvent(transaction.body.data.eventId)).status).toBe("pending");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(transaction.body.data.eventId) as any).last_error_code).toBe("BILLING_DEPENDENCY_PENDING");

    const customer = await postEvent(eventPayload("evt_customer_early", "customer.created", {
      id: "ctm_early1",
      email: "early@example.test",
      name: "Early Buyer",
      status: "active",
      created_at: nowIso,
      updated_at: nowIso,
    }));
    expect((await processEvent(customer.body.data.eventId)).status).toBe("processed");

    const subscription = await postEvent(eventPayload("evt_sub_early", "subscription.created", {
      id: "sub_early1",
      transaction_id: "txn_early1",
      customer_id: "ctm_early1",
      status: "active",
      current_billing_period: {
        starts_at: "2026-09-19T08:00:00.000Z",
        ends_at: "2026-10-19T08:00:00.000Z",
      },
      next_billed_at: "2026-10-19T08:00:00.000Z",
      items: [{ price: { id: "pri_sub123" }, quantity: 1 }],
    }));
    expect((await processEvent(subscription.body.data.eventId)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses WHERE source_external_transaction_id = 'txn_early1'").get())
      .toEqual({ count: 1 });
    expect((testEnv.sqliteDb.prepare("SELECT status, external_subscription_id FROM billing_subscriptions").get() as any))
      .toMatchObject({ status: "active", external_subscription_id: "sub_early1" });
  });

  it.each([
    ["unknown price", [{ price: { id: "pri_unknown1" }, quantity: 1 }], "BILLING_OFFER_MAPPING_MISSING"],
    ["multiple lines", [
      { price: { id: "pri_one123" }, quantity: 1 },
      { price: { id: "pri_unknown2" }, quantity: 1 },
    ], "BILLING_TRANSACTION_ITEMS_UNSUPPORTED"],
    ["quantity greater than one", [{ price: { id: "pri_one123" }, quantity: 2 }], "BILLING_TRANSACTION_ITEMS_UNSUPPORTED"],
  ])("moves an unsupported %s purchase to needs_attention", async (_name, items, errorCode) => {
    seedLinkedCustomer();
    const id = `txn_bad_${String(errorCode).toLowerCase()}_${items.length}`;
    const posted = await postEvent(eventPayload(`evt_${id}`, "transaction.completed", {
      id,
      customer_id: "ctm_buyer1",
      items,
    }));
    const result = await processEvent(posted.body.data.eventId);
    expect(result.status).toBe("needs_attention");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(posted.body.data.eventId) as any).last_error_code).toBe(errorCode);
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses").get()).toEqual({ count: 0 });
  });

  it("persists exact approved full-refund semantics and suspends without revoking activations", async () => {
    seedLinkedCustomer();
    const { licenseId } = await issueOneTimeLicense("txn_refund1");
    testEnv.sqliteDb.prepare(
      `INSERT INTO activations (
         id, account_id, license_id, fingerprint_hash, machine_token_hash,
         status, activated_at, updated_at
       ) VALUES ('act_refund', ?, ?, 'fp_refund', 'mt_refund', 'active', ?, ?)`,
    ).run(accountId, licenseId, nowIso, nowIso);
    const adjustment = await postEvent(eventPayload("evt_adj_refund", "adjustment.updated", {
      id: "adj_refund1",
      transaction_id: "txn_refund1",
      customer_id: "ctm_buyer1",
      action: "refund",
      type: "full",
      status: "approved",
      currency_code: "USD",
      total: "1000",
      reason: "requested_by_customer",
    }, "2026-09-19T09:00:00.000Z"));
    expect((await processEvent(adjustment.body.data.eventId)).status).toBe("needs_attention");
    expect(testEnv.sqliteDb.prepare(
      `SELECT provider_action, adjustment_type, provider_status, automatic_effect, review_status
       FROM billing_adjustments WHERE external_adjustment_id = 'adj_refund1'`,
    ).get()).toEqual({
      provider_action: "refund",
      adjustment_type: "full",
      provider_status: "approved",
      automatic_effect: "license_suspended",
      review_status: "open",
    });
    expect(testEnv.sqliteDb.prepare("SELECT status, status_reason FROM licenses WHERE id = ?").get(licenseId))
      .toEqual({ status: "suspended", status_reason: "billing_adjustment" });
    expect(testEnv.sqliteDb.prepare("SELECT status FROM activations WHERE id = 'act_refund'").get())
      .toEqual({ status: "active" });
  });

  it("does not expose a LicenKit public Checkout configuration endpoint", async () => {
    const response = await app.request(
      "/api/v1/public/accounts/billing-v1/products/one/checkout",
      { method: "GET" },
      testEnv.env,
    );

    expect(response.status).toBe(404);
  });

  it("does not require removed Checkout SDK PricePreview evidence for a Live Offer", async () => {
    const liveProviderId = "bpr_live_readiness";
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      accountId,
      liveProviderId,
      "webhook_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, account_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_client_token_v1', ?, 'active', ?, ?)`,
    ).run(liveProviderId, accountId, encryptedSecret, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, account_id, slug, name, billing_environment, status, created_at, updated_at
       ) VALUES ('prd_live_readiness', ?, 'live-readiness', 'Live Readiness', 'live', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_live_readiness', ?, 'prd_live_readiness', 'Live Readiness', 'perpetual', 'opaque',
         0, '[]', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, account_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_live_readiness', ?, ?, 'pri_live_readiness', 'prd_live_readiness',
         'pln_live_readiness', 'one_time', 'draft', ?, ?)`,
    ).run(accountId, liveProviderId, nowIso, nowIso);
    const row = await getBillingOfferReadinessRow(testEnv.env.DB, accountId, "off_live_readiness");
    expect(row).not.toBeNull();

    const readiness = await evaluateBillingOfferReadiness(testEnv.env.DB, row!, { activation: true });

    expect(readiness.checks.map((item) => item.key)).not.toContain("live_price_preview");
  });

  it("paginates active Accounts so work after the first page is not starved", async () => {
    const db = testEnv.sqliteDb;
    const insertAccount = db.prepare(
      `INSERT INTO accounts (id, name, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    );
    for (let index = 0; index < 105; index++) {
      const suffix = String(index).padStart(3, "0");
      insertAccount.run(`acc_page_${suffix}`, `Page ${suffix}`, `page-${suffix}`, nowIso, nowIso);
    }
    const lateAccountId = "acc_page_104";
    const lateProviderId = "bpr_page_104";
    const encryptedSecret = await encryptBillingProviderSecret(
      webhookSecret,
      testEnv.env,
      lateAccountId,
      lateProviderId,
      "webhook_secret_ciphertext",
    );
    db.prepare(
      `INSERT INTO billing_providers (
         id, account_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'sandbox', 'test_page_token', ?, 'active', ?, ?)`,
    ).run(lateProviderId, lateAccountId, encryptedSecret, nowIso, nowIso);
    const eventId = "ine_last_page";
    const rawBody = eventPayload("evt_last_page", "product.updated", { id: "pro_lastpage" });
    const payloadCiphertext = await encryptInboundPayload(
      rawBody,
      testEnv.env,
      lateAccountId,
      eventId,
    );
    const scheduleNow = new Date(Date.now() + 1_000);
    db.prepare(
      `INSERT INTO inbound_events (
         id, account_id, billing_provider_id, external_event_id, external_event_type,
         payload_ciphertext, payload_hash, payload_expires_at, status, attempt_count,
         next_attempt_at, received_at, updated_at
       ) VALUES (?, ?, ?, 'evt_last_page', 'product.updated', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      eventId,
      lateAccountId,
      lateProviderId,
      payloadCiphertext,
      await sha256Hex(rawBody),
      new Date(scheduleNow.getTime() + 86_400_000).toISOString(),
      nowIso,
      nowIso,
      nowIso,
    );
    const result = await processDueBillingInboundEvents(testEnv.env, {
      accountLimit: 25,
      eventLimitPerAccount: 5,
      now: scheduleNow,
      workerId: "scheduler_pagination_test",
    });
    expect(result.accounts).toBe(106);
    expect(result.processed).toBe(1);
    expect(db.prepare("SELECT status, result_type FROM inbound_events WHERE id = ?").get(eventId))
      .toEqual({ status: "processed", result_type: "ignored_event_type" });
  });

  it("consumes a Sandbox verification token once and creates only a permanently suspended evidence License", async () => {
    seedLinkedCustomer();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_verify', ?, 'admin@example.test', 'hash', 'Admin', 'owner', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      "UPDATE billing_offers SET status = 'draft' WHERE id = 'off_one'",
    ).run();
    // Verification intentionally remains valid when the public Product is
    // bound to Live; the draft Offer itself is on a Sandbox Provider.
    testEnv.sqliteDb.prepare(
      "UPDATE products SET billing_environment = 'live' WHERE id = 'prd_one'",
    ).run();
    const token = "vfy_single_use_token";
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, account_id, billing_offer_id, requested_by_user_id, token_hash,
         status, expires_at, created_at, updated_at
       ) VALUES ('bcv_one', ?, 'off_one', 'usr_verify', ?, 'pending',
         '2026-09-20T08:00:00.000Z', ?, ?)`,
    ).run(accountId, await sha256Hex(token), nowIso, nowIso);
    const first = await postEvent(eventPayload("evt_verify_one", "transaction.completed", {
      id: "txn_verify1",
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
      custom_data: { licenkit_checkout_verification: token },
    }));
    expect((await processEvent(first.body.data.eventId)).status).toBe("processed");
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, status_reason, is_checkout_verification
       FROM licenses WHERE source_external_transaction_id = 'txn_verify1'`,
    ).get()).toEqual({ status: "suspended", status_reason: "checkout_verification", is_checkout_verification: 1 });
    expect((testEnv.sqliteDb.prepare("SELECT status FROM billing_checkout_verifications WHERE id = 'bcv_one'").get() as any).status)
      .toBe("delivery_pending");

    const replay = await postEvent(eventPayload("evt_verify_reuse", "transaction.completed", {
      id: "txn_verify2",
      customer_id: "ctm_buyer1",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
      custom_data: { licenkit_checkout_verification: token },
    }));
    expect((await processEvent(replay.body.data.eventId)).status).toBe("needs_attention");
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?")
      .get(replay.body.data.eventId) as any).last_error_code).toBe("BILLING_CHECKOUT_VERIFICATION_INVALID");
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM licenses").get()).toEqual({ count: 1 });

    const liveProviderId = "bpr_live_v1";
    const liveSecret = "pdl_ntfsec_live_test_secret_123456789";
    const encryptedLiveSecret = await encryptBillingProviderSecret(
      liveSecret,
      testEnv.env,
      accountId,
      liveProviderId,
      "webhook_secret_ciphertext",
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_providers (
         id, account_id, provider, environment, client_side_token,
         webhook_secret_ciphertext, status, created_at, updated_at
       ) VALUES (?, ?, 'paddle', 'live', 'live_client_token_v1', ?, 'active', ?, ?)`,
    ).run(liveProviderId, accountId, encryptedLiveSecret, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_offers (
         id, account_id, billing_provider_id, external_price_id, product_id,
         license_plan_id, purchase_type, status, created_at, updated_at
       ) VALUES ('off_live_verify', ?, ?, 'pri_live123', 'prd_one', 'pln_one',
         'one_time', 'draft', ?, ?)`,
    ).run(accountId, liveProviderId, nowIso, nowIso);
    const liveToken = "vfy_live_must_not_work";
    const liveTokenHash = await sha256Hex(liveToken);
    expect(() => testEnv.sqliteDb.prepare(
      `INSERT INTO billing_checkout_verifications (
         id, account_id, billing_offer_id, requested_by_user_id, token_hash,
         status, expires_at, created_at, updated_at
       ) VALUES ('bcv_live', ?, 'off_live_verify', 'usr_verify', ?, 'pending',
         '2026-09-20T08:00:00.000Z', ?, ?)`,
    ).run(accountId, liveTokenHash, nowIso, nowIso)).toThrow(/draft_sandbox_offer/);
  });

  it("deduplicates Paddle auth failures, blocks scheduling, and lets a trusted Customer webhook unblock only its own purchases", async () => {
    await configureProviderApiKey();
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "authentication_error", detail: "API key lacks customer.read" },
      meta: { request_id: "req_auth_failure" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_auth_failure" },
    }));
    vi.stubGlobal("fetch", providerFetch);

    const first = await postEvent(eventPayload("evt_auth_block_one", "transaction.completed", {
      id: "txn_auth_block_one",
      customer_id: "ctm_authone",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    }));
    const second = await postEvent(eventPayload("evt_auth_block_two", "transaction.completed", {
      id: "txn_auth_block_two",
      customer_id: "ctm_authtwo",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    }));
    testEnv.sqliteDb.prepare(
      "UPDATE inbound_events SET received_at = ? WHERE id = ?",
    ).run(new Date(Date.now() - 25 * 60 * 60_000).toISOString(), second.body.data.eventId);
    const firstProcess = await processEvent(first.body.data.eventId);
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?").get(first.body.data.eventId) as any).last_error_code)
      .toBe("BILLING_PROVIDER_API_AUTH_INVALID");
    expect(firstProcess.status).toBe("pending");
    expect((await processEvent(second.body.data.eventId)).status).toBe("pending");

    const issues = testEnv.sqliteDb.prepare(
      `SELECT id, status, occurrence_count, last_error_detail_json
       FROM system_issues
       WHERE account_id = ? AND billing_provider_id = ?`,
    ).all(accountId, providerId) as Array<any>;
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("open");
    expect(issues[0].occurrence_count).toBe(2);
    expect(JSON.parse(issues[0].last_error_detail_json)).toMatchObject({
      httpStatus: 403,
      providerCode: "authentication_error",
      requestId: "req_auth_failure",
      message: "API key lacks customer.read",
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM system_issue_inbound_events WHERE system_issue_id = ?",
    ).get(issues[0].id)).toEqual({ count: 2 });
    const listed = await listSystemIssues({ db: testEnv.d1, accountId });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: issues[0].id,
      occurrenceCount: 2,
      recoveryPreview: { affectedEventCount: 2, blockedEventCount: 2, retryableEventCount: 2 },
    });
    const detail = await getSystemIssueDetail({ db: testEnv.d1, accountId, issueId: issues[0].id });
    expect(detail).toMatchObject({
      id: issues[0].id,
      recoveryPreview: { affectedEventCount: 2, blockedEventCount: 2, retryableEventCount: 2 },
    });
    expect((detail.affectedEvents as Array<unknown>)).toHaveLength(2);
    const blocked = testEnv.sqliteDb.prepare(
      `SELECT external_customer_id, status, next_attempt_at, last_error_code,
              last_error_detail, blocking_system_issue_id
       FROM inbound_events
       WHERE id IN (?, ?)
       ORDER BY external_customer_id`,
    ).all(first.body.data.eventId, second.body.data.eventId) as Array<any>;
    expect(blocked).toHaveLength(2);
    for (const event of blocked) {
      expect(event).toMatchObject({
        status: "pending",
        next_attempt_at: null,
        last_error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
        blocking_system_issue_id: issues[0].id,
      });
      expect(JSON.parse(event.last_error_detail)).toMatchObject({
        httpStatus: 403,
        providerCode: "authentication_error",
        requestId: "req_auth_failure",
      });
    }

    const skipped = await processDueBillingInboundEvents(testEnv.env, {
      now: new Date(Date.now() + 5_000),
      workerId: "blocked_scheduler",
    });
    expect(skipped.claimed).toBe(0);
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const customerWebhook = await postEvent(eventPayload("evt_customer_unblocks_one", "customer.updated", {
      id: "ctm_authone",
      email: "mapped-one@example.test",
      name: "Mapped One",
      status: "active",
      created_at: nowIso,
      updated_at: "2026-09-19T08:01:00.000Z",
    }));
    expect((await processEvent(customerWebhook.body.data.eventId)).status).toBe("processed");
    const afterWebhook = testEnv.sqliteDb.prepare(
      `SELECT external_customer_id, blocking_system_issue_id, next_attempt_at
       FROM inbound_events
       WHERE id IN (?, ?)
       ORDER BY external_customer_id`,
    ).all(first.body.data.eventId, second.body.data.eventId) as Array<any>;
    expect(afterWebhook[0].external_customer_id).toBe("ctm_authone");
    expect(afterWebhook[0].blocking_system_issue_id).toBeNull();
    expect(afterWebhook[0].next_attempt_at).not.toBeNull();
    expect(afterWebhook[1]).toMatchObject({
      external_customer_id: "ctm_authtwo",
      blocking_system_issue_id: issues[0].id,
      next_attempt_at: null,
    });
    expect(testEnv.sqliteDb.prepare("SELECT status FROM system_issues WHERE id = ?").get(issues[0].id))
      .toEqual({ status: "open" });
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM system_issue_inbound_events WHERE system_issue_id = ?",
    ).get(issues[0].id)).toEqual({ count: 2 });

    expect((await processEvent(first.body.data.eventId, new Date(Date.now() + 10_000))).status).toBe("processed");
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM licenses WHERE source_external_transaction_id = 'txn_auth_block_one'",
    ).get()).toEqual({ count: 1 });
  });

  it("verifies a fixed customer.read capability before resolving and requeues only eligible blocked events", async () => {
    await configureProviderApiKey();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_system_fix', ?, 'fixer@example.test', 'hash', 'Fixer', 'owner', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "authentication_error", detail: "Invalid API key" },
    }), {
      status: 401,
      headers: { "content-type": "application/json", "request-id": "req_invalid_key" },
    })));
    const posted = await postEvent(eventPayload("evt_resolve_auth", "transaction.completed", {
      id: "txn_resolve_auth",
      customer_id: "ctm_resolveauth",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    }));
    const firstProcess = await processEvent(posted.body.data.eventId);
    expect((testEnv.sqliteDb.prepare("SELECT last_error_code FROM inbound_events WHERE id = ?").get(posted.body.data.eventId) as any).last_error_code)
      .toBe("BILLING_PROVIDER_API_AUTH_INVALID");
    expect(firstProcess.status).toBe("pending");
    let issue = testEnv.sqliteDb.prepare(
      "SELECT id, updated_at FROM system_issues WHERE account_id = ? AND billing_provider_id = ?",
    ).get(accountId, providerId) as { id: string; updated_at: string };
    const stillUnauthorized = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "forbidden", detail: "customer.read is still missing" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_still_forbidden" },
    }));
    await expect(resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: issue.id,
      userId: "usr_system_fix",
      resolutionNote: "First attempted fix.",
      retryAffectedEvents: true,
      expectedUpdatedAt: issue.updated_at,
      fetchImpl: stillUnauthorized as typeof fetch,
      now: new Date(Date.now() + 3_000),
    })).rejects.toMatchObject({ code: "SYSTEM_ISSUE_VERIFICATION_FAILED", status: 409 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, occurrence_count FROM system_issues WHERE id = ?",
    ).get(issue.id)).toEqual({ status: "open", occurrence_count: 2 });
    issue = testEnv.sqliteDb.prepare(
      "SELECT id, updated_at FROM system_issues WHERE account_id = ? AND billing_provider_id = ?",
    ).get(accountId, providerId) as { id: string; updated_at: string };
    const verification = vi.fn(async () => new Response(JSON.stringify({ data: [], meta: { request_id: "req_capability_ok" } }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_capability_ok" },
    }));
    const resolvedAt = new Date(Date.now() + 5_000);
    const result = await resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: issue.id,
      userId: "usr_system_fix",
      resolutionNote: "Replaced API key and granted customer.read.",
      retryAffectedEvents: true,
      expectedUpdatedAt: issue.updated_at,
      fetchImpl: verification as typeof fetch,
      now: resolvedAt,
    });
    expect(verification).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: issue.id,
      status: "resolved",
      retryAffectedEvents: true,
      retriedEventCount: 1,
      skippedAffectedEventCount: 0,
    });
    const event = testEnv.sqliteDb.prepare(
      `SELECT status, next_attempt_at, last_error_code, blocking_system_issue_id
       FROM inbound_events WHERE id = ?`,
    ).get(posted.body.data.eventId) as any;
    expect(event).toEqual({
      status: "pending",
      next_attempt_at: resolvedAt.toISOString(),
      last_error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      blocking_system_issue_id: null,
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM audit_logs WHERE action = 'system_issue.resolve' AND resource_id = ?",
    ).get(issue.id)).toEqual({ count: 1 });

    const eventCustomerRead = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/customers/ctm_resolveauth");
      return new Response(JSON.stringify({
        data: {
          id: "ctm_resolveauth",
          email: "resolved-customer@example.test",
          name: "Resolved Customer",
          status: "active",
          created_at: nowIso,
          updated_at: "2026-09-19T08:02:00.000Z",
        },
        meta: { request_id: "req_event_customer_ok" },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_event_customer_ok" },
      });
    });
    vi.stubGlobal("fetch", eventCustomerRead);
    expect((await processEvent(posted.body.data.eventId, new Date(resolvedAt.getTime() + 1_000))).status)
      .toBe("processed");
    expect(eventCustomerRead).toHaveBeenCalledTimes(1);
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, result_type, last_error_code, blocking_system_issue_id
       FROM inbound_events WHERE id = ?`,
    ).get(posted.body.data.eventId)).toEqual({
      status: "processed",
      result_type: "license_issued",
      last_error_code: null,
      blocking_system_issue_id: null,
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM licenses WHERE source_external_transaction_id = 'txn_resolve_auth'",
    ).get()).toEqual({ count: 1 });
    expect(testEnv.sqliteDb.prepare(
      "SELECT count(*) AS count FROM outbound_deliveries WHERE event_type = 'customer.license_issued'",
    ).get()).toEqual({ count: 1 });

    const billingCustomer = testEnv.sqliteDb.prepare(
      "SELECT id FROM billing_customers WHERE account_id = ? AND external_customer_id = 'ctm_resolveauth'",
    ).get(accountId) as { id: string };
    await expect(reconcileBillingCustomer({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      billingCustomerId: billingCustomer.id,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: { code: "authentication_error", detail: "Rotated key is invalid again" },
      }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch,
      now: new Date(resolvedAt.getTime() + 2_000),
    })).rejects.toMatchObject({ code: "BILLING_PROVIDER_API_AUTH_INVALID" });
    const reopened = testEnv.sqliteDb.prepare(
      "SELECT id, status, occurrence_count FROM system_issues WHERE account_id = ? AND billing_provider_id = ?",
    ).all(accountId, providerId);
    expect(reopened).toEqual([{ id: issue.id, status: "open", occurrence_count: 3 }]);
  });

  it("records manual reconcile auth failure as the same provider issue without inventing an inbound event", async () => {
    await configureProviderApiKey();
    seedLinkedCustomer("ctm_reconcile1", "reconcile@example.test");
    const rejected = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "authentication_error", detail: "Key is not authorized" },
    }), {
      status: 401,
      headers: { "content-type": "application/json", "request-id": "req_reconcile_auth" },
    }));
    await expect(reconcileBillingCustomer({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      billingCustomerId: "bcu_buyer",
      fetchImpl: rejected as typeof fetch,
      now: new Date(Date.now() + 1_000),
    })).rejects.toMatchObject({ code: "BILLING_PROVIDER_API_AUTH_INVALID" });
    expect(rejected).toHaveBeenCalledTimes(1);
    const issue = testEnv.sqliteDb.prepare(
      `SELECT capability, issue_code, occurrence_count
       FROM system_issues WHERE account_id = ? AND billing_provider_id = ?`,
    ).get(accountId, providerId);
    expect(issue).toEqual({
      capability: "customer_read",
      issue_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      occurrence_count: 1,
    });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM system_issue_inbound_events").get())
      .toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get())
      .toEqual({ count: 0 });
  });

  it("does not resolve when the same issue recurs within the updated_at millisecond", async () => {
    await configureProviderApiKey();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_same_ms_fix', ?, 'same-ms-fixer@example.test', 'hash', 'Same Millisecond Fixer',
         'owner', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    const occurredAt = new Date("2026-09-19T08:05:00.123Z");
    const first = await recordProviderSystemIssue({
      db: testEnv.d1,
      accountId,
      billingProviderId: providerId,
      capability: "customer_read",
      issueCode: "BILLING_PROVIDER_API_AUTH_INVALID",
      providerError: {
        provider: "paddle",
        operation: "customers.list",
        httpStatus: 403,
        providerCode: "forbidden",
        requestId: "req_same_ms_first",
        retryAfter: null,
        message: "customer.read is missing",
      },
      now: occurredAt,
    });
    const issue = testEnv.sqliteDb.prepare(
      "SELECT id, updated_at FROM system_issues WHERE id = ?",
    ).get(first.issueId) as { id: string; updated_at: string };
    const verification = vi.fn(async () => {
      await recordProviderSystemIssue({
        db: testEnv.d1,
        accountId,
        billingProviderId: providerId,
        capability: "customer_read",
        issueCode: "BILLING_PROVIDER_API_AUTH_INVALID",
        providerError: {
          provider: "paddle",
          operation: "customers.get",
          httpStatus: 403,
          providerCode: "forbidden",
          requestId: "req_same_ms_second",
          retryAfter: null,
          message: "A concurrent request still observed the missing permission",
        },
        now: occurredAt,
      });
      return new Response(JSON.stringify({ data: [], meta: { request_id: "req_probe_ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: issue.id,
      userId: "usr_same_ms_fix",
      resolutionNote: "The configured key now passes the probe.",
      retryAffectedEvents: false,
      expectedUpdatedAt: issue.updated_at,
      fetchImpl: verification as typeof fetch,
      now: new Date("2026-09-19T08:05:01.000Z"),
    })).rejects.toMatchObject({ code: "SYSTEM_ISSUE_STALE", status: 409 });
    expect(verification).toHaveBeenCalledTimes(1);
    expect(testEnv.sqliteDb.prepare(
      "SELECT status, occurrence_count, updated_at FROM system_issues WHERE id = ?",
    ).get(issue.id)).toEqual({
      status: "open",
      occurrence_count: 2,
      updated_at: occurredAt.toISOString(),
    });
  });

  it("can explicitly retry a resolved issue after Paddle replay restores an expired payload", async () => {
    await configureProviderApiKey();
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_deferred_retry', ?, 'deferred-retry@example.test', 'hash', 'Deferred Retry',
         'owner', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "forbidden", detail: "customer.read is missing" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_deferred_auth" },
    })));
    const rawPayload = eventPayload("evt_deferred_retry", "transaction.completed", {
      id: "txn_deferred_retry",
      customer_id: "ctm_deferredretry",
      items: [{ price: { id: "pri_one123" }, quantity: 1 }],
    });
    const posted = await postEvent(rawPayload);
    expect((await processEvent(posted.body.data.eventId)).status).toBe("pending");
    const openIssue = testEnv.sqliteDb.prepare(
      "SELECT id, updated_at FROM system_issues WHERE account_id = ? AND billing_provider_id = ?",
    ).get(accountId, providerId) as { id: string; updated_at: string };
    const resolvedAt = new Date(Date.now() + 2_000);
    await resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: openIssue.id,
      userId: "usr_deferred_retry",
      resolutionNote: "Permission repaired; defer event processing.",
      retryAffectedEvents: false,
      expectedUpdatedAt: openIssue.updated_at,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      now: resolvedAt,
    });
    const resolvedIssue = testEnv.sqliteDb.prepare(
      "SELECT id, status, updated_at FROM system_issues WHERE id = ?",
    ).get(openIssue.id) as { id: string; status: string; updated_at: string };
    expect(resolvedIssue.status).toBe("resolved");
    expect(testEnv.sqliteDb.prepare(
      "SELECT blocking_system_issue_id FROM inbound_events WHERE id = ?",
    ).get(posted.body.data.eventId)).toEqual({ blocking_system_issue_id: openIssue.id });

    testEnv.sqliteDb.prepare(
      "UPDATE inbound_events SET payload_expires_at = ? WHERE id = ?",
    ).run(new Date(resolvedAt.getTime() + 1_000).toISOString(), posted.body.data.eventId);
    await expect(clearExpiredInboundEventPayloads(testEnv.d1, {
      now: new Date(resolvedAt.getTime() + 2_000),
    })).resolves.toEqual({ cleared: 1 });
    const nothingReady = await retryResolvedSystemIssueEvents({
      db: testEnv.d1,
      accountId,
      issueId: openIssue.id,
      userId: "usr_deferred_retry",
      expectedUpdatedAt: resolvedIssue.updated_at,
      now: new Date(resolvedAt.getTime() + 3_000),
    });
    expect(nothingReady).toMatchObject({ retriedEventCount: 0, skippedAffectedEventCount: 1 });

    const replay = await postEvent(rawPayload);
    expect(replay.body.data).toMatchObject({
      eventId: posted.body.data.eventId,
      duplicate: true,
      payloadRefreshed: true,
    });
    expect(testEnv.sqliteDb.prepare(
      "SELECT blocking_system_issue_id FROM inbound_events WHERE id = ?",
    ).get(posted.body.data.eventId)).toEqual({ blocking_system_issue_id: openIssue.id });

    const retriedAt = new Date(resolvedAt.getTime() + 5_000);
    const retried = await retryResolvedSystemIssueEvents({
      db: testEnv.d1,
      accountId,
      issueId: openIssue.id,
      userId: "usr_deferred_retry",
      expectedUpdatedAt: resolvedIssue.updated_at,
      now: retriedAt,
    });
    expect(retried).toMatchObject({ retriedEventCount: 1, skippedAffectedEventCount: 0 });
    expect(testEnv.sqliteDb.prepare(
      `SELECT status, next_attempt_at, last_error_code, blocking_system_issue_id
       FROM inbound_events WHERE id = ?`,
    ).get(posted.body.data.eventId)).toEqual({
      status: "pending",
      next_attempt_at: retriedAt.toISOString(),
      last_error_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      blocking_system_issue_id: null,
    });
  });

  it("records and verifies a customer portal auth issue without replaying a short-lived request", async () => {
    await configureProviderApiKey();
    seedLinkedCustomer("ctm_portal1", "portal@example.test");
    testEnv.sqliteDb.prepare(
      `INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at)
       VALUES ('usr_portal_fix', ?, 'portal-fixer@example.test', 'hash', 'Portal Fixer', 'owner', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO products (
         id, account_id, slug, name, billing_environment, status, created_at, updated_at
       ) VALUES ('prd_portal', ?, 'portal', 'Portal Subscription', 'sandbox', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO license_plans (
         id, account_id, product_id, name, license_model, credential_mode,
         payment_grace_seconds, features_json, status, created_at, updated_at
       ) VALUES ('pln_portal', ?, 'prd_portal', 'Portal Subscription', 'subscription', 'opaque',
         86400, '[]', 'active', ?, ?)`,
    ).run(accountId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO licenses (
         id, account_id, customer_id, product_id, plan_id, plan_revision,
         license_model, renewal_mode, credential_mode, signed_token_ttl_seconds,
         payment_grace_seconds, max_activations, features_json, key_hash,
         key_version, source, source_billing_provider_id,
         source_external_transaction_id, status, expires_at, created_at, updated_at
       ) VALUES (
         'lic_portal1', ?, 'cus_buyer', 'prd_portal', 'pln_portal', 1,
         'subscription', 'billing', 'opaque', 0,
         86400, 1, '[]', 'portal-key-hash',
         1, 'payment', ?, 'txn_portal1', 'active',
         '2026-10-19T08:00:00.000Z', ?, ?
       )`,
    ).run(accountId, providerId, nowIso, nowIso);
    testEnv.sqliteDb.prepare(
      `INSERT INTO billing_subscriptions (
         id, account_id, billing_provider_id, license_id,
         external_subscription_id, external_customer_id, external_price_id,
         status, current_period_start, current_period_end, next_billed_at,
         created_at, updated_at
       ) VALUES (
         'bsub_portal1', ?, ?, 'lic_portal1',
         'sub_portal1', 'ctm_portal1', 'pri_portal1',
         'active', ?, '2026-10-19T08:00:00.000Z', '2026-10-19T08:00:00.000Z',
         ?, ?
       )`,
    ).run(accountId, providerId, nowIso, nowIso, nowIso);

    const rejected = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "forbidden", detail: "customer_portal_session.write is missing" },
    }), {
      status: 403,
      headers: { "content-type": "application/json", "request-id": "req_portal_forbidden" },
    }));
    const failedAt = new Date(Date.now() + 1_000);
    await expect(createCustomerPortalSession({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      customerId: "cus_buyer",
      licenseId: "lic_portal1",
      fetchImpl: rejected as typeof fetch,
      now: failedAt,
    })).rejects.toMatchObject({ code: "BILLING_PROVIDER_API_AUTH_INVALID", status: 502 });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(rejected.mock.calls[0]?.[1]?.body))).toEqual({ subscription_ids: ["sub_portal1"] });

    const issue = testEnv.sqliteDb.prepare(
      `SELECT id, capability, issue_code, status, occurrence_count, updated_at
       FROM system_issues WHERE account_id = ? AND billing_provider_id = ?`,
    ).get(accountId, providerId) as any;
    expect(issue).toMatchObject({
      capability: "customer_portal_session",
      issue_code: "BILLING_PROVIDER_API_AUTH_INVALID",
      status: "open",
      occurrence_count: 1,
    });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM system_issue_inbound_events").get())
      .toEqual({ count: 0 });
    expect(testEnv.sqliteDb.prepare("SELECT count(*) AS count FROM inbound_events").get())
      .toEqual({ count: 0 });

    const forbiddenRetryProbe = vi.fn();
    await expect(resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: issue.id,
      userId: "usr_portal_fix",
      resolutionNote: "Portal permission restored.",
      retryAffectedEvents: true,
      expectedUpdatedAt: issue.updated_at,
      fetchImpl: forbiddenRetryProbe as typeof fetch,
      now: new Date(failedAt.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "SYSTEM_ISSUE_RETRY_NOT_APPLICABLE", status: 409 });
    expect(forbiddenRetryProbe).not.toHaveBeenCalled();

    const verification = vi.fn(async () => new Response(JSON.stringify({
      data: {
        urls: { general: { overview: "https://sandbox-customer-portal.paddle.com/session/test" } },
        expires_at: "2026-09-19T08:15:00.000Z",
      },
      meta: { request_id: "req_portal_verified" },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_portal_verified" },
    }));
    const resolved = await resolveSystemIssue({
      db: testEnv.d1,
      env: testEnv.env,
      accountId,
      issueId: issue.id,
      userId: "usr_portal_fix",
      resolutionNote: "Portal permission restored.",
      retryAffectedEvents: false,
      expectedUpdatedAt: issue.updated_at,
      fetchImpl: verification as typeof fetch,
      now: new Date(failedAt.getTime() + 2_000),
    });
    expect(verification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(verification.mock.calls[0]?.[1]?.body))).toEqual({ subscription_ids: ["sub_portal1"] });
    expect(resolved).toMatchObject({
      id: issue.id,
      status: "resolved",
      retryAffectedEvents: false,
      retriedEventCount: 0,
      skippedAffectedEventCount: 0,
    });
  });
});
