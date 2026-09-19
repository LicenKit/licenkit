# V1 API 合同

## 1. 范围

本文档定义接口边界和关键语义，不冻结所有字段。开发阶段可以补充分页和展示字段，但不得改变领域不变量。

接口分为六组：

| 接口 | 调用方 | 鉴权 |
| --- | --- | --- |
| Initial Setup API | 独立部署首次安装 | `INITIAL_SETUP_TOKEN`，且数据库必须未初始化 |
| Admin API | 管理控制台和自动化工具 | 管理员 Session |
| Customer Portal API | 客户授权中心 | Magic Link 与 Customer Session |
| Client API | 集成 LicenKit SDK 的 App | 注册码或机器令牌 |
| Payment Inbound Webhook | 支付平台 | 渠道原始请求签名 |
| Outbound Webhook | LicenKit 主动调用客户系统 | LicenKit HMAC 签名 |

## 2. 通用响应

成功：

```json
{
  "success": true,
  "data": {}
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "LICENSE_ACTIVATION_LIMIT_REACHED",
    "message": "The license has reached its activation limit.",
    "details": {
      "license_id": "lic_01...",
      "active_activations": 3,
      "max_activations": 3
    },
    "request_id": "req_01..."
  }
}
```

API 错误不得丢弃上游来源。支付和出站投递错误在管理接口中应返回 provider、external event ID、Delivery ID、HTTP 状态及脱敏后的原始错误。

## 3. Initial Setup API

Setup 只服务独立部署的首次安装，不是公开注册或 Cloud Account API。

```text
GET  /api/v1/setup/status
POST /api/v1/setup
```

Setup 页面至少包含实例/初始 Account 名称，以及管理员姓名、邮箱和密码。提交示例：

```json
{
  "setupToken": "one-time-secret-from-deployment",
  "instanceName": "Example Studio Licensing",
  "accountSlug": "example-studio",
  "owner": {
    "name": "Alex",
    "email": "alex@example.com",
    "password": "user-entered-password"
  }
}
```

`setupToken` 与部署 Secret `INITIAL_SETUP_TOKEN` 常量时间比较，不进入 URL、日志、审计详情或错误回显。管理员密码执行与正常登录一致的长度校验和密码 KDF，只保存 Hash。接口按来源限流并验证同源。服务端只有在 `system_settings`、Account 和 User 均为空时，才通过一个 D1 原子批次创建 `system_settings(id='current')`、首个 Account、首位 `owner` User 和管理员 Session。

并发请求只能有一个成功；唯一约束失败不得留下半初始化数据。成功响应设置管理员 Session Cookie。初始化完成后，GET 返回 `initialized=true`，POST 固定返回 `SETUP_ALREADY_COMPLETED`，即使环境中仍保留 Setup Secret 也不能再次初始化。V1 不暴露创建第二个 Account 的公开或管理 API；未来 Cloud 只复用内部 Account Provisioning 边界。

## 4. Admin API

### 4.1 管理员会话与默认拒绝授权

管理员登录必须提交 `accountSlug + email + password`。成功后设置 HttpOnly、Secure、SameSite=Lax 的 host-only Cookie；Cookie 携带账户选择器和随机 Session Token，服务端只保存 Token 哈希，并始终以 `account_id + token_hash` 查询。每个请求都重新检查 Account、User、Session 状态和当前角色，所有写请求验证同源。

```text
POST /api/v1/admin/auth/login
GET  /api/v1/admin/auth/session
POST /api/v1/admin/auth/logout

GET   /api/v1/admin/users
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/:userId
POST  /api/v1/admin/users/:userId/sessions/revoke
```

User 管理接口只允许 owner，并强制使用当前 Session 的 Account。首个 Owner 只由 Setup 创建；V1 不实现 Cloud Account 创建、公开管理员注册或 Cloud Adapter。

每条 Admin 路由必须声明一个权限；未声明权限、角色不在允许集合、资源不属于当前 Account 时一律拒绝。V1 权限矩阵如下：

