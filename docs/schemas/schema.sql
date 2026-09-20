-- LicenKit V1 target schema for Cloudflare D1 / SQLite.
-- This is a design asset. The executable Drizzle schema and generated initial
-- migration must express the same constraints before V1 implementation starts.

PRAGMA foreign_keys = ON;

-- 用途：保存整套自部署实例的初始化结果、公开地址和 Scheduled Worker 最近一次成功心跳，是全局状态而不是租户数据。
-- 机制：固定主键 `current` 保证全库只有一行；Scheduler 只更新成对的成功时间与耗时；初始化后删除由 Trigger 拒绝。
CREATE TABLE system_settings (
    id TEXT PRIMARY KEY CHECK (id = 'current'),
    instance_name TEXT NOT NULL,
    app_url TEXT NOT NULL,
    api_base_url TEXT,
    scheduler_last_success_at TEXT,
    scheduler_last_duration_ms INTEGER
        CHECK (scheduler_last_duration_ms IS NULL OR scheduler_last_duration_ms >= 0),
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (scheduler_last_success_at IS NULL AND scheduler_last_duration_ms IS NULL)
        OR
        (scheduler_last_success_at IS NOT NULL AND scheduler_last_duration_ms IS NOT NULL)
    )
);

CREATE TRIGGER trg_system_settings_prevent_delete
BEFORE DELETE ON system_settings
BEGIN
    SELECT RAISE(ABORT, 'SYSTEM_SETUP_STATE_DELETE_FORBIDDEN');
END;

-- 用途：保存租户账户，是用户、客户、产品、授权和支付数据的最上层隔离边界。
-- 机制：`slug` 全局唯一用于稳定定位账户；状态控制账户是否可继续提供服务，默认宽限期供订阅授权快照使用。
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    default_subscription_payment_grace_seconds INTEGER NOT NULL DEFAULT 432000
        CHECK (default_subscription_payment_grace_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (slug)
);

-- 用途：保存账户内的后台管理员身份，不与购买者 Customer 身份混用。
-- 机制：邮箱在同一账户内大小写不敏感且唯一；角色决定权限，状态决定是否允许继续登录。
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    email TEXT NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, email)
);

CREATE INDEX idx_users_account_status
    ON users(account_id, status);

-- 用途：保存可吊销的后台登录会话。
-- 机制：数据库只保存 Session Token 和 CSRF Token 的哈希；每条会话绑定同账户 User，并通过过期和吊销时间控制有效性。
CREATE TABLE admin_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (session_token_hash),
    UNIQUE (csrf_token_hash),
    FOREIGN KEY (account_id, user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_admin_sessions_user_expiry
    ON admin_sessions(account_id, user_id, expires_at);

CREATE INDEX idx_admin_sessions_lookup
    ON admin_sessions(account_id, session_token_hash);

-- 用途：保存购买者的稳定内部身份，承载 License 归属和 Customer Portal 访问。
-- 机制：邮箱在同一账户内大小写不敏感且唯一；禁用只关闭客户访问，不隐式改变其 License 状态。
CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, email)
);

CREATE INDEX idx_customers_account_status
    ON customers(account_id, status, created_at DESC);

-- 用途：保存一次 Magic Link 请求及其一次性认证凭证。
-- 机制：只保存 Token 哈希，并用过期、消费、吊销时间判断可用性；关联 Delivery 追踪实际通知，按 Customer 的创建时间索引可支持重复请求冷却和旧 Challenge 吊销。
CREATE TABLE customer_login_challenges (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    customer_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    delivery_id TEXT NOT NULL,
    requested_ip TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, customer_id, id),
    UNIQUE (token_hash),
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, customer_id, delivery_id)
        REFERENCES outbound_deliveries(account_id, customer_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_customer_login_challenges_customer
    ON customer_login_challenges(account_id, customer_id, created_at DESC);

CREATE INDEX idx_customer_login_challenges_lookup
    ON customer_login_challenges(account_id, token_hash);

CREATE INDEX idx_customer_login_challenges_expiry
    ON customer_login_challenges(account_id, expires_at, consumed_at, revoked_at);

-- 用途：保存 Customer 消费 Magic Link 后建立的 Portal 会话。
-- 机制：每个 Challenge 最多绑定一个 Session；数据库只保存 Session/CSRF Token 哈希，并在每次使用时结合过期、吊销和 Customer 状态校验。
CREATE TABLE customer_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    customer_id TEXT NOT NULL,
    login_challenge_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (login_challenge_id),
    UNIQUE (session_token_hash),
    UNIQUE (csrf_token_hash),
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, customer_id, login_challenge_id)
        REFERENCES customer_login_challenges(account_id, customer_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_customer_sessions_customer_expiry
    ON customer_sessions(account_id, customer_id, expires_at);

CREATE INDEX idx_customer_sessions_lookup
    ON customer_sessions(account_id, session_token_hash);

-- 用途：保存账户销售和签发授权的产品定义，也是 Release、Plan、License 与 Offer 的业务根节点。
-- 机制：`slug` 在账户内唯一；收款环境一次只选择 sandbox 或 live，试用开关与时长由约束保持一致，归档不删除历史。
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    -- Selects the only provider environment allowed to issue usable
    -- payment-sourced Licenses for this Product. NULL means that public
    -- Checkout is not configured.
    billing_environment TEXT
        CHECK (billing_environment IN ('sandbox', 'live')),
    trial_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (trial_enabled IN (0, 1)),
    trial_duration_seconds INTEGER CHECK (trial_duration_seconds > 0),
    trial_features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(trial_features_json) AND json_type(trial_features_json) = 'array'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (trial_enabled = 0 OR trial_duration_seconds IS NOT NULL),
    UNIQUE (account_id, id),
    UNIQUE (account_id, slug)
);

