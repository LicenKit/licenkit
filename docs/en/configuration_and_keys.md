# LicenKit Environment Variables, Secrets & Credential Configuration Guide

> **Target Architecture**: Cloudflare Workers + D1 (`DB`) + KV (`KEYS_KV`) + Queues (`EVENT_QUEUE`)  
> **Document Version**: v1.1.0  
> **Last Updated**: 2026-09-16  

---

## 1. Core Security & Design Principles

As an open-source, self-hostable license engine focusing on developer software commercialization (hardware fingerprint binding, offline Ed25519 digital signature issuance, and license verification), LicenKit adheres strictly to the following security standards:

1. **Principle of Least Privilege & Passive Fulfillment**:
   - LicenKit employs an **event-driven passive architecture**, acting strictly as a downstream fulfillment engine. When users complete checkout on merchant platforms (Stripe / Paddle / Lemon Squeezy), the gateway sends a Webhook notification to LicenKit.
   - The system **only verifies inbound authenticity**. Therefore, **storing high-privilege gateway API Keys (such as `sk_live_...` capable of fund transfers or refunds) is strictly forbidden and never needed**, reducing self-hosted financial risk to zero.

2. **Master Key Envelope Encryption & Zero Plaintext Persistence**:
   - Only a single 32-byte master encryption key (KEK: `STORAGE_ENCRYPTION_KEY`) needs to be injected into Cloudflare Workers.
   - All tenant-level inbound payment Webhook secrets and product asymmetric private key seeds are encrypted with **WebCrypto native AES-256-GCM** before persistence into Cloudflare D1.
   - The Worker decrypts credentials in-memory only during webhook validation or token issuance, after which memory is immediately garbage-collected. No plaintexts are ever exposed in distributed KV or logging streams.

---

## 2. Storage Security Classification & Cryptography Matrix

The following matrix defines the **storage location, cryptographic mechanism, key protection, and exposure policy** for all system credentials:

| Credential / Variable | Storage Location | Security State | Cryptographic Mechanism | Protection Key | Plaintext Exposure Policy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`STORAGE_ENCRYPTION_KEY`** | Cloudflare Secrets | **Cloud KMS Protected** | Cloudflare Platform KMS (Encrypted at Rest) | Cloudflare Managed | Injected only into isolated Worker runtime memory; **never** logged or stored in D1 |
| **`JWT_SECRET`** | Cloudflare Secrets | **Cloud KMS Protected** | Cloudflare Platform KMS (Encrypted at Rest) | Cloudflare Managed | In-memory only for admin session issuance and JWT validation |
| **Payment Gateway Webhook Secrets**<br>(`accounts.payment_configs`) | Cloudflare D1<br>Database table | 🔒 **Mandatory App Encryption** | **AES-256-GCM**<br>(12-byte random IV + Base64 ciphertext) | `STORAGE_ENCRYPTION_KEY`<br>(Platform Master Key) | **Zero Plaintext Persistence**: In-memory decryption only at signature check; masked in API responses (`••••••••abcd`) |
| **Product Ed25519 Private Key Seed**<br>(`crypto_keys.key_material`) | Cloudflare D1<br>Database table | 🔒 **Mandatory App Encryption** | **AES-256-GCM**<br>(12-byte random IV + Base64 ciphertext) | `STORAGE_ENCRYPTION_KEY`<br>(Platform Master Key) | **Zero Plaintext Persistence**: Seed never leaves Worker memory; discarded immediately after signing offline token |
| **Admin Password Hash**<br>(`users.password_hash`) | Cloudflare D1<br>Database table | 🔒 **Slow One-Way Hash**<br>(Irreversible) | **PBKDF2-HMAC-SHA256**<br>(100,000 iterations + 16B salt) | Keyless<br>(Rainbow table resistant) | **Irreversible**: Never stored in plaintext; cannot be decrypted; used solely for constant-time hash comparison |
| **Outbound Webhook Secret**<br>(`webhook_endpoints.secret`) | Cloudflare D1<br>Database table | **Plaintext Storage**<br>(Isolated in D1) | High-entropy random string | None | Displayed to tenant admin in dashboard to configure on external receivers for HMAC signature verification |
| **Product Ed25519 Public Key**<br>(`crypto_keys.public_key`) | Cloudflare D1<br>& KEYS_KV | **Public Plaintext** | Base64 string | None (Public) | Public by nature; embedded into client software or SDKs to verify offline signature |
| **General Env Vars & Config**<br>(`ENVIRONMENT`, `APP_VERSION`, `app_url`, etc.) | `wrangler.jsonc`<br>& D1 `system_settings` | **Public Plaintext** | Plaintext | None | Non-sensitive runtime metadata and URL endpoints |

---

## 3. Cloudflare Worker Runtime Configuration

Runtime settings are configured in [`apps/server/wrangler.jsonc`](../../apps/server/wrangler.jsonc).

### 1. Cloudflare Bindings

| Binding Name | Resource Type | Target ID / Key | Role & Responsibility |
| :--- | :--- | :--- | :--- |
| `DB` | Cloudflare D1 (SQLite) | `licenkit-db` | Multi-tenant core store: products, policies, licenses, machines, encrypted credentials |
| `KEYS_KV` | Cloudflare KV | `licenkit-kv-placeholder` | Edge read-only cache for active public keys and fast tenant index |
| `EVENT_QUEUE` | Cloudflare Queues | `licenkit-event-queue` | Asynchronous outbound broadcast queue with exponential retry |
| `ASSETS` | Cloudflare Workers Assets | `../web/dist` | Static asset serving for the React admin SPA dashboard |

### 2. General Variables (Vars - Non-Sensitive)

Defined in the `vars` object of `wrangler.jsonc`:

