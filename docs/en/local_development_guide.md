# LicenKit Local Development & Debugging Guide

> This guide walks you through setting up, running, and debugging the full **LicenKit** (open-source self-hosted edition) Monorepo stack locally at zero infrastructure cost.  
> The underlying stack is powered by **TypeScript + Hono + Cloudflare Workers (Local Miniflare/workerd) + D1 (SQLite) + Cloudflare Queues + React 19 + Vite**.

---

## 1. Prerequisites & Environment Setup

Before getting started, make sure the following foundational tools are installed locally:

| Dependency | Recommended Version | Verification Command | Description |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 20.x` (Recommended `22.x` / `24.x`) | `node -v` | Supports native WebCrypto and modern ECMAScript standards |
| **pnpm** | `>= 9.x` / `10.x` | `pnpm -v` | Fast Monorepo package manager |
| **Git** | Latest stable | `git --version` | Version control & workflow commits |
| **Cloudflare Wrangler** | `>= 3.100` / `4.x` | `npx wrangler --version` | Emulates D1/KV/Queues locally with Miniflare |

### Clone & Install Dependencies
Run the following from the project root:

```bash
# Install dependencies across root, apps/server, and apps/web workspaces
pnpm install
```

---

## 2. Environment Variables & Local Secrets

LicenKit adheres strictly to the principle of **Envelope Encryption and Zero Plaintext Persistence**. Before running locally, configure runtime secrets for the backend Worker.

### 1. Configure `apps/server/.dev.vars`
Create `.dev.vars` inside `apps/server/` (this file is excluded by `.gitignore` and automatically loaded by Wrangler in local mode):

```bash
cat << 'EOF' > apps/server/.dev.vars
# Platform 32-byte master encryption key (used for AES-256-GCM envelope encryption of gateway secrets & product Ed25519 private key seeds)
STORAGE_ENCRYPTION_KEY=licenkit_dev_master_storage_key_32b_!

# Admin Session JWT signing secret
JWT_SECRET=licenkit_local_jwt_secret_development_only_123456

# Runtime flags
ENVIRONMENT=development
APP_VERSION=1.0.0
EOF
```

> [!NOTE]
> `STORAGE_ENCRYPTION_KEY` should be at least 32 characters in length (the system will normalize or derive a 32-byte key for AES-GCM).

### 2. Frontend Environment Configuration (`apps/web`)
In local development, Vite is pre-configured with a reverse proxy:
- Any API request starting with `/api` is automatically proxied to the backend Worker (`http://localhost:8787`).
- Therefore, **no `.env` file is required in `apps/web`** for local same-origin development.
- If you need to test cross-origin separated deployments, you can explicitly define in `apps/web/.env.local`:
  ```bash
  VITE_API_BASE_URL=http://localhost:8787
  ```

---

## 3. Local Database Initialization & Migration (Local D1)

LicenKit uses Wrangler's embedded SQLite engine to simulate Cloudflare D1 locally, requiring **no cloud account and zero network latency**.

### 1. Apply Drizzle Migrations to Local D1
Standard migrations for the 11 core tables are already pre-generated. Apply them locally with:

```bash
# Apply Drizzle migrations to local D1
pnpm --filter @licenkit/server run db:migrate:local
```

You should see output similar to:
```text
Applying migration 0000_sloppy_green_goblin.sql...
Migration applied successfully!
```

### 2. (Optional) Initialize Local D1 with Raw SQL
You can also execute `docs/schema.sql` directly:
```bash
npx --prefix apps/server wrangler d1 execute licenkit-db --local --file=../../docs/schema.sql
```

### 3. Inspect Local Database
To inspect tables or query data directly in local D1:
```bash
npx --prefix apps/server wrangler d1 execute licenkit-db --local --command="SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 4. Local Execution & Joint Debugging

### 1. Concurrent Full-Stack Development (Recommended)
Run from the root directory:

```bash
pnpm run dev
```

This concurrently starts:
1. **`@licenkit/web` (Vite SPA)**: Running at `http://localhost:5173` with instant HMR.
2. **`@licenkit/server` (Worker API)**: Running at `http://localhost:8787`, simulating D1, KV, and Queues runtimes.

---

### 2. Running Services Individually
- **Start Backend Worker API Only**:
  ```bash
  pnpm run dev:server
  # or
  pnpm --filter @licenkit/server run dev
  ```
- **Start Web Dashboard SPA Only**:
  ```bash
  pnpm run dev:web
  # or
  pnpm --filter @licenkit/web run dev
  ```

---