CREATE INDEX idx_products_account_status
    ON products(account_id, status);

-- 用途：保存可被客户端声明和服务端信任的产品发布工件事实。
-- 机制：产品、版本和平台组合唯一，SHA-256 格式受约束；身份、工件哈希和发布时间由 Trigger 锁定且整行不可删除，只允许修正说明或下载地址。
CREATE TABLE product_releases (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    product_id TEXT NOT NULL,
    version TEXT NOT NULL,
    platform TEXT NOT NULL,
    description TEXT,
    download_url TEXT,
    artifact_sha256 TEXT NOT NULL,
    released_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, product_id, version, platform),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT,
    CHECK (
        length(artifact_sha256) = 64
        AND artifact_sha256 = lower(artifact_sha256)
        AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
);

CREATE INDEX idx_product_releases_lookup
    ON product_releases(account_id, product_id, version, platform);

CREATE TRIGGER trg_product_releases_immutable_identity
BEFORE UPDATE OF id, account_id, product_id, version, platform, artifact_sha256, released_at
ON product_releases
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.version IS NOT OLD.version
  OR NEW.platform IS NOT OLD.platform
  OR NEW.artifact_sha256 IS NOT OLD.artifact_sha256
  OR NEW.released_at IS NOT OLD.released_at
BEGIN
    SELECT RAISE(ABORT, 'PRODUCT_RELEASE_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER trg_product_releases_prevent_delete
BEFORE DELETE ON product_releases
BEGIN
    SELECT RAISE(ABORT, 'PRODUCT_RELEASE_DELETE_FORBIDDEN');
END;

-- 用途：保存产品签发离线凭证所需的 Ed25519 密钥材料。
-- 机制：私钥只保存密文，每个产品最多一个 active key；轮换通过保留 retired/revoked 旧公钥继续验证历史凭证。
CREATE TABLE signing_keys (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    product_id TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'Ed25519'
        CHECK (algorithm = 'Ed25519'),
    source TEXT NOT NULL CHECK (source IN ('generated', 'uploaded')),
    public_key TEXT NOT NULL,
    private_key_ciphertext TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'retired', 'revoked')),
    created_at TEXT NOT NULL,
    retired_at TEXT,
    revoked_at TEXT,
    UNIQUE (account_id, id),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_signing_keys_product_status
    ON signing_keys(account_id, product_id, status);

CREATE UNIQUE INDEX uq_signing_keys_product_active
    ON signing_keys(account_id, product_id)
    WHERE status = 'active';

-- 用途：保存产品可签发的授权方案模板。
-- 机制：版本号和状态管理方案演进；授权类型、凭证模式、有效期、宽限期和激活上限通过 CHECK 形成合法组合，签发时复制到 License 快照。
CREATE TABLE license_plans (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    license_model TEXT NOT NULL
        CHECK (license_model IN ('perpetual', 'fixed_term', 'subscription')),
    credential_mode TEXT NOT NULL
        CHECK (credential_mode IN ('opaque', 'signed')),
    default_term_seconds INTEGER CHECK (default_term_seconds > 0),
    update_window_seconds INTEGER CHECK (update_window_seconds > 0),
    signed_token_ttl_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (signed_token_ttl_seconds >= 0),
    payment_grace_seconds INTEGER NOT NULL
        CHECK (payment_grace_seconds >= 0),
    max_activations INTEGER NOT NULL DEFAULT 1
        CHECK (max_activations >= 1),
    features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(features_json) AND json_type(features_json) = 'array'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (license_model = 'fixed_term' AND default_term_seconds IS NOT NULL)
        OR (license_model IN ('perpetual', 'subscription') AND default_term_seconds IS NULL)
    ),
    CHECK (
        license_model = 'perpetual'
        OR update_window_seconds IS NULL
    ),
    CHECK (
        (credential_mode = 'opaque' AND signed_token_ttl_seconds = 0)
        OR (credential_mode = 'signed' AND signed_token_ttl_seconds > 0)
    ),
    CHECK (
        (license_model = 'subscription' AND payment_grace_seconds >= 0)
        OR (license_model IN ('perpetual', 'fixed_term') AND payment_grace_seconds = 0)
    ),
    UNIQUE (account_id, id),
    UNIQUE (account_id, product_id, id),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_license_plans_product_status
    ON license_plans(account_id, product_id, status);

