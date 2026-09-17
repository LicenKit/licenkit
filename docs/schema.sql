-- ==============================================================================
-- LicenKit 核心数据库架构 (Schema)
-- 适用底座: Cloudflare D1 (SQLite)
-- 设计哲学: 现代化 API-First 纯授权中枢，可自部署开源版本 (LicenKit)
-- 
-- 核心设计准则:
-- 1. 系统配置与前后端域名：system_settings 存储实例名称与 app_url/api_base_url，换域名无需重新发布 Worker；
-- 2. 租户 (Account) 与用户 (User) 概念彻底分离：
--    - accounts: 资产与隔离边界 (组织/租户)，持有 products, licenses, 支付配置与租户自定义域名
--    - users: 自然人管理员，归属特定 account_id，持有登录凭据与角色 (预留多用户协作能力)
-- 3. 首次进入 Setup 状态机：accounts 表为空时为未初始化状态，仅通过 /setup 原子初始化系统配置、Account 与首位 Owner User；
-- 4. 全局 ID 规范：所有主键统一采用带前缀 NanoID / ULID (如 acc_, usr_, prd_, pol_, lic_, mac_, kid_, whe_, evt_)；
-- 5. 租户敏感凭据信封加密：支付网关配置与托管/上传的 Ed25519 私钥统一由 STORAGE_ENCRYPTION_KEY 保护；
-- 6. 灵活的授权签发模式 (Policies.scheme):
--    - 'guid': 在线不加密 GUID 模式 (适合纯在线核销)
--    - 'ed25519': 非对称离线签名 Token 模式 (支持平台自动代生成或租户自主上传私钥)；
-- 7. 试用防刷独立隔离：单机匿名免费试用单表闭环 (挂载 account_id)，零污染商业许可证库；
-- 8. Webhook 入向去重精确到源：以 (account_id, provider, event_id) 精确幂等防重；
-- 9. 严格 RFC 3339 / ISO 8601 UTC 时间戳规范与 NOCASE 文本索引。
-- ==============================================================================