## 5. Initial Setup Wizard & E2E Flow

### Step 1: Open Initial Setup Page
Navigate to: **`http://localhost:5173`** in your browser.
1. The frontend checks `GET /api/v1/system/status` and detects `{ initialized: false }`.
2. The UI renders the **SetupPage** wizard:
   - **Instance Name**: e.g., `Local LicenKit Hub`
   - **App URL**: Keep default `http://localhost:5173`
   - **API Base URL**: **Leave empty** (verifies the default single-domain same-origin `/api/v1/*` zero-CORS mode)
   - **Team / Org Name**: e.g., `DevStudio LLC`
   - **Slug**: e.g., `devstudio`
   - **Admin Name / Email / Password**: Admin credentials (password at least 8 characters)
3. Click **Complete Setup & Launch Dashboard**.
4. The Worker executes an **atomic batch transaction**:
   - Inserts `system_settings` singleton;
   - Inserts `accounts` tenant root;
   - Computes salted PBKDF2 password hash and inserts the `users` Owner record;
   - Issues a 7-day Session JWT and logs in automatically.

### Step 2: Explore the Admin Dashboard
Upon completion, the dashboard opens with:
1. **Overview**: View metrics on products, active licenses, and Ed25519 signing engine status.
2. **Gateways & Webhooks**:
   - Toggle between **Paddle (Default)** and **Stripe** tabs.
   - Inspect the tenant-specific webhook endpoint URL:
     ```text
     http://localhost:5173/api/v1/webhooks/paddle/acc_...
     ```
   - Copy endpoints and save encrypted webhook signing secrets.
3. **Products / Policies / Licenses**: Create products, configure concurrency seat limits (`maxMachines`), and issue offline signed licenses.

---

## 6. Local cURL Testing Examples

### 1. Check System Status (Unauthenticated)
```bash
curl -i http://localhost:8787/api/v1/system/status
```

### 2. Admin Login to Retrieve Session Token
```bash
curl -i -X POST http://localhost:8787/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "your_password_here"
  }'
```

### 3. Client Machine Activation (No Login, with `account_id`)
```bash
curl -i -X POST http://localhost:8787/api/v1/client/activate \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "acc_your_account_id",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "macbook-pro-m2-sha256-fingerprint-9988",
    "platform": "darwin-arm64",
    "name": "My MacBook Pro"
  }'
```

### 4. Simulate Inbound Payment Webhook (Paddle / Stripe)
```bash
curl -i -X POST http://localhost:8787/api/v1/webhooks/paddle/acc_your_account_id \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_test_paddle_001",
    "event_type": "transaction.completed",
    "data": {
      "customer": { "email": "buyer@company.com" },
      "items": [{ "price_id": "pri_123" }]
    }
  }'
```

---

## 7. Production Build & Verification (Build & Dry-Run)

Before deploying to Cloudflare, test packaging and asset compilation locally:

```bash
# 1. Run static TypeScript check across all packages
pnpm run typecheck

# 2. Build full stack (compile Vite frontend -> bundle Worker with static assets)
pnpm run build
```

The output should show:
```text
✓ built in 617ms (dist/index.html, dist/assets/...)
✨ Read 5 files from the assets directory apps/web/dist
Total Upload: ~485 KiB / gzip: ~88 KiB
Binding: env.DB, env.KEYS_KV, env.EVENT_QUEUE, env.ASSETS...
--dry-run: exiting now.
```
This confirms that frontend static assets are bundled directly into the Worker deployment.

---

## 8. Troubleshooting

### Q1: How to reset or re-test the fresh `/setup` flow?
- **Option A (Clear local D1 cache)**: Delete the `apps/server/.wrangler/state/v3/d1` directory and re-run `pnpm --filter @licenkit/server run db:migrate:local`.
- **Option B (SQL reset)**:
  ```bash
  npx --prefix apps/server wrangler d1 execute licenkit-db --local --command="DELETE FROM system_settings; DELETE FROM accounts; DELETE FROM users;"
  ```
- Clear browser `localStorage` (`localStorage.removeItem('licenkit_token')`) and reload.

### Q2: Error regarding `cryptoKey` or `STORAGE_ENCRYPTION_KEY`
- Verify that `apps/server/.dev.vars` exists and contains `STORAGE_ENCRYPTION_KEY`.
- Wrangler automatically mounts `.dev.vars` onto `c.env` in local development.

### Q3: Frontend shows `401 Unauthorized`
- The Session JWT token may have expired (7-day default validity).
- Log out from the top-right menu and log back in.