-- 用途：保存已经签发给 Customer 的授权及其当前生命周期状态。
-- 机制：签发时复制 Plan 条款，避免后续模板修改回写旧授权；注册码只存哈希，支付来源用外部交易唯一键幂等，验证 License 被约束为不可激活的 suspended 状态。
CREATE TABLE licenses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    customer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),

    -- Immutable-by-default License Terms snapshot.
    license_model TEXT NOT NULL
        CHECK (license_model IN ('perpetual', 'fixed_term', 'subscription')),
    renewal_mode TEXT NOT NULL
        CHECK (renewal_mode IN ('none', 'manual', 'billing')),
    credential_mode TEXT NOT NULL
        CHECK (credential_mode IN ('opaque', 'signed')),
    signed_token_ttl_seconds INTEGER NOT NULL CHECK (signed_token_ttl_seconds >= 0),
    payment_grace_seconds INTEGER NOT NULL CHECK (payment_grace_seconds >= 0),
    max_activations INTEGER NOT NULL CHECK (max_activations >= 1),
    features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(features_json) AND json_type(features_json) = 'array'),

    key_hash TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    key_rotated_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'api', 'payment')),
    source_billing_provider_id TEXT,
    source_external_transaction_id TEXT,
    -- A real Sandbox end-to-end verification issues and delivers a key, but
    -- the key must never become an activatable customer entitlement.
    is_checkout_verification INTEGER NOT NULL DEFAULT 0
        CHECK (is_checkout_verification IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'revoked')),
    status_reason TEXT,
    expires_at TEXT,
    updates_until TEXT,
    suspended_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, key_hash),
    CHECK (
        (license_model = 'perpetual' AND expires_at IS NULL)
        OR (license_model IN ('fixed_term', 'subscription') AND expires_at IS NOT NULL)
    ),
    CHECK (
        license_model = 'perpetual'
        OR updates_until IS NULL
    ),
    CHECK (
        (credential_mode = 'opaque' AND signed_token_ttl_seconds = 0)
        OR (credential_mode = 'signed' AND signed_token_ttl_seconds > 0)
    ),
    CHECK (
        (license_model = 'subscription' AND payment_grace_seconds >= 0)
        OR (license_model IN ('perpetual', 'fixed_term') AND payment_grace_seconds = 0)
    ),
    CHECK (
        (source = 'payment' AND source_billing_provider_id IS NOT NULL
            AND source_external_transaction_id IS NOT NULL)
        OR (source IN ('manual', 'api') AND source_billing_provider_id IS NULL
            AND source_external_transaction_id IS NULL)
    ),
    CHECK (
        is_checkout_verification = 0
        OR (
            source = 'payment'
            AND status = 'suspended'
            AND status_reason = 'checkout_verification'
        )
    ),
    CHECK (
        (license_model IN ('perpetual', 'fixed_term') AND renewal_mode = 'none')
        OR (
            license_model = 'subscription'
            AND renewal_mode = 'manual'
            AND source IN ('manual', 'api')
        )
        OR (
            license_model = 'subscription'
            AND renewal_mode = 'billing'
            AND source = 'payment'
        )
    ),
    CHECK (renewal_mode <> 'manual' OR expires_at > created_at),
    CHECK (renewal_mode = 'billing' OR payment_grace_seconds = 0),
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, product_id, plan_id)
        REFERENCES license_plans(account_id, product_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, source_billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_licenses_source_transaction
    ON licenses(account_id, source_billing_provider_id, source_external_transaction_id)
    WHERE source_billing_provider_id IS NOT NULL
      AND source_external_transaction_id IS NOT NULL;

CREATE INDEX idx_licenses_account_status
    ON licenses(account_id, status, created_at DESC);

CREATE INDEX idx_licenses_product_plan
    ON licenses(account_id, product_id, plan_id);

CREATE INDEX idx_licenses_customer
    ON licenses(account_id, customer_id, created_at DESC);

-- 用途：记录注册码从旧版本轮换到新版本的历史和发起来源。
-- 机制：版本必须单向递增，区分找回、安全重置和管理员操作，并关联可选 Delivery；注册码明文本身不进入本表。
CREATE TABLE license_key_rotations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    license_id TEXT NOT NULL,
    from_version INTEGER NOT NULL CHECK (from_version >= 1),
    to_version INTEGER NOT NULL CHECK (to_version > from_version),
    reason TEXT NOT NULL CHECK (reason IN ('recovery', 'security_reset', 'admin')),
    revoked_activations INTEGER NOT NULL DEFAULT 0
        CHECK (revoked_activations IN (0, 1)),
    initiated_by_user_id TEXT,
    initiated_by_customer_id TEXT,
    delivery_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    CHECK (initiated_by_user_id IS NULL OR initiated_by_customer_id IS NULL),
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, initiated_by_user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, initiated_by_customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id, delivery_id)
        REFERENCES outbound_deliveries(account_id, license_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_license_key_rotations_license
    ON license_key_rotations(account_id, license_id, created_at DESC);

-- 用途：保存一条 License 与具体设备之间的激活绑定及其历史状态。
-- 机制：设备指纹和机器令牌只存哈希；同一 License/指纹最多一个 active 绑定，插入或重新激活时由 Trigger 按 License 快照强制执行激活上限。
CREATE TABLE activations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    license_id TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    machine_token_hash TEXT NOT NULL,
    name TEXT,
    platform TEXT,
    first_ip TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deactivated', 'revoked')),
    activated_at TEXT NOT NULL,
    last_validated_at TEXT,
    deactivated_at TEXT,
    revoked_at TEXT,
    revoke_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_activations_license_status
    ON activations(account_id, license_id, status);

CREATE INDEX idx_activations_token_hash
    ON activations(account_id, machine_token_hash);

CREATE UNIQUE INDEX uq_activations_active_fingerprint
    ON activations(account_id, license_id, fingerprint_hash)
    WHERE status = 'active';

CREATE TRIGGER trg_activations_enforce_limit_on_insert
BEFORE INSERT ON activations
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*)
            FROM activations
            WHERE account_id = NEW.account_id
              AND license_id = NEW.license_id
              AND status = 'active'
        ) >= (
            SELECT max_activations
            FROM licenses
            WHERE account_id = NEW.account_id
              AND id = NEW.license_id
        )
        THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
    END;