| 能力 | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| 读取本账户非 Secret 数据 | 允许 | 允许 | 允许 | 允许 |
| Account、User、角色与 Session 管理 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Product、Release、签名密钥 | 允许 | 允许 | 拒绝 | 拒绝 |
| License Plan、Billing Provider、Offer | 允许 | 允许 | 拒绝 | 拒绝 |
| Outbound Endpoint 与 Secret 轮换 | 允许 | 允许 | 拒绝 | 拒绝 |
| Activation 释放等低风险支持操作 | 允许 | 允许 | 允许 | 拒绝 |
| License 签发、找回、安全重置、暂停与吊销 | 允许 | 允许 | 拒绝 | 拒绝 |
| Customer 身份字段与状态修改 | 允许 | 允许 | 拒绝 | 拒绝 |
| License Terms 批量迁移 | 允许 | 允许 | 拒绝 | 拒绝 |
| Inbound Event replay、Delivery retry | 允许 | 允许 | 拒绝 | 拒绝 |
| 审计与诊断读取 | 允许 | 允许 | 仅本人操作结果 | 只读脱敏摘要 |

`owner` 不能删除或降级账户中最后一个 active Owner。权限判断从服务端路由元数据和当前 Session 得出，不能接受请求体传入角色。所有资源查询都从 Session 取得 `account_id` 并写入数据库条件；路径中的资源 ID 不能替代租户条件。

### 4.2 Product

```text
GET    /api/v1/admin/products
POST   /api/v1/admin/products
GET    /api/v1/admin/products/:productId
PATCH  /api/v1/admin/products/:productId
POST   /api/v1/admin/products/:productId/archive
```

产品归档不影响已有 License。

### 4.3 Product Release

```text
GET    /api/v1/admin/products/:productId/releases
POST   /api/v1/admin/products/:productId/releases
GET    /api/v1/admin/products/:productId/releases/:releaseId
PATCH  /api/v1/admin/products/:productId/releases/:releaseId
```

创建请求：

```json
{
  "version": "2.4.0",
  "platform": "macos-universal",
  "description": "Performance and stability update",
  "downloadUrl": "https://downloads.example.com/app-2.4.0-universal.dmg",
  "artifactSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "releasedAt": "2026-09-19T10:00:00Z"
}
```

`description` 和 `downloadUrl` 可空，`artifactSha256` 必填。`version + platform` 在 Product 内唯一。创建后 `version`、`platform`、`artifactSha256` 和 `releasedAt` 不允许 PATCH；说明与下载地址可以修改。若二进制或 Hash 变化，创建新的 Release，不能覆盖已有发布事实。

Release API 只允许 owner/admin。发布日期由受信管理或发布流程写入；Client API 不接受该字段。

### 4.4 License Plan

旧 `/policies` 路径不进入 V1。

```text
GET    /api/v1/admin/license-plans
POST   /api/v1/admin/license-plans
GET    /api/v1/admin/license-plans/:planId
PATCH  /api/v1/admin/license-plans/:planId
POST   /api/v1/admin/license-plans/:planId/archive
POST   /api/v1/admin/license-plans/:planId/migrations/preview
POST   /api/v1/admin/license-plans/:planId/migrations
```

创建请求示例：

```json
{
  "productId": "prd_01...",
  "name": "Pro Lifetime with 1 Year Updates",
  "licenseModel": "perpetual",
  "credentialMode": "signed",
  "maxActivations": 3,
  "features": ["pro_export", "batch_processing"],
  "updateWindowSeconds": 31536000,
  "signedTokenTtlSeconds": 2592000,
  "paymentGraceSeconds": 0
}
```

- `licenseModel` 描述有效期生命周期：永久、固定期限或随订阅周期更新；
- `credentialMode` 不描述是否联网。`opaque` 只签发 Machine Token，`signed` 在相同在线流程上额外签发 Signed License Token；
- `updateWindowSeconds` 只适用于 `perpetual`；`null` 表示所有未来版本，正整数表示签发后的版本更新窗口；
- `credentialMode=opaque` 时 `signedTokenTtlSeconds` 必须为 0，`signed` 时必须大于 0。

更新成功后 revision 递增。响应需要明确：

```json
{
  "revision": 4,
  "affectsExistingLicenses": false
}
```

### 4.5 License

