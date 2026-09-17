# LicenKit Backend Architecture & Core System Design Specification

> **Technology Stack**: TypeScript + Hono + Drizzle ORM + Cloudflare Workers + Cloudflare D1 (SQLite) + Cloudflare KV + Cloudflare Queues  
> **Positioning**: A modern API-First licensing hub. Offers an open-source self-hostable version (LicenKit) with out-of-the-box initial setup and multi-user administration, architecturally structured for zero-code-change adoption into enterprise commercial SaaS (`LicenKit-Cloud`).

---

## 1. System Architecture & Domain Layering (LicenKit vs LicenKit-Cloud)

```mermaid
graph TD
    subgraph "LicenKit-Cloud (Commercial SaaS Platform)"
        CloudSaaS["Cloud SaaS Control Plane (Exclusive tables: cloud_subscriptions, cloud_quotas)<br/>• Public developer self-service registration<br/>• Stripe tenant tier subscription & metering<br/>• Multi-tenant routing gateway"]
    end

    subgraph "LicenKit (Self-Hosted Open Source Core)"
        SysConfig["Global Instance Settings (system_settings table)<br/>• Singleton id='current' / instance_name / app_url / api_base_url / allow_signup"]
        TenantRoot["Tenant Workspace (accounts table)<br/>• Asset boundary / Route slug / CNAME custom_domain / Payment gateway secrets"]
        UserDomain["User Identity Domain (users table)<br/>• Login email / Salted password hash / Role (owner/admin/member)<br/>• Multi-member team RBAC"]
        LicBiz["Core Licensing Domain<br/>• products, policies, licenses, machines, crypto_keys, trials, webhooks"]
    end

    CloudSaaS -->|"Directly imports and runs"| LicenKit
    SysConfig -.->|"Instance base configuration"| TenantRoot
    TenantRoot --> UserDomain
    TenantRoot --> LicBiz
```

### 1. Conceptual Decoupling: System vs Tenant vs User
- **`system_settings` Table (System Instance Configuration - Singleton `id = 'current'`)**:
  - Encapsulates self-hosted instance runtime parameters: `instance_name`, `app_url` (frontend dashboard URL), `api_base_url` (backend API URL), and `allow_signup` (public registration toggle);
  - **Dynamic Base URLs and Single-Domain Defaults**:
    - **Default Mode (Same-Origin Deployment, 90% use cases)**: When `api_base_url` is NULL or empty, it automatically inherits `app_url`. API routes mount under **`${app_url}/api/v1/*`**, and the SPA is served at root `/*`. This guarantees zero CORS friction;
    - **Separated Deployment Mode (10% use cases)**: When deploying frontend (e.g. Vercel) and backend (Cloudflare Workers) across different domains, explicitly configuring `api_base_url` mounts the API under **`${api_base_url}/api/v1/*`**, and the Worker automatically whitelists `app_url` in CORS preflight responses;
  - **Decoupled Notifications**: Zero raw SMTP or heavy email dependencies. All fulfillment notifications are pushed into asynchronous queues and broadcast via outbound webhooks (`/api/v1/admin/webhooks`) for external execution (e.g. Resend / Zapier);
- **`accounts` Table (Tenant / Team Workspace)**:
  - Root owner of software assets: products, policies, licenses, machines, crypto keys, and outbound webhooks;
  - Supports white-label `custom_domain` routing;
  - Holds encrypted payment gateway configurations (`payment_configs`, AES-256-GCM ciphertext);
- **`users` Table (Natural Person Administrators)**:
  - Login identities for the management console, tied to an `account_id`;
  - Stores `email`, salted `password_hash`, and `role` (`owner`, `admin`, `member`).

---

### 2. Storage Facade Design (`getTenantDB`)

```mermaid
graph TD
    subgraph "Ingress Layer (Hono Middleware)"
        Req[Incoming Request] --> MW{Route & Auth Matcher}
    end

    subgraph "Context Injection"
        MW -- "Setup/Login: /system/*, /auth/*" --> PublicMW[Public / Password Check]
        MW -- "Admin API: Bearer <session_token>" --> AuthMW[Verify Admin JWT Session]
        MW -- "Inbound Payment: /webhooks/:provider/:account_id" --> PathMW[Extract account_id from path]
        MW -- "Client API: /client/*" --> ClientMW[Extract account_id from body]
        
        AuthMW --> Ctx["Inject c.set('accountId', user.accountId)"]
        PathMW --> Ctx
        ClientMW --> Ctx
    end

    subgraph "Storage Facade (D1 Routing Abstraction)"
        Ctx --> Router["getTenantDB(c, accountId)"]
        Router --> DB[(D1 Database: licenkit_db)]
    end
```