END;

CREATE TRIGGER trg_activations_enforce_limit_on_reactivate
BEFORE UPDATE OF status ON activations
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*)
            FROM activations
            WHERE account_id = NEW.account_id
              AND license_id = NEW.license_id
              AND status = 'active'
        ) >= (
            SELECT max_activations
            FROM licenses
            WHERE account_id = NEW.account_id
              AND id = NEW.license_id
        )
        THEN RAISE(ABORT, 'LICENSE_ACTIVATION_LIMIT_REACHED')
    END;
END;

-- 用途：保存不依赖支付的产品设备试用领取记录。
-- 机制：同一账户、产品和设备指纹只能领取一次；Token 只存哈希，过期时间固定，吊销时间与原因必须成对出现。
CREATE TABLE trial_claims (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    product_id TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    trial_token_hash TEXT NOT NULL,
    features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(features_json) AND json_type(features_json) = 'array'),
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_validated_at TEXT,
    revoked_at TEXT,
    revoke_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, trial_token_hash),
    UNIQUE (account_id, product_id, fingerprint_hash),
    CHECK (expires_at > claimed_at),
    CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    ),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_trial_claims_lookup
    ON trial_claims(account_id, product_id, id);

CREATE INDEX idx_trial_claims_expiry
    ON trial_claims(account_id, product_id, expires_at, revoked_at);

-- 用途：保存账户连接到支付平台的 sandbox 或 live 配置。
-- 机制：Client-side Token 是可公开给 Paddle.js 的凭证，Webhook/API Secret 保存密文；账户、平台和环境组合唯一，Token 前缀必须与环境一致。
CREATE TABLE billing_providers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
    -- Public Paddle.js credential. This is intentionally returned by the
    -- public Checkout configuration API and must never be an API key.
    client_side_token TEXT NOT NULL,
    webhook_secret_ciphertext TEXT NOT NULL,
    -- Optional server-side credential for provider API capabilities such as
    -- customer portal sessions or explicitly enabled reconciliation.
    api_secret_ciphertext TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (environment = 'sandbox' AND substr(client_side_token, 1, 5) = 'test_')
        OR (environment = 'live' AND substr(client_side_token, 1, 5) = 'live_')
    ),
    UNIQUE (account_id, id),
    UNIQUE (account_id, provider, environment)
);

CREATE INDEX idx_billing_providers_account_status
    ON billing_providers(account_id, status);