```jsonc
"vars": {
  "ENVIRONMENT": "development", // Runtime environment: development | production
  "APP_VERSION": "1.0.0"        // Application release version
}
```

### 3. Sensitive Runtime Secrets

Injected via Cloudflare Secret management. For local development, specify in `apps/server/.dev.vars`. For production, configure via Wrangler CLI:

| Secret Name | Format & Length | Local File | Production Command | Security Role |
| :--- | :--- | :--- | :--- | :--- |
| `STORAGE_ENCRYPTION_KEY` | 32-byte high-entropy string | `apps/server/.dev.vars` | `npx wrangler secret put STORAGE_ENCRYPTION_KEY` | **Platform Master Encryption Key (KEK)**<br>Protects all database-stored payment secrets and private Ed25519 key seeds |
| `JWT_SECRET` | 32-byte high-entropy string | `apps/server/.dev.vars` | `npx wrangler secret put JWT_SECRET` | **Admin Session Signing Key**<br>Signs and verifies dashboard session JWTs (HMAC-SHA256) |

```bash
# Example: Generate high-entropy secrets and set via Cloudflare CLI
openssl rand -hex 16 | npx wrangler secret put STORAGE_ENCRYPTION_KEY
openssl rand -hex 16 | npx wrangler secret put JWT_SECRET
```

---

## 4. Multi-Tenant Inbound Payment Gateway Credentials

Inbound payment configurations are managed by tenants in the dashboard and stored in D1 at `accounts.payment_configs` (the JSON string is encrypted end-to-end with AES-256-GCM using `STORAGE_ENCRYPTION_KEY`).

### 1. In-Memory Data Model

```typescript
export interface PaymentConfigs {
  paddle?: {
    enabled: boolean;
    webhook_secret: string; // Paddle Notification Secret Key
  };
  stripe?: {
    enabled: boolean;
    webhook_secret: string; // Stripe Webhook Signing Secret
  };
  lemonsqueezy?: {
    enabled: boolean;
    webhook_secret: string; // Lemon Squeezy Signing Secret
  };
}
```

### 2. Provider Mapping Table

| Payment Provider | Required Secret | Provider Dashboard Location | Request Header | Verification Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Stripe** | `webhook_secret`<br>(Stripe Signing secret) | **Developers** -> **Webhooks** -> Select Endpoint -> **Signing secret** | `Stripe-Signature` | HMAC-SHA256 timestamp and payload verification |
| **Paddle Billing** | `webhook_secret`<br>(Paddle Secret Key) | **Notifications** -> **Notification Settings** -> **Secret Key** | `Paddle-Signature` | HMAC-SHA256 timestamp and hash verification |
| **Lemon Squeezy** | `webhook_secret` | **Settings** -> **Webhooks** -> Create Endpoint -> **Signing Secret** | `X-Signature` | HMAC-SHA256 hash comparison |

### 3. API Response Masking & Security

- **Retrieve Settings (`GET /api/v1/admin/settings`)**:
  Decrypted on server but returned **masked**:
  ```json
  {
    "payment_configs": {
      "paddle": { "enabled": true, "webhook_secret_masked": "••••••••9b2a" },
      "stripe": { "enabled": true, "webhook_secret_masked": "••••••••5f1c" },
      "lemonsqueezy": { "enabled": false, "webhook_secret_masked": "" }
    }
  }
  ```
- **Update Settings (`PUT /api/v1/admin/settings`)**:
  Provide only updated fields; backend merges changes with existing configuration:
  ```json
  {
    "payment_configs": {
      "stripe": {
        "enabled": true,
        "webhook_secret": "<your_stripe_webhook_signing_secret>"
      }
    }
  }
  ```

---

## 5. Core Asymmetric Cryptographic Keys (Ed25519)

Core asymmetric key pairs for offline validation and hardware seat binding are managed in the `crypto_keys` table.

| Field | Format | Classification | Description |
| :--- | :--- | :--- | :--- |
| `publicKey` | Base64 string | **Public** | 32-byte Ed25519 public key. Embedded into client apps/SDKs to verify offline license tokens. |
| `keyMaterial` | AES-256-GCM ciphertext | **Secret** | 32-byte Ed25519 private key seed. Encrypted with `STORAGE_ENCRYPTION_KEY` before write; decrypted only when signing offline tokens. |

---

## 6. Outbound Broadcast Webhook Keys

Configured in `webhook_endpoints` to broadcast business events to developer servers, Resend, or Zapier.

| Field | Format | Description |
| :--- | :--- | :--- |
| `url` | Plaintext HTTPS URL | Destination endpoint URL receiving event broadcasts |
| `secret` | High-entropy random string | Shared secret for HMAC-SHA256 signatures (`X-LicenKit-Signature`) on HTTP POST delivery |

---

## 7. Deployment Configuration Checklist

Before deploying or migrating an instance, verify:

- [ ] **Cloudflare Secrets**
  - [ ] `STORAGE_ENCRYPTION_KEY` set (`npx wrangler secret put STORAGE_ENCRYPTION_KEY`)
  - [ ] `JWT_SECRET` set (`npx wrangler secret put JWT_SECRET`)
- [ ] **Cloudflare Resource Bindings**
  - [ ] `DB` (D1) bound and migrations applied (`npm run db:migrate:remote`)
  - [ ] `EVENT_QUEUE` (Queues) producer and consumer configured
  - [ ] `KEYS_KV` bound
- [ ] **Inbound Payment Webhooks (As Needed)**
  - [ ] Stripe: Signing Secret configured
  - [ ] Paddle: Notification Secret Key configured
  - [ ] Lemon Squeezy: Signing Secret configured
- [ ] **Outbound Event Notifications**
  - [ ] External webhook endpoint registered to receive events (e.g. `license.created`) for email notifications.