-- 1. 系统实例配置表 (System Settings - 实例全局设置与前后端基准域名)
CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY DEFAULT 'current',       -- 固定主键 "current" (单行单例配置)
    instance_name TEXT NOT NULL,                 -- 实例展示名称，如 "ScreenStudio Licensing Hub"
    app_url TEXT NOT NULL,                       -- 前端控制台主访问基准 URL，如 "https://license.screenstudio.com"
    api_base_url TEXT,                           -- 后端 API 访问基准 URL (可选)。
                                                 -- 缺省规则：若为 NULL 或留空，系统自动继承 app_url，即 API 统一挂载在 "${app_url}/api/v1/*" 子路径 (单域名同域部署，零 CORS)；
                                                 -- 分离规则：若显式配置 (如 "https://api.screenstudio.com")，则 API 挂载在 "${api_base_url}/api/v1/*"，且系统自动将 app_url 加入 CORS 白名单。
    allow_signup BOOLEAN NOT NULL DEFAULT FALSE, -- 是否允许公开注册 (自部署默认为 FALSE)
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. 租户主体表 (Accounts - 组织/租户空间，资产最高边界)
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,                       -- 租户全局唯一 ULID，如 "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C"
    name TEXT NOT NULL,                        -- 团队 / 组织 / 实例名称，如 "ScreenStudio LLC"
    slug TEXT UNIQUE NOT NULL,                 -- 专属二级标识 (用于 Webhook 回调路由)，如 "screenstudio"
    custom_domain TEXT UNIQUE,                 -- 租户专属自定义二级/独立域名 (支持 CNAME 白标访问)，如 "license.screenstudio.com"
    payment_configs TEXT,                      -- 该租户的各支付网关配置与 Webhook Secret (AES-256-GCM 密文 JSON)
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 租户是否处于正常服务状态
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_slug ON accounts(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_custom_domain ON accounts(custom_domain);

-- 3. 自然人用户表 (Users - 管理员身份与认证，1 个 Account 可对应多个 User)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                       -- 用户全局唯一 ULID，如 "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    email TEXT UNIQUE NOT NULL COLLATE NOCASE, -- 自然人登录邮箱 (全库唯一)
    password_hash TEXT NOT NULL,               -- WebCrypto PBKDF2 / Argon2 密码加盐散列
    name TEXT NOT NULL,                        -- 用户显示名称，如 "Alex"
    role TEXT NOT NULL DEFAULT 'owner',        -- 角色: 'owner' (初始创建者) | 'admin' | 'member'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 用户状态
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 4. 产品表 (Products)
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,                       -- 产品全局唯一 ID (ULID)，如 "prd_01J8X9N3A1B2C3D4E5F6G7H8J9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    name TEXT NOT NULL,                        -- 产品展示名称，如 "ScreenStudio Pro"
    description TEXT,                          -- 产品描述
    trial_days INTEGER NOT NULL DEFAULT 14,    -- 单机默认免密试用天数 (0 表示关闭试用)
    trial_features JSON NOT NULL DEFAULT '[]', -- 试用期开放功能清单
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否启用
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_products_account_id ON products(account_id);

-- 5. 密码学公私钥表 (Crypto Keys)
-- 机制: key_material 为 AES-256-GCM 密文 (由 Worker 环境变量 STORAGE_ENCRYPTION_KEY 保护)
-- Worker 运行时仅在内存中即刻解密验签/签发，绝不将私钥明文或密文写入边缘分布式 KV
CREATE TABLE IF NOT EXISTS crypto_keys (
    kid TEXT PRIMARY KEY,                      -- 密钥版本标识 (ULID)，如 "kid_01J8X9N4K1L2M3N4P5Q6R7S8T9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    product_id TEXT NOT NULL,                  -- 所属产品 products(id)
    algorithm TEXT NOT NULL DEFAULT 'Ed25519', -- 签名算法，默认 Ed25519
    source TEXT NOT NULL DEFAULT 'platform',   -- 密钥来源: 'platform' (系统自动代生成) | 'uploaded' (自主上传私钥)
    public_key TEXT NOT NULL,                  -- Base64 编码的 32 字节 Ed25519 公钥 (用于客户端离线验签)
    key_material TEXT NOT NULL,                -- AES-256-GCM 密文 (Base64: nonce 12B + ciphertext 32B + tag 16B)
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否是当前活跃签发密钥
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_crypto_keys_account_product ON crypto_keys(account_id, product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_keys_active_product 
ON crypto_keys(product_id) 
WHERE is_active = TRUE;

-- 6. 授权策略模板表 (Policies - 授权策略规则引擎)
CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,                       -- 策略全局唯一 ID (ULID)，如 "pol_01J8X9N5U1V2W3X4Y5Z6A7B8C9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    product_id TEXT NOT NULL,                  -- 所属产品 products(id)
    name TEXT NOT NULL,                        -- 策略名称，如 "Professional Annual (3 Seats)"
    duration INTEGER,                          -- 商业授权有效期秒数 (NULL 表示买断制永久有效，如 31536000 为 1 年)
    offline_grace_period INTEGER NOT NULL DEFAULT 2592000, -- 网络离线验签宽限期秒数 (默认 30 天，买断/订阅均受此约束)
    max_machines INTEGER NOT NULL DEFAULT 1,   -- 允许同时激活的最大机器设备数
    floating BOOLEAN NOT NULL DEFAULT FALSE,   -- 【一期预留字段】是否为浮动席位 (一期仅支持固定绑定席位)
    strict BOOLEAN NOT NULL DEFAULT TRUE,      -- 是否严格限制 (超限时激活直接抛出 409 错误)
    scheme TEXT NOT NULL DEFAULT 'ed25519',    -- 授权模式: 'ed25519' (非对称离线签名Token) | 'guid' (在线不加密GUID核验)
    features JSON NOT NULL DEFAULT '[]',       -- 开启的功能特性列表，如 ["4k_export", "cloud_sync"]
    metadata JSON NOT NULL DEFAULT '{}',       -- 自定义业务元数据 (可记录 stripe_price_id 等支付网关映射)
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否处于启用状态
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_policies_account_id ON policies(account_id);
CREATE INDEX IF NOT EXISTS idx_policies_product_id ON policies(product_id);

-- 7. 核心许可证凭据表 (Licenses)
CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,                       -- 内部全局唯一 UUID/ULID，如 "lic_01J8X9N6D1E2F3G4H5I6J7K8L9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    product_id TEXT NOT NULL,                  -- 所属产品 products(id)
    policy_id TEXT NOT NULL,                   -- 关联策略 policies(id)
    key TEXT UNIQUE NOT NULL COLLATE NOCASE,   -- 对外商业激活码，如 "SCR-8820-ABCD-9901" 或 GUID
    customer_email TEXT COLLATE NOCASE,        -- 归属买家邮箱 (可为 NULL，批量预制发码或无邮箱分发场景)
    source TEXT NOT NULL DEFAULT 'manual',     -- 发码来源: 'manual' (手动/批量) | 'api' | 'paddle' | 'stripe' | 'lemonsqueezy'
    status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'suspended' | 'expired' | 'revoked'
    revoke_reason TEXT,                        -- 吊销原因 (如 'EXPIRED_30_DAYS_UNUSED' 或管理员自定义备注)
    metadata JSON NOT NULL DEFAULT '{}',       -- 外部交易引用，如 {"stripe_customer_id":"cus_123","paddle_txn_id":"txn_456"}
    expires_at TIMESTAMP,                     -- 绝对到期时间 (买断制为 NULL)
    suspended_at TIMESTAMP,                   -- 挂起时间 (如扣费失败时暂停使用)
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_licenses_account_id ON licenses(account_id);
CREATE INDEX IF NOT EXISTS idx_licenses_product_policy ON licenses(product_id, policy_id);
CREATE INDEX IF NOT EXISTS idx_licenses_customer_email ON licenses(customer_email);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_source_status ON licenses(account_id, source, status);
CREATE INDEX IF NOT EXISTS idx_licenses_created_at ON licenses(created_at DESC);

-- 8. 硬件设备席位绑定表 (Machines - 硬件设备席位绑定)
CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,                       -- 机器记录全局标识，如 "mac_01J8X9N7M1N2P3Q4R5S6T7U8V9"
    license_id TEXT NOT NULL,                  -- 关联许可证 licenses(id)
    fingerprint TEXT NOT NULL,                 -- 硬件唯一指纹哈希 (CPU+主板+网卡哈希)
    name TEXT,                                 -- 机器可读名称，如 "MacBook Pro 16"
    platform TEXT,                             -- 操作系统与平台，如 "darwin-arm64", "win32-x64"
    ip TEXT,                                   -- 首次激活 IP 地址 (仅用于审计排查，不频繁刷写)
    last_heartbeat_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), -- 最近在线探活时间
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_machines_license_id ON machines(license_id);
CREATE INDEX IF NOT EXISTS idx_machines_fingerprint ON machines(fingerprint);

-- 单张许可证下，同一机器指纹全局唯一（防重复占座）
CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_license_fingerprint 
ON machines(license_id, fingerprint);

-- 9. 试用认领防刷锁定表 (Product Trials - 单表单行极速防刷闭环，零污染 licenses)
CREATE TABLE IF NOT EXISTS product_trials (
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    product_id TEXT NOT NULL,                  -- 所属产品 products(id)
    fingerprint TEXT NOT NULL,                 -- 机器硬件唯一指纹哈希
    claimed_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at TIMESTAMP NOT NULL,             -- 试用到期时间
    PRIMARY KEY (account_id, product_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_product_trials_account ON product_trials(account_id);

-- 10. 出向事件广播端点配置表 (Webhook Endpoints - 出向事件广播端点)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,                       -- 端点标识，如 "whe_01J8X9N8W1X2Y3Z4A5B6C7D8E9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    product_id TEXT NOT NULL,                  -- 所属产品 products(id)
    url TEXT NOT NULL,                         -- 开发者接收事件的公网 URL (如 https://api.mysite.com/webhooks)
    secret TEXT NOT NULL,                      -- 用于 HMAC-SHA256 签名的共享秘钥 (发送至 X-LicenKit-Signature)
    events JSON NOT NULL DEFAULT '["*"]',      -- 监听的事件类型列表，如 ["license.created", "license.suspended", "machine.created"]
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否启用
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_account ON webhook_endpoints(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_product ON webhook_endpoints(product_id);

-- 11. 双向事件出入收件与投递审计表 (Webhook Events)
-- 包含入向支付幂等去重 (inbound) 与出向事件派发审计 (outbound)
CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,                       -- 流水全局 ID，如 "evt_01J8X9N9F1G2H3I4J5K6L7M8N9"
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    provider TEXT NOT NULL,                    -- 事件来源/渠道: 'stripe' | 'paddle' | 'lemonsqueezy' | 'custom' | 'internal'
    direction TEXT NOT NULL,                   -- 'inbound' (支付网关回调) | 'outbound' (向开发者广播事件)
    endpoint_id TEXT,                          -- 仅 outbound 有效: 关联 webhook_endpoints(id)
    event_id TEXT,                             -- 仅 inbound 有效: 第三方网关事件唯一 ID (防重)；outbound 固定为 NULL
    event_type TEXT NOT NULL,                  -- 事件类型名 (如 "transaction.completed" 或 "license.created")
    payload TEXT NOT NULL,                     -- 完整 JSON 报文
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'processed' | 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,       -- 投递或重试次数
    last_error TEXT,                           -- 报错信息
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    processed_at TIMESTAMP                     -- 处理完成时间
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_account ON webhook_events(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_dir_status ON webhook_events(direction, status, created_at DESC);

-- 入向网关回调精确幂等去重索引 (按租户 + 渠道 + 事件ID)
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_inbound_dedup 
ON webhook_events(account_id, provider, event_id) 
WHERE direction = 'inbound';

-- 12. 管理员细粒度操作审计流水表 (Audit Logs)
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,                       -- 审计日志全局 ID，如 "aud_01J8X9N9..."
    account_id TEXT NOT NULL,                  -- 所属租户 accounts(id)
    user_id TEXT NOT NULL,                     -- 操作员 users(id)
    user_email TEXT NOT NULL,                  -- 操作员邮箱快照
    action TEXT NOT NULL,                      -- 操作动作 (如 "license.create", "license.revoke")
    resource_type TEXT NOT NULL,               -- 目标资源类型 (如 "license", "product", "policy", "user", "settings", "webhook", "auth")
    resource_id TEXT,                          -- 目标资源标识 (如 "lic_01J...", "prd_01J...")
    details TEXT NOT NULL DEFAULT '{}',        -- 结构化操作详情/快照 JSON (脱敏)
    ip TEXT,                                   -- 操作员客户端 IP 地址
    user_agent TEXT,                           -- 操作员客户端 User-Agent
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_account_created ON audit_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(account_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(account_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(account_id, resource_type, resource_id);