-- 用途：保存需要管理员处理的系统能力故障；它描述 Provider 配置等共享依赖，不替代单个事件自己的错误。
-- 机制：同一账户、Provider、能力和错误码永远复用一行；重复发生只更新最近错误和次数，已解决后再次发生则重新打开同一行。
CREATE TABLE system_issues (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    capability TEXT NOT NULL
        CHECK (capability IN ('customer_read', 'customer_portal_session')),
    issue_code TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error'
        CHECK (severity IN ('warning', 'error', 'critical')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved')),
    occurrence_count INTEGER NOT NULL DEFAULT 1
        CHECK (occurrence_count >= 1),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_error_detail_json TEXT NOT NULL DEFAULT '{}'
        CHECK (
            json_valid(last_error_detail_json)
            AND json_type(last_error_detail_json) = 'object'
        ),
    resolved_at TEXT,
    resolved_by_user_id TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (
        account_id,
        billing_provider_id,
        capability,
        issue_code
    ),
    CHECK (last_seen_at >= first_seen_at),
    CHECK (
        (status = 'open'
            AND resolved_at IS NULL
            AND resolved_by_user_id IS NULL
            AND resolution_note IS NULL)
        OR (status = 'resolved'
            AND resolved_at IS NOT NULL
            AND resolved_by_user_id IS NOT NULL
            AND resolution_note IS NOT NULL
            AND length(trim(resolution_note)) > 0)
    ),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, resolved_by_user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_system_issues_status
    ON system_issues(account_id, status, severity, last_seen_at DESC);

CREATE INDEX idx_system_issues_provider_capability
    ON system_issues(account_id, billing_provider_id, capability, status);

-- 用途：保存支付平台 Customer 的本地镜像及其与内部 Customer 的稳定映射。
-- 机制：外部 Customer ID 在同一 Provider 连接内唯一；Webhook/API/对账共用同一记录，并用 pending、linked、email_mismatch、needs_attention 表达链接是否可安全用于履约。
CREATE TABLE billing_customers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    customer_id TEXT,
    external_customer_id TEXT NOT NULL,
    provider_email TEXT NOT NULL COLLATE NOCASE,
    provider_name TEXT,
    provider_status TEXT NOT NULL
        CHECK (provider_status IN ('active', 'archived')),
    link_status TEXT NOT NULL
        CHECK (link_status IN ('pending', 'linked', 'email_mismatch', 'needs_attention')),
    last_sync_source TEXT NOT NULL
        CHECK (last_sync_source IN ('webhook', 'api', 'reconciliation')),
    -- Paddle customer.updated_at may be null on creation; persist
    -- COALESCE(provider updated_at, provider created_at) as the version time.
    external_updated_at TEXT NOT NULL,
    last_external_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_customer_id),
    UNIQUE (account_id, billing_provider_id, external_customer_id),
    CHECK (
        (customer_id IS NULL AND link_status IN ('pending', 'needs_attention'))
        OR (customer_id IS NOT NULL AND link_status IN ('linked', 'email_mismatch'))
    ),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_billing_customers_customer
    ON billing_customers(account_id, customer_id, updated_at DESC);

CREATE INDEX idx_billing_customers_link_status
    ON billing_customers(account_id, billing_provider_id, link_status, updated_at);

-- 用途：把一个支付平台 Price 精确映射到 Product、License Plan 和购买类型。
-- 机制：Offer 从 draft 开始，显式通过 Readiness 后才能 active；同一 Provider 下 Price 唯一，产生 Checkout Verification 后关键映射由 Trigger 锁定，变更合同应归档并新建。
CREATE TABLE billing_offers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    external_price_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    license_plan_id TEXT NOT NULL,
    purchase_type TEXT NOT NULL
        CHECK (purchase_type IN ('one_time', 'subscription')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_price_id),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, product_id, license_plan_id)
        REFERENCES license_plans(account_id, product_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_billing_offers_plan_status
    ON billing_offers(account_id, license_plan_id, status);

-- 用途：保存支付平台 Subscription 与本地 License 的一对一镜像。
-- 机制：以外部 Subscription ID 幂等更新，用外部事件时间和事件 ID 处理乱序；周期、试用和取消字段驱动同一 License 的续期、宽限或停止续期。
CREATE TABLE billing_subscriptions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    external_subscription_id TEXT NOT NULL,
    external_customer_id TEXT NOT NULL,
    external_price_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'canceled')),
    current_period_start TEXT,
    current_period_end TEXT,
    next_billed_at TEXT,
    trial_type TEXT
        CHECK (trial_type IN ('free_payment_method_required')),
    trial_started_at TEXT,
    trial_ends_at TEXT,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0
        CHECK (cancel_at_period_end IN (0, 1)),
    last_external_occurred_at TEXT,
    last_external_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_subscription_id),
    UNIQUE (license_id),
    CHECK (
        (trial_type IS NULL AND trial_started_at IS NULL AND trial_ends_at IS NULL)
        OR (
            trial_type IS NOT NULL
            AND trial_started_at IS NOT NULL
            AND trial_ends_at IS NOT NULL
            AND trial_ends_at > trial_started_at
        )
    ),
    CHECK (
        status <> 'trialing'
        OR (
            trial_type = 'free_payment_method_required'
            AND trial_started_at IS NOT NULL
            AND trial_ends_at IS NOT NULL
            AND next_billed_at IS NOT NULL
        )
    ),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, billing_provider_id, external_customer_id)
        REFERENCES billing_customers(account_id, billing_provider_id, external_customer_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_billing_subscriptions_status_period
    ON billing_subscriptions(account_id, status, current_period_end);

-- 用途：保存退款、拒付、撤销等支付调整事实及需要人工处理的决定。
-- 机制：外部 Adjustment ID 保证幂等；Provider 原始动作和状态原样保留，自动影响与人工 review/resolution 分开，只有明确条件满足时才关联并暂停 License。
CREATE TABLE billing_adjustments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    license_id TEXT,
    external_adjustment_id TEXT NOT NULL,
    external_transaction_id TEXT NOT NULL,
    external_subscription_id TEXT,
    external_customer_id TEXT NOT NULL,
    provider_action TEXT NOT NULL
        CHECK (provider_action IN (
            'credit',
            'refund',
            'chargeback',
            'chargeback_reverse',
            'chargeback_warning',
            'chargeback_warning_reverse',
            'credit_reverse'
        )),
    adjustment_type TEXT CHECK (adjustment_type IN ('full', 'partial')),
    provider_status TEXT NOT NULL
        CHECK (provider_status IN ('pending_approval', 'approved', 'rejected', 'reversed')),
    currency_code TEXT NOT NULL,
    total_amount TEXT NOT NULL,
    provider_reason TEXT,
    automatic_effect TEXT NOT NULL DEFAULT 'none'
        CHECK (automatic_effect IN ('none', 'license_suspended')),
    review_status TEXT NOT NULL
        CHECK (review_status IN ('not_required', 'open', 'resolved')),
    resolution_action TEXT
        CHECK (resolution_action IN (
            'no_action',
            'keep_suspended',
            'reinstate',
            'revoke',
            'security_reset'
        )),
    resolution_reason TEXT,
    resolved_by_user_id TEXT,
    resolved_at TEXT,
    last_external_occurred_at TEXT NOT NULL,
    last_external_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_adjustment_id),
    CHECK (automatic_effect = 'none' OR license_id IS NOT NULL),
    CHECK (review_status <> 'not_required' OR automatic_effect = 'none'),
    CHECK (
        (review_status IN ('not_required', 'open')
            AND resolution_action IS NULL
            AND resolution_reason IS NULL
            AND resolved_by_user_id IS NULL
            AND resolved_at IS NULL)
        OR (review_status = 'resolved'
            AND resolution_action IS NOT NULL
            AND resolution_reason IS NOT NULL
            AND resolved_by_user_id IS NOT NULL
            AND resolved_at IS NOT NULL)
    ),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, resolved_by_user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_billing_adjustments_review
    ON billing_adjustments(account_id, review_status, updated_at DESC);