```text
GET    /api/v1/admin/licenses
POST   /api/v1/admin/licenses
GET    /api/v1/admin/licenses/:licenseId
PATCH  /api/v1/admin/licenses/:licenseId
POST   /api/v1/admin/licenses/:licenseId/suspend
POST   /api/v1/admin/licenses/:licenseId/reinstate
POST   /api/v1/admin/licenses/:licenseId/revoke
POST   /api/v1/admin/licenses/:licenseId/recover-key
POST   /api/v1/admin/licenses/:licenseId/security-reset
POST   /api/v1/admin/licenses/:licenseId/extend-updates
GET    /api/v1/admin/licenses/:licenseId/activations
POST   /api/v1/admin/licenses/:licenseId/activations/:activationId/revoke
```

手动签发请求：

```json
{
  "licensePlanId": "lpl_01...",
  "customerEmail": "buyer@example.com",
  "delivery": {
    "sendNotification": true
  }
}
```

`customerEmail` 为必填字段。服务端使用统一规范化规则查找或创建 Customer，再把 License 写入该 `customer_id`；客户端不能直接提交任意 Customer ID 绕过账户归属检查。

成功响应可以返回一次注册码，但 API 必须同时返回通知状态：

```json
{
  "license": {
    "id": "lic_01...",
    "licenseKey": "LK-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX",
    "status": "active",
    "updatesUntil": "2027-09-19T10:00:00Z"
  },
  "delivery": {
    "id": "dly_01...",
    "status": "pending"
  }
}
```

#### 普通找回

```text
POST /api/v1/admin/licenses/:licenseId/recover-key
```

语义：轮换注册码、保留 active Activation、创建新的找回通知 Delivery。

#### 安全重置

```text
POST /api/v1/admin/licenses/:licenseId/security-reset
```

语义：轮换注册码、吊销全部 active Activation、创建新的安全重置通知 Delivery。

两者必须使用不同接口和审计动作，避免调用方通过一个模糊布尔值误清退设备。

#### 延长版本更新权益

```text
POST /api/v1/admin/licenses/:licenseId/extend-updates
```

请求传入新的绝对 `updatesUntil`；`null` 表示升级为不限制未来版本。该操作只适用于 `perpetual` License，新值不能早于当前值，不改变 `expires_at`、注册码或 Activation，并且必须记录前值、后值和原因。

### 4.6 Billing Provider

```text
GET    /api/v1/admin/billing/providers
POST   /api/v1/admin/billing/providers
PATCH  /api/v1/admin/billing/providers/:providerId
POST   /api/v1/admin/billing/providers/:providerId/test
```

测试接口只验证配置和签名样本能力，不创建 License。

Webhook Secret 与可选的支付平台 API Secret 分开配置。API Secret 只用于 Adapter 创建支付平台托管客户门户会话。Secret 写入后只返回是否已配置和掩码，不返回密文或明文。

### 4.7 Offer Mapping

```text
GET    /api/v1/admin/billing/offers
POST   /api/v1/admin/billing/offers
PATCH  /api/v1/admin/billing/offers/:offerId
POST   /api/v1/admin/billing/offers/:offerId/archive
```

创建请求示例：

```json
{
  "billingProviderId": "bpr_01...",
  "externalPriceId": "pri_01...",
  "productId": "prd_01...",
  "licensePlanId": "lpl_01...",
  "purchaseType": "subscription"
}
```

### 4.8 Subscription 与 Inbound Event

```text
GET   /api/v1/admin/billing/subscriptions
GET   /api/v1/admin/billing/subscriptions/:subscriptionId
GET   /api/v1/admin/billing/events
GET   /api/v1/admin/billing/events/:eventId
POST  /api/v1/admin/billing/events/:eventId/replay
```

Replay 重新执行同一持久化事件，不能跳过事件唯一约束，也不能复制为新事件规避幂等。

### 4.9 Outbound Endpoint

```text
GET    /api/v1/admin/outbound/endpoints
POST   /api/v1/admin/outbound/endpoints
PATCH  /api/v1/admin/outbound/endpoints/:endpointId
POST   /api/v1/admin/outbound/endpoints/:endpointId/test
POST   /api/v1/admin/outbound/endpoints/:endpointId/rotate-secret
POST   /api/v1/admin/outbound/endpoints/:endpointId/disable
```