- **LicenKit (Self-Hosted)**: `getTenantDB(c, accountId)` returns `c.env.DB` directly for zero-overhead single-database operations;
- **LicenKit-Cloud (Commercial SaaS)**: `getTenantDB` routes queries dynamically to dedicated or partitioned D1 database bindings without touching business logic.

---

### 3. Envelope Encryption & Zero Plaintext Persistence

```mermaid
graph LR
    subgraph "Worker Environment Secrets"
        KEK["STORAGE_ENCRYPTION_KEY<br/>(32-Byte Master AES Key)"]
    end

    subgraph "D1 Encrypted Storage (Persistence)"
        DB1["crypto_keys.key_material<br/>(Ed25519 Private Key Seed - AES-GCM Ciphertext)"]
        DB2["accounts.payment_configs<br/>(Gateway Secrets JSON - AES-GCM Ciphertext)"]
    end

    subgraph "Worker Runtime Memory"
        KEK --> Decrypt["WebCrypto AES-256-GCM Decryption"]
        DB1 --> Decrypt
        DB2 --> Decrypt
        Decrypt --> Mem["In-Memory Execution (Sign Token / Verify Webhook)<br/>Immediately cleared via Garbage Collection"]
    end
```

- **Envelope Encryption**: Gateway secrets and Ed25519 private key seeds are strictly encrypted with `STORAGE_ENCRYPTION_KEY` using **AES-256-GCM** before write;
- **Zero Plaintext Persistence**: Database leaks expose zero usable private keys or gateway signing secrets;
- **Security Rule**: Storing private keys (plaintext or ciphertext) in global distributed KV edge caches is strictly prohibited.

---

## 2. Monorepo Codebase Organization

LicenKit uses a decoupled **Monorepo** structure separating the core licensing engine from the web admin dashboard:

```text
licenkit/
├── apps/
│   ├── server/                  # [LicenKit Server] Licensing Core Engine (Cloudflare Worker)
│   │   ├── src/
│   │   │   ├── index.ts         # Worker entrypoint (Hono app & Queue Consumer)
│   │   │   ├── types.ts         # Global runtime bindings (DB, KEYS_KV, EVENT_QUEUE, Secrets)
│   │   │   ├── domains/         # Core business domains
│   │   │   │   ├── system/      # System settings & Setup wizard
│   │   │   │   ├── auth/        # User authentication & RBAC
│   │   │   │   ├── account/     # Tenant accounts & custom domain
│   │   │   │   ├── policy/      # Licensing policies & duration rules
│   │   │   │   ├── licensing/   # Licenses, machines, and trial tracking
│   │   │   │   └── webhook/     # Inbound & outbound webhook processing
│   │   │   ├── queue/           # Outbound queue consumer & exponential retry
│   │   │   ├── infra/           # WebCrypto cryptography, KV caching, D1 facade
│   │   │   ├── middleware/      # SetupGuard, SessionAuth, ErrorHandler
│   │   │   └── routes/          # API routes (/api/v1/*)
│   │   ├── wrangler.jsonc       # Worker configuration
│   │   └── package.json
│   │
│   └── web/                     # [LicenKit-Web] Admin Console SPA (React 19 / Tailwind v4)
│       ├── src/
│       │   ├── pages/           # /setup, /login, /dashboard...
│       │   ├── components/      # UI components and modals
│       │   └── lib/api-client.ts# Standard API client with dynamic base URL support
│       ├── vite.config.ts       # Build configuration
│       └── package.json
```

- **Single-Deployment Packaging**: Running `pnpm build && wrangler deploy` compiles the web SPA into `apps/web/dist` and mounts it directly as Worker Static Assets.
- **Independent Customization**: Developers can fork `apps/web` and configure `VITE_API_BASE_URL` to integrate with existing internal portals.

---

## 3. Core Business Sequence Diagrams

### 1. Initial Setup Wizard Flow

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Administrator
    participant Route as routes/system.routes.ts
    participant SysSvc as SystemService
    participant D1 as c.env.DB

    Admin->>Route: GET /api/v1/system/status
    Route->>SysSvc: getStatus()
    SysSvc->>D1: SELECT id, instance_name, app_url, api_base_url FROM system_settings WHERE id = 'current'
    SysSvc-->>Route: Return { initialized: false }
    Route-->>Admin: Show /setup Wizard

    Admin->>Route: POST /api/v1/system/setup { instance_name, app_url, api_base_url, account_name, slug, admin_name, admin_email, admin_password }
    Route->>SysSvc: setupInstance(input)
    SysSvc->>D1: Check if system_settings already exists (concurrency lock)
    alt Already initialized
        SysSvc-->>Route: Throw InstanceAlreadyInitialized error
        Route-->>Admin: 403 Forbidden
    else Confirmed uninitialized
        SysSvc->>SysSvc: Generate tenant ULID (acc_...)
        SysSvc->>SysSvc: Compute WebCrypto PBKDF2 hash for password
        SysSvc->>SysSvc: Generate user ULID (usr_...)
        
        Note over SysSvc,D1: [Atomic Batch Transaction]: Create SystemSettings, Account, and Owner User
        SysSvc->>D1: db.batch([insertSystemSettings, insertAccount, insertUser(role='owner')])
        
        SysSvc->>SysSvc: Issue Session JWT containing userId & accountId
        SysSvc-->>Route: Return initialization payload
        Route-->>Admin: 201 Created + session_token
    end