CREATE INDEX idx_billing_adjustments_transaction
    ON billing_adjustments(account_id, billing_provider_id, external_transaction_id, updated_at DESC);

-- 用途：保存每个已验签支付入站事件及其处理状态，是 Webhook 幂等和故障恢复的事实入口。
-- 机制：Provider/外部事件 ID 唯一；加密负载有独立清理期限，Worker 通过状态、重试时间和租约领取任务；`attempt_count` 与 `last_error_*` 只保存当前汇总，V1 不建立 Inbound Attempt 历史表。
CREATE TABLE inbound_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    external_event_type TEXT NOT NULL,
    external_customer_id TEXT,
    external_transaction_id TEXT,
    external_subscription_id TEXT,
    external_adjustment_id TEXT,
    external_occurred_at TEXT,
    payload_ciphertext TEXT,
    payload_hash TEXT NOT NULL,
    payload_expires_at TEXT NOT NULL,
    payload_cleared_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'needs_attention')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT,
    locked_by TEXT,
    locked_until TEXT,
    result_type TEXT,
    result_reference_id TEXT,
    last_error_code TEXT,
    last_error_detail TEXT,
    blocking_system_issue_id TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_event_id),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, blocking_system_issue_id)
        REFERENCES system_issues(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_inbound_events_status_schedule
    ON inbound_events(account_id, status, next_attempt_at, locked_until, received_at);

CREATE INDEX idx_inbound_events_provider_type
    ON inbound_events(account_id, billing_provider_id, external_event_type, received_at DESC);

CREATE INDEX idx_inbound_events_customer
    ON inbound_events(account_id, billing_provider_id, external_customer_id, received_at DESC)
    WHERE external_customer_id IS NOT NULL;

CREATE INDEX idx_inbound_events_transaction
    ON inbound_events(account_id, billing_provider_id, external_transaction_id, received_at DESC)
    WHERE external_transaction_id IS NOT NULL;

CREATE INDEX idx_inbound_events_subscription
    ON inbound_events(account_id, billing_provider_id, external_subscription_id, received_at DESC)
    WHERE external_subscription_id IS NOT NULL;

CREATE INDEX idx_inbound_events_adjustment
    ON inbound_events(account_id, billing_provider_id, external_adjustment_id, received_at DESC)
    WHERE external_adjustment_id IS NOT NULL;

CREATE INDEX idx_inbound_events_blocking_issue
    ON inbound_events(account_id, blocking_system_issue_id, status, received_at)
    WHERE blocking_system_issue_id IS NOT NULL;

CREATE INDEX idx_inbound_events_payload_retention
    ON inbound_events(payload_expires_at, id)
    WHERE payload_ciphertext IS NOT NULL;

-- 用途：永久记录一条系统问题曾影响过哪些 Inbound Event，供管理端展示、恢复预览和审计。
-- 机制：同一 Issue/Event 只保留一行并累加问题观测次数；它不是执行 Attempt 记录，事件解除阻塞或处理完成后仍保留关联。
CREATE TABLE system_issue_inbound_events (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    system_issue_id TEXT NOT NULL,
    inbound_event_id TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1
        CHECK (occurrence_count >= 1),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (system_issue_id, inbound_event_id),
    CHECK (last_seen_at >= first_seen_at),
    FOREIGN KEY (account_id, system_issue_id)
        REFERENCES system_issues(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, inbound_event_id)
        REFERENCES inbound_events(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_system_issue_inbound_events_issue
    ON system_issue_inbound_events(account_id, system_issue_id, last_seen_at DESC);

CREATE INDEX idx_system_issue_inbound_events_event
    ON system_issue_inbound_events(account_id, inbound_event_id);

-- 用途：保存 Notification Gateway 或业务事件订阅方的出站目标配置。
-- 机制：签名 Secret 保存密文，超时和自动尝试上限随端点配置；每个账户最多一个 active Notification Gateway，业务事件订阅端点可有多个。
CREATE TABLE outbound_endpoints (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    endpoint_type TEXT NOT NULL
        CHECK (endpoint_type IN ('notification_gateway', 'event_subscriber')),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    signing_secret_ciphertext TEXT NOT NULL,
    subscribed_events_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(subscribed_events_json) AND json_type(subscribed_events_json) = 'array'),
    timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
    -- Initial request plus three automatic retries by default.
    max_automatic_attempts INTEGER NOT NULL DEFAULT 4
        CHECK (max_automatic_attempts BETWEEN 1 AND 20),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id)
);

CREATE INDEX idx_outbound_endpoints_account_type
    ON outbound_endpoints(account_id, endpoint_type, status);

CREATE UNIQUE INDEX uq_outbound_active_notification_gateway
    ON outbound_endpoints(account_id, endpoint_type)
    WHERE endpoint_type = 'notification_gateway' AND status = 'active';

-- 用途：保存一次待发送的通知或业务事件任务，是 D1 中的持久化 Outbox。
-- 机制：业务幂等键防止重复创建；创建时固化目标和签名配置，敏感负载加密且有期限，Worker 通过状态、调度时间和租约重试，2xx accepted 后清除负载。
CREATE TABLE outbound_deliveries (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    endpoint_id TEXT,
    customer_id TEXT,
    license_id TEXT,
    event_type TEXT NOT NULL,
    recipient_email TEXT COLLATE NOCASE,
    idempotency_key TEXT NOT NULL,
    target_url TEXT,
    signing_secret_ciphertext TEXT,
    payload_ciphertext TEXT,
    payload_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'blocked_configuration',
            'pending',
            'processing',
            'accepted',
            'retry_scheduled',
            'failed',
            'payload_expired'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    automatic_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (automatic_attempt_count >= 0),
    max_automatic_attempts INTEGER NOT NULL
        CHECK (max_automatic_attempts BETWEEN 1 AND 20),
    next_attempt_at TEXT,
    locked_by TEXT,
    locked_until TEXT,
    last_error_code TEXT,
    last_error_detail TEXT,
    accepted_at TEXT,
    payload_cleared_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, customer_id, id),
    UNIQUE (account_id, license_id, id),
    UNIQUE (account_id, idempotency_key),
    CHECK (
        automatic_attempt_count <= attempt_count
        AND automatic_attempt_count <= max_automatic_attempts
    ),
    CHECK (
        status IN ('blocked_configuration', 'payload_expired')
        OR (
            endpoint_id IS NOT NULL
            AND target_url IS NOT NULL
            AND signing_secret_ciphertext IS NOT NULL
        )
    ),
    FOREIGN KEY (account_id, endpoint_id)
        REFERENCES outbound_endpoints(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_outbound_deliveries_status_schedule
    ON outbound_deliveries(account_id, status, next_attempt_at, locked_until, created_at);

CREATE INDEX idx_outbound_deliveries_license
    ON outbound_deliveries(account_id, license_id, created_at DESC);

CREATE INDEX idx_outbound_deliveries_customer
    ON outbound_deliveries(account_id, customer_id, created_at DESC);

-- 用途：保存管理员在 Offer 激活前发起的真实 Sandbox Checkout 闭环验证。
-- 机制：只保存一次性验证 Token 哈希并绑定 draft Sandbox Offer；已验签交易创建不可激活 License 和真实 Delivery，只有 Delivery accepted 才 completed，身份字段由 Trigger 禁止改绑或延长。
CREATE TABLE billing_checkout_verifications (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_offer_id TEXT NOT NULL,
    requested_by_user_id TEXT NOT NULL,
    -- Only the hash is persisted. The plaintext high-entropy token is
    -- returned once to the authenticated admin SDK and copied into Paddle
    -- custom_data solely to authorize this non-activatable test fulfillment.
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'delivery_pending',
            'completed',
            'needs_attention',
            'expired'
        )),
    external_transaction_id TEXT,
    license_id TEXT,
    delivery_id TEXT,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    last_error_code TEXT,
    last_error_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (token_hash),
    CHECK (expires_at > created_at),
    CHECK (
        status NOT IN ('delivery_pending', 'completed')
        OR (
            external_transaction_id IS NOT NULL
            AND license_id IS NOT NULL
            AND delivery_id IS NOT NULL
        )
    ),
    CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CHECK (
        status <> 'expired'
        OR (
            external_transaction_id IS NULL
            AND license_id IS NULL
            AND delivery_id IS NULL
        )
    ),
    FOREIGN KEY (account_id, billing_offer_id)
        REFERENCES billing_offers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, requested_by_user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id, delivery_id)
        REFERENCES outbound_deliveries(account_id, license_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_billing_checkout_verifications_transaction
    ON billing_checkout_verifications(account_id, billing_offer_id, external_transaction_id)
    WHERE external_transaction_id IS NOT NULL;

CREATE INDEX idx_billing_checkout_verifications_status_expiry
    ON billing_checkout_verifications(account_id, status, expires_at);

CREATE INDEX idx_billing_checkout_verifications_offer
    ON billing_checkout_verifications(account_id, billing_offer_id, completed_at DESC);

-- 用途：逐次记录 Outbound Delivery 的实际 HTTP 发送结果，提供可回溯的网络诊断历史。
-- 机制：同一 Delivery 的 Attempt 序号唯一且递增，区分首次、自动和人工重试；保留 HTTP 状态、脱敏响应或原始传输错误，不用汇总错误覆盖历史。
CREATE TABLE outbound_attempts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    delivery_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    attempt_source TEXT NOT NULL
        CHECK (attempt_source IN ('initial', 'automatic_retry', 'manual_retry')),
    outcome TEXT NOT NULL
        CHECK (outcome IN ('accepted', 'http_error', 'transport_error', 'timeout')),
    http_status INTEGER,
    response_body_redacted TEXT,
    transport_error_code TEXT,
    transport_error_detail TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    CHECK (
        (attempt_number = 1 AND attempt_source = 'initial')
        OR (attempt_number > 1 AND attempt_source IN ('automatic_retry', 'manual_retry'))
    ),
    UNIQUE (account_id, id),
    UNIQUE (delivery_id, attempt_number),
    FOREIGN KEY (account_id, delivery_id)
        REFERENCES outbound_deliveries(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_outbound_attempts_delivery
    ON outbound_attempts(account_id, delivery_id, attempt_number);

-- 用途：记录管理员、Customer 和系统对安全或业务状态的关键操作。
-- 机制：Actor 类型决定必须关联哪一种身份，资源和 request ID 串联调用链；详情只保存经过字段级脱敏的合法 JSON，服务层按只追加日志使用。
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'customer', 'system')),
    actor_user_id TEXT,
    actor_customer_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    request_id TEXT,
    details_redacted_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(details_redacted_json)),
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    CHECK (
        (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_customer_id IS NULL)
        OR (actor_type = 'customer' AND actor_customer_id IS NOT NULL AND actor_user_id IS NULL)
        OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_customer_id IS NULL)
    ),
    FOREIGN KEY (account_id, actor_user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, actor_customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_audit_logs_account_created
    ON audit_logs(account_id, created_at DESC);

CREATE INDEX idx_audit_logs_resource
    ON audit_logs(account_id, resource_type, resource_id, created_at DESC);

CREATE INDEX idx_audit_logs_action
    ON audit_logs(account_id, action, created_at DESC);

-- Billing environment and Checkout verification are security boundaries, not
-- presentation-only fields. Keep the database fail-closed if an application
-- path forgets one of the service-layer checks.
CREATE TRIGGER trg_billing_providers_immutable_identity
BEFORE UPDATE OF account_id, provider, environment ON billing_providers
WHEN NEW.account_id IS NOT OLD.account_id
  OR NEW.provider IS NOT OLD.provider
  OR NEW.environment IS NOT OLD.environment
BEGIN
    SELECT RAISE(ABORT, 'billing_provider_identity_immutable');
END;

CREATE TRIGGER trg_products_guard_billing_environment_change
BEFORE UPDATE OF billing_environment ON products
WHEN NEW.billing_environment IS NOT OLD.billing_environment
BEGIN
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM billing_offers AS offer
            WHERE offer.account_id = OLD.account_id
              AND offer.product_id = OLD.id
              AND offer.status = 'active'
        )
        OR EXISTS (
            SELECT 1
            FROM licenses AS license
            WHERE license.account_id = OLD.account_id
              AND license.product_id = OLD.id
              AND license.source = 'payment'
              AND license.is_checkout_verification = 0
        )
        THEN RAISE(ABORT, 'product_billing_environment_locked')
    END;