通知 Webhook 配置示例：

```json
{
  "endpointType": "notification_gateway",
  "url": "https://merchant.example.com/hooks/licenkit-notifications",
  "subscribedEvents": [
    "customer.license_issued",
    "customer.license_recovered",
    "customer.license_security_reset",
    "customer.portal_access_requested"
  ],
  "timeoutMs": 10000,
  "maxAttempts": 8
}
```

创建或轮换时，签名 Secret 只返回一次。已有 Delivery 继续使用创建时固化的目标 URL 和加密 Secret，轮换只影响新 Delivery。

创建、修改和 Endpoint Test 使用同一 URL 策略：V1 只允许公网 HTTPS，拒绝 URL credentials、非标准端口、IP literal、localhost、私网、链路本地和云元数据目标。HTTP 重定向必须逐跳手动验证；任一目标不合规则返回 `OUTBOUND_ENDPOINT_NOT_PUBLIC`，不得发起请求。V1 不提供私网例外或 allowlist。

### 4.10 Outbound Delivery

```text
GET   /api/v1/admin/outbound/deliveries
GET   /api/v1/admin/outbound/deliveries/:deliveryId
POST  /api/v1/admin/outbound/deliveries/:deliveryId/retry
```

`retry` 只适用于仍保留加密负载的失败 Delivery。它不会轮换注册码，也不会新建逻辑消息。

如果负载已经清理，接口返回 `DELIVERY_PAYLOAD_EXPIRED`，调用方需要执行 `recover-key`。

### 4.11 Customer

```text
GET    /api/v1/admin/customers
GET    /api/v1/admin/customers/:customerId
PATCH  /api/v1/admin/customers/:customerId
POST   /api/v1/admin/customers/:customerId/disable
POST   /api/v1/admin/customers/:customerId/enable
POST   /api/v1/admin/customers/:customerId/sessions/revoke
```

V1 不提供 Customer 自助修改邮箱。管理员修改 Customer 邮箱时必须规范化、检查同账户唯一约束并写入审计；目标邮箱已属于另一个 Customer 时返回冲突，不自动合并。修改邮箱或禁用 Customer 必须同时吊销未消费 Magic Link 和现有 Customer Session，但不自动暂停或吊销其 License。

## 5. Customer Portal API

### 5.1 请求 Magic Link

```text
POST /api/v1/customer/auth/magic-link
```

```json
{
  "accountSlug": "example-studio",
  "email": "buyer@example.com"
}
```

无论是否存在匹配的 active Customer，公开响应都保持一致并使用 `Cache-Control: no-store`：

```json
{
  "success": true,
  "data": {
    "accepted": true
  }
}
```

有效 Customer 会在一个事务中吊销此前未消费 Challenge、停止其尚未完成的 Delivery，然后创建默认 15 分钟有效的 Login Challenge 和 `customer.portal_access_requested` Notification Delivery；无匹配 Customer 时不创建 Customer、Challenge 或 Delivery。接口必须按账户、规范化邮箱和来源 IP 限流，响应不能包含 Customer ID、Challenge ID 或是否已发送邮件。存在和不存在两个分支使用相同的最短响应时间策略和小幅随机抖动，避免稳定时差成为邮箱枚举信号。