```

---

### 2. Inbound Payment Webhook Fulfillment & Outbound Queue Broadcast

```mermaid
sequenceDiagram
    autonumber
    actor Gateway as Payment Gateway (Stripe/Paddle)
    participant Route as routes/webhook.routes.ts
    participant Inbound as InboundWebhookService
    participant D1 as getTenantDB(c, accountId)
    participant Queue as EVENT_QUEUE
    participant Consumer as EventConsumer
    actor TenantEndpoint as Receiving Endpoint (Developer Server / Zapier)

    Gateway->>Route: POST /api/v1/webhooks/stripe/acc_01J8X9... (with Stripe-Signature)
    Route->>Inbound: handleWebhook('stripe', 'acc_01J8X9...', header, rawPayload)
    
    Inbound->>D1: Query accounts WHERE id = 'acc_01J8X9...'
    Inbound->>Inbound: Decrypt payment_configs via AES-256-GCM to get webhook_secret
    Inbound->>Inbound: Constant-time signature verification

    Inbound->>D1: SELECT status FROM webhook_events WHERE account_id = ? AND provider = 'stripe' AND event_id = ? AND direction = 'inbound'
    alt Event exists and status == 'processed'
        Note over Route,Gateway: Duplicate delivery: return 200 OK immediately
        Route-->>Gateway: 200 OK
    else New event
        Note over Inbound,D1: [Atomic Batch Transaction]: Issue License & record event
        Inbound->>D1: db.batch([insertInboundEvent, insertLicense(account_id, ...), markEventProcessed])
        
        alt Transaction succeeds
            Note over Inbound,D1: Match subscribed endpoints, insert outbound event rows
            Inbound->>D1: Insert N outbound webhook_events (direction='outbound', status='pending')
            Inbound->>Queue: Push delivery tasks to EVENT_QUEUE
            Route-->>Gateway: 200 OK
            
            Queue->>Consumer: Dispatch broadcast task
            Consumer->>TenantEndpoint: POST endpoint URL (with X-LicenKit-Signature)
            TenantEndpoint-->>Consumer: 200 OK (update event status to processed)
        else Transaction fails
            Inbound->>D1: UPDATE webhook_events SET status = 'failed'
            Route-->>Gateway: 500 Internal Server Error (triggers gateway backoff retry)
        end
    end
```

---

### 3. Client Machine Hardware Activation & Seat Preemption

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client App
    participant Route as routes/client.routes.ts
    participant MacService as MachineService
    participant LicService as LicenseService
    participant D1 as getTenantDB(c, accountId)

    Client->>Route: POST /api/v1/client/activate { account_id, license_key, fingerprint, platform, name }
    Route->>MacService: activate(account_id, license_key, fingerprint, ...)
    
    MacService->>D1: Query License and applied Policy (max_machines, scheme, offline_grace_period)
    
    alt License is inactive, expired, or revoked
        MacService-->>Route: Throw LicenseInactive error
        Route-->>Client: 403 Forbidden
    end

    alt Machine fingerprint already bound to this license
        MacService-->>LicService: Return existing authorization
    else Acquire new seat
        Note over MacService,D1: [Atomic Conditional Insert]: Check seat limit & bind machine
        MacService->>D1: INSERT INTO machines (...) SELECT ..., 'mac_xxx' WHERE (SELECT COUNT(*) FROM machines WHERE license_id = ?) < policy.max_machines
        alt rows_affected == 0 (Seat limit reached)
            MacService-->>Route: Throw SeatLimitExceeded error
            Route-->>Client: 409 Conflict: SEAT_LIMIT_EXCEEDED
        end
    end

    alt policy.scheme == 'ed25519' (Offline Signed Token Mode)
        MacService->>LicService: signToken(license, fingerprint, policy.offline_grace_period)
        LicService->>D1: Fetch active Ed25519 private key ciphertext
        LicService->>LicService: In-memory WebCrypto AES-256-GCM private key decryption
        LicService->>LicService: In-memory sign Ed25519 Token with offline grace period exp
        LicService-->>Client: 200 OK + { scheme: "ed25519", token: "header.claims.sig", token_expires_at, ... }
    else policy.scheme == 'guid' (Online Validation Mode)
        LicService-->>Client: 200 OK + { scheme: "guid", valid: true, license_expires_at, ... }
    end
```