END;

CREATE TRIGGER trg_billing_offers_active_environment_on_insert
BEFORE INSERT ON billing_offers
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END;
END;

CREATE TRIGGER trg_billing_offers_active_environment_on_update
BEFORE UPDATE OF status, billing_provider_id, product_id, account_id ON billing_offers
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'billing_offer_environment_mismatch') END;
END;

CREATE TRIGGER trg_billing_offers_lock_verified_mapping
BEFORE UPDATE OF account_id, billing_provider_id, external_price_id,
    product_id, license_plan_id, purchase_type ON billing_offers
WHEN EXISTS (
    SELECT 1
    FROM billing_checkout_verifications AS verification
    WHERE verification.account_id = OLD.account_id
      AND verification.billing_offer_id = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'verified_billing_offer_mapping_immutable');
END;

CREATE TRIGGER trg_licenses_payment_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.source = 'payment' AND NEW.is_checkout_verification = 0
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM products AS product
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = NEW.source_billing_provider_id
        WHERE product.account_id = NEW.account_id
          AND product.id = NEW.product_id
          AND product.billing_environment IS NOT NULL
          AND product.billing_environment = provider.environment
    ) THEN RAISE(ABORT, 'payment_license_environment_mismatch') END;
END;

CREATE TRIGGER trg_licenses_verification_environment_on_insert
BEFORE INSERT ON licenses
WHEN NEW.is_checkout_verification = 1
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM billing_providers AS provider
        WHERE provider.account_id = NEW.account_id
          AND provider.id = NEW.source_billing_provider_id
          AND provider.environment = 'sandbox'
    ) THEN RAISE(ABORT, 'checkout_verification_requires_sandbox') END;
