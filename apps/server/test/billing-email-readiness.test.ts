import { beforeEach, describe, expect, it } from "vitest";
import { EMAIL_NOTIFICATION_CONTRACTS } from "../src/domain/email/contracts";
import { encryptEnvelopeV1 } from "../src/infra/delivery/crypto";
import { evaluateBillingOfferReadiness, type BillingOfferReadinessRow } from "../src/services/billing/readiness";
import { createTestEnv, type TestEnvContext } from "./helpers/mock-d1";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const INSTANCE_ID = "acc_billing_email_readiness";
const INTEGRATION_ID = "emi_billing_email_readiness";
const LICENSE_ISSUED = EMAIL_NOTIFICATION_CONTRACTS.find((contract) => contract.notificationType === "customer.sandbox_license_issued")!;
const LIVE_LICENSE_ISSUED = EMAIL_NOTIFICATION_CONTRACTS.find((contract) => contract.notificationType === "customer.license_issued")!;
const OTHER_CONTRACTS = EMAIL_NOTIFICATION_CONTRACTS.filter((contract) => !["customer.license_issued", "customer.sandbox_license_issued"].includes(contract.notificationType));

const OFFER_ROW: BillingOfferReadinessRow = {
  id: "off_billing_email_readiness",
  instance_id: INSTANCE_ID,
  external_price_id: "pri_billingemailreadiness",
  product_id: "prd_00000000000000000000000001",
  license_plan_id: "pln_billing_email_readiness",
  purchase_type: "one_time",
  offer_status: "draft",
  product_status: "active",
  license_model: "perpetual",
  credential_mode: "opaque",
  plan_status: "active",
  provider_id: "bpr_billing_email_readiness",
  provider_status: "active",
  provider_environment: "sandbox",
  client_side_token: "test_billing_email_readiness",
  webhook_secret_ciphertext: "encrypted_webhook_secret",
};

describe("Billing Email Delivery Readiness", () => {
  let testEnv: TestEnvContext;

  beforeEach(() => {
    testEnv = createTestEnv();
    testEnv.sqliteDb.prepare(
      `INSERT INTO instances (id, name, site_url, admin_api_url, status, created_at, updated_at)
       VALUES (?, 'Billing Email', 'https://site.example.test', 'https://license.example.test', 'active', ?, ?)`,
    ).run(INSTANCE_ID, NOW.toISOString(), NOW.toISOString());
  });

  async function seedIntegration() {
    const ciphertext = await encryptEnvelopeV1(
      JSON.stringify({ version: 1, apiKey: "re_billing_email_readiness" }),
      testEnv.env,
      { instanceId: INSTANCE_ID, table: "email_integrations", rowId: INTEGRATION_ID, field: "credential_ciphertext" },
    );
    testEnv.sqliteDb.prepare(
      `INSERT INTO email_integrations (
         id, instance_id, provider, name, credential_ciphertext,
         default_from_email, max_automatic_attempts, status, created_at, updated_at
       ) VALUES (?, ?, 'resend', 'Primary', ?, 'licenses@example.test', 4, 'active', ?, ?)`,
    ).run(INTEGRATION_ID, INSTANCE_ID, ciphertext, NOW.toISOString(), NOW.toISOString());
  }

  function seedBindings(contracts: readonly { notificationType: string; version: number }[]) {
    for (const [index, contract] of contracts.entries()) {
      testEnv.sqliteDb.prepare(
        `INSERT INTO email_template_bindings (
           id, instance_id, email_integration_id, notification_type,
           contract_version, provider_template_ref, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(`etb_${contract.notificationType}`, INSTANCE_ID, INTEGRATION_ID, contract.notificationType, contract.version, `template-${index}`, NOW.toISOString(), NOW.toISOString());
    }
  }

  async function evaluate() {
    return evaluateBillingOfferReadiness(testEnv.d1, OFFER_ROW, { env: testEnv.env, activation: true, now: NOW });
  }

  function check(result: Awaited<ReturnType<typeof evaluate>>, key: string) {
    return result.checks.find((item) => item.key === key)!;
  }

  it("requires an active Integration, decryptable credential, and license-issued Binding", async () => {
    const empty = await evaluate();
    expect(check(empty, "email_integration").status).toBe("not_ready");
    await seedIntegration();
    const noBinding = await evaluate();
    expect(check(noBinding, "email_provider_credential").status).toBe("ready");
    expect(check(noBinding, "email_template_bindings")).toMatchObject({ status: "not_ready", details: { requiredCount: 1, activeCount: 0 } });
    seedBindings([LICENSE_ISSUED]);
    const ready = await evaluate();
    expect(check(ready, "email_template_bindings")).toMatchObject({ status: "ready", details: { requiredCount: 1, activeCount: 1 } });
  });

  it("does not require persisted configuration-test evidence", async () => {
    await seedIntegration();
    seedBindings([LICENSE_ISSUED]);
    const result = await evaluate();
    expect(result.checks.map((item) => item.key)).not.toContain("email_template_tests");
    expect(result.checks.map((item) => item.key)).not.toContain("email_system_issues");
    expect(result.checks.map((item) => item.key)).not.toContain("scheduled_worker_health");
    expect(check(result, "email_template_bindings").status).toBe("ready");
  });

  it("does not send Sandbox purchases through the Live license email template", async () => {
    await seedIntegration();
    seedBindings([LIVE_LICENSE_ISSUED]);
    expect(check(await evaluate(), "email_template_bindings")).toMatchObject({
      status: "not_ready",
      details: { requiredCount: 1, activeCount: 0 },
    });
  });

  it("allows each environment to activate before its first real purchase test", async () => {
    await seedIntegration();
    seedBindings([LICENSE_ISSUED]);
    const sandbox = await evaluate();
    expect(sandbox.ready).toBe(true);
    expect(sandbox.checks.map((item) => item.key)).not.toContain("sandbox_end_to_end_verification");
    expect(sandbox.checks.map((item) => item.key)).not.toContain("webhook_event_contract");

    seedBindings([LIVE_LICENSE_ISSUED]);
    const live = await evaluateBillingOfferReadiness(testEnv.d1, {
      ...OFFER_ROW,
      provider_environment: "live",
      client_side_token: "live_billing_email_readiness",
    }, { env: testEnv.env, activation: true, now: NOW });
    expect(live.ready).toBe(true);
  });

  it("does not let unrelated email Bindings replace the purchase email Binding", async () => {
    await seedIntegration();
    seedBindings(OTHER_CONTRACTS);
    expect(check(await evaluate(), "email_template_bindings")).toMatchObject({ status: "not_ready", details: { activeCount: 0 } });
  });

  it("reports an unreadable credential independently from Binding availability", async () => {
    await seedIntegration();
    seedBindings([LICENSE_ISSUED]);
    testEnv.sqliteDb.prepare("UPDATE email_integrations SET credential_ciphertext = 'invalid' WHERE id = ?").run(INTEGRATION_ID);
    const result = await evaluate();
    expect(check(result, "email_provider_credential").status).toBe("not_ready");
    expect(check(result, "email_template_bindings").status).toBe("ready");
  });
});
