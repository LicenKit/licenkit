import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { computeHmacSha256, sha256Hex } from "../src/infra/crypto";
import { encryptBillingProviderSecret, encryptInboundPayload } from "../src/infra/billing/storage";
import { processBillingInboundEvent, processDueBillingInboundEvents } from "../src/services/billing/fulfillment";
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

describe("V1 Paddle billing and public Checkout contracts", () => {
  let testEnv: TestEnvContext;

  beforeEach(async () => {
    testEnv = createTestEnv({ ENVIRONMENT: "test", STORAGE_ENCRYPTION_KEY_ID: "test-primary" });
    addFirstToMockD1(testEnv.d1);
    testEnv.env.DB = testEnv.d1;
    const db = testEnv.sqliteDb;
    db.prepare(
      `INSERT INTO system_settings (id, instance_name, app_url, initialized_at, updated_at)
       VALUES ('current', 'LicenKit', 'https://licenses.example.test', ?, ?)`,
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
    const rows = testEnv.sqliteDb.prepare(
      "SELECT payload_ciphertext, payload_hash FROM inbound_events WHERE external_event_id = ?",
    ).all("evt_customer_signature") as Array<{ payload_ciphertext: string; payload_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_ciphertext).not.toContain("signed@example.test");
    expect(rows[0].payload_hash).toBe(await sha256Hex(payload));
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

  it("keeps public checkout fail-closed without complete readiness evidence", async () => {
    const response = await app.request(
      "/api/v1/public/accounts/billing-v1/products/one/checkout",
      { method: "GET" },
      testEnv.env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).not.toHaveProperty("found");
    expect(body.data.checkout.available).toBe(false);
    expect(body.data.checkout).not.toHaveProperty("clientSideToken");
    expect(body.data.offers).toEqual([]);
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
});