END;

CREATE TRIGGER trg_licenses_verification_flag_immutable
BEFORE UPDATE OF is_checkout_verification ON licenses
WHEN NEW.is_checkout_verification IS NOT OLD.is_checkout_verification
BEGIN
    SELECT RAISE(ABORT, 'checkout_verification_flag_immutable');
END;

CREATE TRIGGER trg_checkout_verifications_require_draft_sandbox
BEFORE INSERT ON billing_checkout_verifications
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM billing_offers AS offer
        JOIN billing_providers AS provider
          ON provider.account_id = NEW.account_id
         AND provider.id = offer.billing_provider_id
        WHERE offer.account_id = NEW.account_id
          AND offer.id = NEW.billing_offer_id
          AND offer.status = 'draft'
          AND provider.environment = 'sandbox'
    ) THEN RAISE(ABORT, 'checkout_verification_requires_draft_sandbox_offer') END;
END;

CREATE TRIGGER trg_checkout_verifications_immutable_identity
BEFORE UPDATE OF id, account_id, billing_offer_id, requested_by_user_id,
    token_hash, expires_at, created_at
ON billing_checkout_verifications
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.billing_offer_id IS NOT OLD.billing_offer_id
  OR NEW.requested_by_user_id IS NOT OLD.requested_by_user_id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'checkout_verification_identity_immutable');
END;