通知中的 URL 使用账户路径与 Fragment 携带 Token，例如 `https://license.example.com/customer/example-studio/auth#token=...`。落地页不得加载第三方资源，设置 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`，并使用只允许同源脚本、样式、连接和表单的严格 Content Security Policy。页面读取 Token 后立即用 `history.replaceState` 清除 Fragment。GET 或页面加载不得消费 Challenge；用户显式点击“继续登录”后才发起消费 POST，避免邮件扫描器提前消费。

### 5.2 消费 Magic Link

```text
POST /api/v1/customer/auth/magic-link/consume
```

```json
{
  "accountSlug": "example-studio",
  "token": "mlk_..."
}
```

服务端对 Token 计算哈希，通过条件写入保证 Challenge 未消费、未吊销且未过期，并在同一原子批次中写入 `consumed_at` 和与该 Challenge 唯一绑定的 Customer Session。并发消费最多一个请求成功。

服务端先以 `accountSlug` 找到 Account，再用 `account_id + token_hash` 查询 Challenge。成功响应创建默认 7 天有效的服务端 Session，并设置 HttpOnly、Secure、SameSite=Lax 的 host-only Cookie；Cookie 携带账户选择器和随机会话 Token，不在 JSON 中返回 Token。后续会话也按 `account_id + session_token_hash` 查询。过期、已消费、已吊销、无效 Token 或 disabled Customer 返回统一的 `CUSTOMER_MAGIC_LINK_INVALID`，不能暴露具体匹配状态。

```text
POST /api/v1/customer/auth/logout
```

退出时吊销服务端 Customer Session 并清除 Cookie。所有 Customer 写接口必须验证同源请求。

### 5.3 当前 Customer 与 License

```text
GET /api/v1/customer/me
GET /api/v1/customer/licenses
GET /api/v1/customer/licenses/:licenseId
GET /api/v1/customer/licenses/:licenseId/activations
GET /api/v1/customer/licenses/:licenseId/subscription
```

所有查询必须在持久层同时限定当前 `account_id + customer_id`。对不属于当前 Customer 的资源统一返回资源不存在，不能通过 ID 枚举其他 Customer 的 License 或 Activation。

Customer 响应不返回注册码哈希、机器令牌哈希、支付 Secret、支付事件原文或内部敏感 Delivery 负载。

### 5.4 释放设备

```text
POST /api/v1/customer/licenses/:licenseId/activations/:activationId/deactivate
```

只允许操作当前 Customer License 下的 active Activation，并要求最近认证。成功后状态变为 `deactivated` 并写入 Customer 审计；历史记录不删除。该接口不能吊销 License，也不能操作其他 Activation。

### 5.5 找回与安全重置

```text
POST /api/v1/customer/licenses/:licenseId/recover-key
POST /api/v1/customer/licenses/:licenseId/security-reset
```

- `recover-key`：轮换注册码，保留 active Activation；
- `security-reset`：轮换注册码并吊销全部 active Activation。

两个接口成功后必须在最近认证页面一次性返回新注册码，并同时创建对应 Notification Delivery；响应必须包含 `Cache-Control: no-store`，前端不得持久化或发送分析事件。后续 HTTP 投递失败不能回滚已经成功提交的注册码轮换，但必须返回独立通知状态供页面展示。

两个接口都要求最近 15 分钟内完成认证。超出配置窗口时返回 `CUSTOMER_RECENT_AUTH_REQUIRED`，前端只能引导客户请求新 Magic Link，不能通过确认弹窗代替重新认证。

Customer 不能通过 Customer API 暂停、恢复、吊销 License，不能修改 License Terms、`expiresAt` 或 `updatesUntil`。

### 5.6 进入支付平台管理订阅

```text
POST /api/v1/customer/licenses/:licenseId/subscription/portal-session
```

服务端校验最近认证，并在持久层同时校验当前 Account、Customer、License、Billing Subscription 和 Billing Provider 归属，然后由对应 Billing Adapter 创建短期支付平台客户门户会话：

```json
{
  "success": true,
  "data": {
    "url": "https://payments.example.com/customer-portal/...",
    "expiresAt": "2026-09-19T10:15:00Z"
  }
}
```

该接口只返回支付平台托管 URL，不修改本地 Subscription 或 License。支付平台操作完成后，本地状态仍由后续已验签 Webhook 更新。

缺少 API Secret、外部 Customer ID 或 provider 不支持客户门户时返回明确配置错误，例如 `BILLING_CUSTOMER_PORTAL_NOT_CONFIGURED` 或 `BILLING_CUSTOMER_PORTAL_UNSUPPORTED`，并在内部保留 provider 原始错误。

## 6. Client API

### 6.1 激活

```text
POST /api/v1/client/activate
```

请求：

```json
{
  "account_id": "acc_01...",
  "product_id": "prd_01...",
  "license_key": "LK-...",
  "fingerprint": "sha256:...",
  "device_platform": "macos-arm64",
  "name": "Alex's MacBook Pro",
  "release_version": "2.4.0",
  "release_platform": "macos-universal"
}
```

`opaque` 凭证模式响应：

```json
{
  "success": true,
  "data": {
    "activation_id": "act_01...",
    "machine_token": "mtk_...",
    "credential_mode": "opaque",
    "signed_license_token": null,
    "license_expires_at": null,
    "terms": {
      "max_activations": 3,
      "features": ["pro_export"],
      "updates_until": "2027-09-19T10:00:00Z"
    }
  }
}
```

`signed` 凭证模式额外返回：

```json
{
  "credential_mode": "signed",
  "signed_license_token": "base64url.base64url.base64url",
  "signed_license_token_expires_at": "2026-10-19T10:00:00Z",
  "signing_key_id": "key_01..."
}
```

### 6.2 在线验证

```text
POST /api/v1/client/validate
```

请求必须包含 `activation_id`、`machine_token`、`fingerprint`、`release_version` 和 `release_platform`。设备平台与发布工件平台分开；两种凭证模式都调用该在线接口，`signed` 模式验证成功时可以刷新 Signed License Token，`opaque` 模式不返回 Signed License Token。

激活和在线校验都必须携带 App 内置的版本标识和平台。服务端在当前 Account 与 Product 下查找受信 Product Release；查不到时返回 `PRODUCT_RELEASE_UNKNOWN`。对受版本期限约束的永久 License，受信 `released_at > updates_until` 返回 `UPDATE_ENTITLEMENT_REQUIRED`；该错误不改变 License 状态，也不能转换成 `LICENSE_EXPIRED`。

### 6.3 主动解绑

```text
POST /api/v1/client/deactivate
```

服务端成功后 Activation 进入 `deactivated`。网络失败时 SDK 不能假装远端已经释放席位；本地是否清理凭证由 SDK 合同定义。

### 6.4 公钥集合

```text
GET /api/v1/client/products/:productId/signing-keys
```

该接口用于诊断和密钥轮换信息发布，不能替代 App 内置的信任根。响应包含 key ID、状态和公钥，不包含私钥。

## 7. Payment Inbound Webhook

```text
POST /api/v1/webhooks/payments/:accountSlug/:billingProviderId
```

处理顺序固定为：

1. 根据 accountSlug 解析 Account，再以 `account_id + billingProviderId` 读取唯一 provider 和 environment 配置；
2. 对原始请求体执行渠道签名验证；
3. 提取稳定的外部事件 ID；
4. 尝试写入 Inbound Event；
5. 重复事件返回已有接收结果；
6. 新事件持久化成功后返回 2xx；
7. 请求后立即尝试履约以降低延迟；
8. 即时处理未完成时，由 Scheduled Worker 根据同一条 Inbound Event 恢复。

Billing Provider ID 只用于路由配置，不能替代验签，也不从请求体接受 `account_id`。所有 provider，包括 custom Adapter，都必须验签。没有签名配置时返回配置错误，不得继续处理。

## 8. Notification Webhook

LicenKit 向客户系统发送：

```http
POST /hooks/licenkit-notifications
Content-Type: application/json
X-LicenKit-Delivery: dly_01...
X-LicenKit-Timestamp: 1789783200
X-LicenKit-Signature: v1=...
```

接收方必须：

- 使用原始请求体验签；
- 拒绝超出允许时间窗口的请求；
- 按 Delivery ID 幂等；
- 只有在已经可靠接管发送任务后才返回 2xx；
- 返回非 2xx 时提供可诊断但不含 Secret 的错误响应。

这是一套供应商无关合同。接收方可以在内部调用 Resend、Postmark、AWS SES、SMTP 或自建服务，但这些实现不属于 LicenKit。

Notification Gateway 还需要处理 `customer.portal_access_requested`。该事件携带一次性 Magic Link，必须按敏感负载处理；接收方不能把完整 URL 写入普通日志。

## 9. 业务事件 Webhook

业务事件使用同一签名头，但不包含发码明文，典型事件包括：

- `license.issued`；
- `license.suspended`；
- `license.reinstated`；
- `license.revoked`；
- `activation.created`；
- `activation.deactivated`；
- `subscription.renewed`；
- `subscription.past_due`；
- `subscription.canceled`。

客户通知与业务事件是两类 Delivery，不能因为配置了通配业务事件端点就自动触发客户邮件。
