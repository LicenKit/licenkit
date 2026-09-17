# LicenKit RESTful API Specification

> **Target Infrastructure**: Cloudflare Workers + D1 (`DB`) + KV (`KEYS_KV`) + Queues (`EVENT_QUEUE`)  
> **Positioning**: A modern API-First licensing hub. Provides an open-source self-hostable version (LicenKit) with out-of-the-box initial setup and multi-user administration, architecturally prepared for zero-friction enterprise SaaS (`LicenKit-Cloud`) adoption.

---

## 1. Overview & General Conventions

### 1. Technical Standards
- **Base Path**: `/api/v1`
- **Content Type**: `application/json; charset=utf-8`
- **Date & Time Format**: Standard ISO 8601 / RFC 3339 UTC string (e.g. `2026-09-16T12:00:00Z`)
- **Entity ID Conventions**: Structured ULID / NanoID with semantic prefixes:
  - Tenant Workspace: `acc_...`
  - Admin User: `usr_...`
  - Software Product: `prd_...`
  - Licensing Policy: `pol_...`
  - License Credential: `lic_...`
  - Machine Device: `mac_...`
  - Key Version: `kid_...`
  - Webhook Endpoint: `whe_...`
  - Webhook Event: `evt_...`

### 2. Standard Outer Response Formats
```json
// 1. Single Entity Success (HTTP 200 / 201)
{
  "success": true,
  "data": { ... }
}

// 2. Paginated List Success (HTTP 200)
{
  "success": true,
  "data": {
    "items": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 142,
      "totalPages": 8,
      "hasNext": true
    }
  }
}

// 3. Error Response (HTTP 4xx / 5xx)
{
  "success": false,
  "error": {
    "code": "SEAT_LIMIT_EXCEEDED",
    "message": "Maximum machine seats reached for this license."
  }
}
```

---

## 2. Authentication & Authorization Matrix

| Namespace | Intended Caller | Auth Mechanism | Description |
| :--- | :--- | :--- | :--- |
| `/api/v1/system/*` | Deployer / Frontend Setup Wizard | Public (Guarded by State Machine) | Health check & initial setup (callable only before initialization) |
| `/api/v1/auth/*` | Human Administrators | Public / Session JWT | Admin email/password login and session validation |
| `/api/v1/client/*` | Client Software (Desktop/CLI) | `account_id` in Body + Hardware Fingerprint | No login required; scoped by explicit `account_id` |
| `/api/v1/admin/*` | Dashboard SPA & Automation Scripts | `Authorization: Bearer <session_token>` | Admin Session JWT issued via `/auth/login` |
| `/api/v1/webhooks/:provider/:account_id` | Payment Gateways | Inbound HMAC Signature Verification | Verified against decrypted gateway secret for that tenant |

---

## 3. System Status & Setup API (`/api/v1/system/*`)

### 1. Check System Initialization Status
- **Path**: `GET /api/v1/system/status`
- **Description**: Invoked on SPA initial load to determine whether to present the `/setup` wizard or the `/login` screen.
- **Response 200 (Uninitialized)**:
  ```json
  {
    "success": true,
    "data": {
      "initialized": false,
      "version": "1.0.0"
    }
  }
  ```
- **Response 200 (Initialized)**:
  ```json
  {
    "success": true,
    "data": {
      "initialized": true,
      "instance_name": "ScreenStudio Licensing Hub",
      "app_url": "https://license.screenstudio.com",
      "api_base_url": "https://license.screenstudio.com",
      "version": "1.0.0"
    }
  }
  ```

---

### 2. Initial Setup Wizard
- **Path**: `POST /api/v1/system/setup`
- **Description**: Callable only when `initialized == false`. Atomically creates `system_settings`, an initial `accounts` record, and the primary Owner `users` record, returning an initial admin session JWT.
- **Security Lock**: Once initialized, returns `403 INSTANCE_ALREADY_INITIALIZED` permanently.
- **Request Body**:
  ```json
  {
    "instance_name": "ScreenStudio Licensing Hub",
    "app_url": "https://license.screenstudio.com",
    "api_base_url": null,
    "account_name": "ScreenStudio LLC",
    "slug": "screenstudio",
    "admin_name": "Alex (Founder)",
    "admin_email": "alex@screenstudio.com",
    "admin_password": "StrongAdminPassword123!"
  }
  ```
