-- LicenKit V1 target schema for Cloudflare D1 / SQLite.
-- This is a design asset. The executable Drizzle schema and generated initial
-- migration must express the same constraints before V1 implementation starts.

PRAGMA foreign_keys = ON;

CREATE TABLE system_settings (
    id TEXT PRIMARY KEY CHECK (id = 'current'),
    instance_name TEXT NOT NULL,
    app_url TEXT NOT NULL,
    api_base_url TEXT,
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TRIGGER trg_system_settings_prevent_delete
BEFORE DELETE ON system_settings
BEGIN
    SELECT RAISE(ABORT, 'SYSTEM_SETUP_STATE_DELETE_FORBIDDEN');
END;

CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (slug)
);

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

CREATE TABLE admin_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (session_token_hash),
    FOREIGN KEY (account_id, user_id)
        REFERENCES users(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_admin_sessions_user_expiry
    ON admin_sessions(account_id, user_id, expires_at);

CREATE INDEX idx_admin_sessions_lookup
    ON admin_sessions(account_id, session_token_hash);

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

CREATE TABLE customer_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    customer_id TEXT NOT NULL,
    login_challenge_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (login_challenge_id),
    UNIQUE (session_token_hash),
    FOREIGN KEY (account_id, customer_id)
        REFERENCES customers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, customer_id, login_challenge_id)
        REFERENCES customer_login_challenges(account_id, customer_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_customer_sessions_customer_expiry
    ON customer_sessions(account_id, customer_id, expires_at);

CREATE INDEX idx_customer_sessions_lookup
    ON customer_sessions(account_id, session_token_hash);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id)
);

CREATE INDEX idx_products_account_status
    ON products(account_id, status);

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
    payment_grace_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (payment_grace_seconds >= 0),
    max_activations INTEGER NOT NULL DEFAULT 1
        CHECK (max_activations >= 1),
    features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(features_json)),
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
    UNIQUE (account_id, id),
    UNIQUE (account_id, product_id, id),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_license_plans_product_status
    ON license_plans(account_id, product_id, status);

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
    credential_mode TEXT NOT NULL
        CHECK (credential_mode IN ('opaque', 'signed')),
    signed_token_ttl_seconds INTEGER NOT NULL CHECK (signed_token_ttl_seconds >= 0),
    payment_grace_seconds INTEGER NOT NULL CHECK (payment_grace_seconds >= 0),
    max_activations INTEGER NOT NULL CHECK (max_activations >= 1),
    features_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(features_json)),

    key_hash TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    key_rotated_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'api', 'payment')),
    source_billing_provider_id TEXT,
    source_external_transaction_id TEXT,
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
        (source = 'payment' AND source_billing_provider_id IS NOT NULL
            AND source_external_transaction_id IS NOT NULL)
        OR (source IN ('manual', 'api') AND source_billing_provider_id IS NULL
            AND source_external_transaction_id IS NULL)
    ),
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

CREATE TABLE trial_claims (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    product_id TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, product_id, fingerprint_hash),
    FOREIGN KEY (account_id, product_id)
        REFERENCES products(account_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing_providers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
    webhook_secret_ciphertext TEXT NOT NULL,
    api_secret_ciphertext TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (account_id, provider, environment)
);

CREATE INDEX idx_billing_providers_account_status
    ON billing_providers(account_id, status);

CREATE TABLE billing_offers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    external_price_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    license_plan_id TEXT NOT NULL,
    purchase_type TEXT NOT NULL
        CHECK (purchase_type IN ('one_time', 'subscription')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
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

CREATE TABLE billing_subscriptions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    external_subscription_id TEXT NOT NULL,
    external_customer_id TEXT,
    external_price_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'canceled')),
    current_period_start TEXT,
    current_period_end TEXT,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0
        CHECK (cancel_at_period_end IN (0, 1)),
    last_external_occurred_at TEXT,
    last_external_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_subscription_id),
    UNIQUE (license_id),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, license_id)
        REFERENCES licenses(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_billing_subscriptions_status_period
    ON billing_subscriptions(account_id, status, current_period_end);

CREATE TABLE inbound_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    billing_provider_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    external_event_type TEXT NOT NULL,
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
    received_at TEXT NOT NULL,
    processed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, id),
    UNIQUE (billing_provider_id, external_event_id),
    FOREIGN KEY (account_id, billing_provider_id)
        REFERENCES billing_providers(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_inbound_events_status_schedule
    ON inbound_events(account_id, status, next_attempt_at, locked_until, received_at);

CREATE INDEX idx_inbound_events_provider_type
    ON inbound_events(account_id, billing_provider_id, external_event_type, received_at DESC);

CREATE TABLE outbound_endpoints (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    endpoint_type TEXT NOT NULL
        CHECK (endpoint_type IN ('notification_gateway', 'event_subscriber')),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    signing_secret_ciphertext TEXT NOT NULL,
    subscribed_events_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(subscribed_events_json)),
    timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
    max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
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
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
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
        status = 'blocked_configuration'
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

CREATE TABLE outbound_attempts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    delivery_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    outcome TEXT NOT NULL
        CHECK (outcome IN ('accepted', 'http_error', 'transport_error', 'timeout')),
    http_status INTEGER,
    response_body_redacted TEXT,
    transport_error_code TEXT,
    transport_error_detail TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    UNIQUE (account_id, id),
    UNIQUE (delivery_id, attempt_number),
    FOREIGN KEY (account_id, delivery_id)
        REFERENCES outbound_deliveries(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_outbound_attempts_delivery
    ON outbound_attempts(account_id, delivery_id, attempt_number);

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