- **Response 201**:
  ```json
  {
    "success": true,
    "data": {
      "message": "System initialized successfully!",
      "settings": {
        "instance_name": "ScreenStudio Licensing Hub",
        "app_url": "https://license.screenstudio.com",
        "api_base_url": "https://license.screenstudio.com"
      },
      "account": {
        "id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
        "name": "ScreenStudio LLC",
        "slug": "screenstudio",
        "custom_domain": "https://license.screenstudio.com",
        "is_active": true,
        "created_at": "2026-09-16T12:00:00Z"
      },
      "user": {
        "id": "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5",
        "name": "Alex (Founder)",
        "email": "alex@screenstudio.com",
        "role": "owner"
      },
      "session_token": "eyJhbGciOiJIUzI1NiIsIn..."
    }
  }
  ```

---

## 4. User Authentication API (`/api/v1/auth/*`)

### 1. Admin Login
- **Path**: `POST /api/v1/auth/login`
- **Request Body**:
  ```json
  {
    "email": "alex@screenstudio.com",
    "password": "StrongAdminPassword123!"
  }
  ```
- **Response 200**:
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5",
        "name": "Alex (Founder)",
        "email": "alex@screenstudio.com",
        "role": "owner"
      },
      "account": {
        "id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
        "name": "ScreenStudio LLC",
        "slug": "screenstudio"
      },
      "session_token": "eyJhbGciOiJIUzI1NiIsIn..."
    }
  }
  ```

### 2. Get Current Profile
- **Path**: `GET /api/v1/auth/me`
- **Auth**: `Authorization: Bearer <session_token>`
- **Response 200**: Returns user profile and tenant summary.

---

## 5. Client Application API (`/api/v1/client/*`)

### 1. Claim Anonymous Free Trial
- **Path**: `POST /api/v1/client/trial`
- **Description**: Silent trial claiming. Deduplicated via `product_trials` by machine fingerprint. Does not pollute the commercial `licenses` table.
- **Request Body**:
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "product_id": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **Response 200**:
  ```json
  {
    "success": true,
    "data": {
      "trial_claimed": true,
      "already_claimed": false,
      "expired": false,
      "claimed_at": "2026-09-17T10:00:00.000Z",
      "expires_at": "2026-10-01T10:00:00.000Z",
      "features": ["feature_a", "feature_b"]
    }
  }
  ```

---

### 2. Commercial License Activation & Seat Binding
- **Path**: `POST /api/v1/client/activate`
- **Description**: Binds client hardware fingerprint to a license seat. Returns signed offline token when using Ed25519 scheme.
- **Request Body**:
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d...",
    "platform": "darwin-arm64",
    "name": "Alex's MacBook Pro"
  }
  ```
- **Response 200**:
  ```json
  {
    "success": true,
    "data": {
      "activated": true,
      "reused": false,
      "machine_id": "mac_01j8x9n8k1l2m3n4p5q6r7s8t9",
      "scheme": "ed25519",
      "expires_at": "2027-09-17T10:00:00.000Z"
    }
  }
  ```

---

### 3. Online Validation & Heartbeat
- **Path**: `POST /api/v1/client/validate`
- **Description**: Validates license state and updates machine `lastHeartbeatAt`.
- **Request Body**:
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **Response 200**:
  ```json
  {
    "success": true,
    "data": {
      "valid": true,
      "expires_at": "2027-09-17T10:00:00.000Z",
      "last_heartbeat_at": "2026-09-17T10:00:00.000Z"
    }
  }
  ```

---

### 4. Client Machine Deactivation
- **Path**: `POST /api/v1/client/deactivate`
- **Description**: Releases the seat occupied by this machine.
- **Request Body**:
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **Response 200**:
  ```json
  {
    "success": true,
    "data": {
      "deactivated": true,
      "message": "Machine successfully unregistered from license"
    }
  }
  ```

---

## 6. Tenant Admin API (`/api/v1/admin/*`)

> **Auth Header**: `Authorization: Bearer <session_token>`  
> **Naming Convention**: All Admin API request bodies, queries, and JSON responses adhere strictly to **`camelCase`**.

### 1. Settings (`/api/v1/admin/settings`)
- **Get Settings**: `GET /api/v1/admin/settings` (Returns system settings and masked payment secrets).
- **Update Settings**: `PUT /api/v1/admin/settings`
  ```json
  {
    "instance_name": "ScreenStudio Licensing Hub",
    "app_url": "https://license.screenstudio.com",
    "payment_configs": {
      "paddle": {
        "enabled": true,
        "webhook_secret": "<your_paddle_webhook_secret>"
      }
    }
  }
  ```

---

### 2. Stats (`/api/v1/admin/stats`)
- **Get Overview Metrics**: `GET /api/v1/admin/stats`
  ```json
  {
    "success": true,
    "data": {
      "totalProducts": 3,
      "totalLicenses": 42,
      "activatedMachines": 18,
      "expiringSoon": 5
    }
  }
  ```

---

### 3. Products (`/api/v1/admin/products`)
- **List Products**: `GET /api/v1/admin/products`
- **Create Product**: `POST /api/v1/admin/products`
  - Supports `keyMode: "auto"` (platform generated) or `keyMode: "upload"` (custom private key).
  - Returns `privateKey` **only once** upon creation for download and backup.
  ```json
  {
    "name": "ScreenStudio Pro",
    "description": "Professional screen recorder for macOS",
    "trialDays": 14,
    "trialFeatures": ["feature_a", "feature_b"],
    "keyMode": "auto"
  }
  ```
- **Get Product Details**: `GET /api/v1/admin/products/:id`
- **Update Product**: `PATCH /api/v1/admin/products/:id`
- **Delete Product**: `DELETE /api/v1/admin/products/:id` (Returns `409 PRODUCT_IN_USE` if policies or licenses exist).

---

### 4. Policies (`/api/v1/admin/policies`)
- **Create Policy**: `POST /api/v1/admin/policies`
  ```json
  {
    "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    "name": "Professional Annual (3 Seats)",
    "duration": 31536000,
    "offlineGracePeriod": 2592000,
    "maxMachines": 3,
    "floating": false,
    "strict": true,
    "scheme": "ed25519",
    "features": ["feature_a", "feature_b"],
    "metadata": {
      "stripe_price_id": "price_1Ov4z2...",
      "paddle_price_id": "pri_01j8..."
    }
  }
  ```
- **List Policies**: `GET /api/v1/admin/policies?productId=prd_xxx`
- **Get Policy Details**: `GET /api/v1/admin/policies/:id`
- **Update Policy**: `PATCH /api/v1/admin/policies/:id`
- **Delete Policy**: `DELETE /api/v1/admin/policies/:id` (Returns `409 POLICY_IN_USE` if in use).

---

### 5. Licenses (`/api/v1/admin/licenses`)
- **Manually Issue License**: `POST /api/v1/admin/licenses`
  ```json
  {
    "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    "policyId": "pol_01j8x9n5u1v2w3x4y5z6a7b8c9",
    "customerEmail": "buyer@screenstudio.com",
    "key": "LIC-ABCD-1234-EFGH-5678",
    "expiresAt": null
  }
  ```
- **List Licenses (with Filtering & Pagination)**: `GET /api/v1/admin/licenses?query=...&status=active&page=1&limit=20`
- **Get License Details & Bound Devices**: `GET /api/v1/admin/licenses/:id`
- **Update License Expiry or Status**: `PATCH /api/v1/admin/licenses/:id`
- **Rotate Key**: `POST /api/v1/admin/licenses/:id/rotate-key` (Generates new key and resets all machine bindings)
- **Suspend License**: `POST /api/v1/admin/licenses/:id/suspend`
- **Reinstate License**: `POST /api/v1/admin/licenses/:id/reinstate`
- **Revoke License**: `POST /api/v1/admin/licenses/:id/revoke`
- **Force Unbind Machine**: `DELETE /api/v1/admin/licenses/:id/machines/:machineId`

---

### 6. Outbound Webhooks (`/api/v1/admin/webhooks`)
- **Register Webhook Endpoint**: `POST /api/v1/admin/webhooks`
  ```json
  {
    "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    "url": "https://api.mysite.com/licenkit-webhook",
    "events": ["*"]
  }
  ```
- **List Webhook Endpoints**: `GET /api/v1/admin/webhooks`
- **Delete Webhook Endpoint**: `DELETE /api/v1/admin/webhooks/:id`
- **Query Webhook Audit Log**: `GET /api/v1/admin/webhooks/events?limit=50`

---

## 7. Inbound Payment Gateways (`/api/v1/webhooks/:provider/:account_id`)

### Unified Route: `POST <api_base_url>/api/v1/webhooks/:provider/:account_id`
- **Supported Providers**: `paddle` (Default), `stripe`, `lemonsqueezy`, `custom`.
- **Paddle Billing (Default)**:
  - Header: `Paddle-Signature`
  - Events: `transaction.completed`, `transaction.updated`, `subscription.canceled`
- **Stripe**:
  - Header: `Stripe-Signature`
  - Events: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.deleted`
- **Processing Flow**:
  1. Verify signature in constant time against decrypted tenant secret;
  2. Perform strict 3D deduplication (`account_id`, `provider`, `event_id`);
  3. Execute atomic D1 batch transaction for license issuance or revocation;
  4. Push notification tasks to `EVENT_QUEUE` and respond with `200 OK`.

---

## 8. Outbound Event Broadcast Specification

### 1. Signature Format
```http
POST /webhooks/receiver HTTP/1.1
Host: api.mysite.com
Content-Type: application/json
X-LicenKit-Signature: t=1757923200,v1=9f8a2b3c4d5e6f7a8b9c...
```
- `t`: Unix millisecond timestamp;
- `v1`: `HMAC-SHA256("${t}.${raw_body}", endpoint.secret)`.

### 2. Payload Structure
```json
{
  "id": "evt_01J8X9N9F1G2H3I4J5K6L7M8N9",
  "account_id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
  "event": "license.created",
  "created_at": "2026-09-16T12:00:00Z",
  "data": {
    "license_id": "lic_01J8X9N6D1E2F3G4H5I6J7K8L9",
    "key": "SCR-8820-ABCD-9901",
    "scheme": "ed25519",
    "product_id": "prd_01J8X9N3A1B2C3D4E5F6G7H8J9",
    "policy_id": "pol_01J8X9N5U1V2W3X4Y5Z6A7B8C9",
    "customer_email": "buyer@example.com",
    "status": "active",
    "expires_at": "2027-09-16T12:00:00Z"
  }
}
```

---

## 9. Error Codes Reference

| Error Code | HTTP Status | Description |
| :--- | :--- | :--- |
| `INSTANCE_ALREADY_INITIALIZED` | 403 Forbidden | Setup wizard can only be run once |
| `INSTANCE_NOT_INITIALIZED` | 503 Service Unavailable | Instance must be initialized via /setup first |
| `EMAIL_ALREADY_EXISTS` | 409 Conflict | Email is already registered |
| `SLUG_ALREADY_EXISTS` | 409 Conflict | Dedicated slug is already taken |
| `INVALID_CREDENTIALS` | 401 Unauthorized | Incorrect email or password |
| `UNAUTHORIZED` | 401 Unauthorized | Missing or invalid Bearer token |
| `SEAT_LIMIT_EXCEEDED` | 409 Conflict | Maximum hardware seats reached |
| `TRIAL_ALREADY_CLAIMED` | 403 Forbidden | Machine already claimed trial for this product |
| `LICENSE_NOT_FOUND` | 404 Not Found | License key not found |
| `LICENSE_SUSPENDED` | 403 Forbidden | License is suspended |
| `LICENSE_EXPIRED` | 403 Forbidden | License has expired |
| `LICENSE_REVOKED` | 403 Forbidden | License was revoked |
| `PRODUCT_NOT_FOUND` | 404 Not Found | Product not found or belongs to another tenant |
| `POLICY_NOT_FOUND` | 404 Not Found | Policy not found |
| `MACHINE_NOT_FOUND` | 404 Not Found | Device not found or does not belong to license |
| `SIGNATURE_VERIFY_FAILED`| 400 Bad Request | Gateway signature verification failed |
| `INTERNAL_SERVER_ERROR`| 500 Internal Server Error | Internal server exception |
