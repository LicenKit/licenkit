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
  "siteUrl": "https://licenses.example.com",
  "accountSlug": "example-studio",
  "owner": {
    "name": "Alex",
    "email": "alex@example.com",
    "password": "user-entered-password"
  }
}
```

`setupToken` 与部署 Secret `INITIAL_SETUP_TOKEN` 常量时间比较，不进入 URL、日志、审计详情或错误回显。管理员密码执行与正常登录一致的长度校验和密码 KDF，只保存 Hash。`appUrl` 取当前 Setup 请求的 Origin；`siteUrl` 由部署者显式填写，供邮件 Magic Link 和 Turnstile hostname 使用，当前必须与 `appUrl` 同源，且不能包含 credentials、query 或 fragment。Admin 地址固定由 `appUrl + /admin/` 派生，API 地址固定由 `appUrl + /api/v1` 派生，均不接受独立配置。接口验证精确同源；来源流量限制由部署时配置的 Cloudflare Zone 级 WAF Rate Limiting Rule 承担，应用不保存通用限流计数。服务端只有在 `system_settings`、Account 和 User 均为空时，才通过一个 D1 原子批次创建 `system_settings(id='current')`、首个 Account、首位 `owner` User 和管理员 Session。

并发请求只能有一个成功；唯一约束失败不得留下半初始化数据。成功响应设置管理员 Session Cookie。初始化完成后，GET 返回 `initialized=true`，POST 固定返回 `SETUP_ALREADY_COMPLETED`，即使环境中仍保留 Setup Secret 也不能再次初始化。V1 不暴露创建第二个 Account 的公开或管理 API；未来 Cloud 只复用内部 Account Provisioning 边界。

## 4. Admin API

### 4.1 管理员会话与默认拒绝授权

管理员登录必须提交 `accountSlug + email + password`。成功后设置 HttpOnly、Secure、SameSite=Lax 的 host-only Session Cookie，以及独立的 Secure、SameSite=Lax、host-only CSRF Cookie；后者允许同源前端读取。服务端只保存两者 Hash，并始终以 `account_id + session_token_hash` 查询 Session。每个请求都重新检查 Account、User、Session 状态和当前角色。除登录外，所有 Cookie 鉴权的 POST/PUT/PATCH/DELETE 同时要求精确 Origin、`X-CSRF-Token` Header 与 CSRF Cookie 常量时间相等，并确认 CSRF Token Hash 属于当前 Session；SameSite 只是附加保护。登录和 Setup 没有既有 Session，仍必须执行精确 Origin检查，并由部署层 Zone 级 WAF Rate Limiting Rules 保护；应用不引入 KV、Durable Object 或通用限流表。

```text
POST /api/v1/admin/auth/login
GET  /api/v1/admin/auth/session
POST /api/v1/admin/auth/logout

GET   /api/v1/admin/account
PATCH /api/v1/admin/account

GET   /api/v1/admin/users
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/:userId
POST  /api/v1/admin/users/:userId/sessions/revoke
```

User 管理接口只允许 owner，并强制使用当前 Session 的 Account。首个 Owner 只由 Setup 创建；V1 不实现 Cloud Account 创建、公开管理员注册或 Cloud Adapter。

Account 更新接口在 V1 只允许 owner。`defaultSubscriptionPaymentGraceSeconds` 初始为 `432000`（5 天）且必须是非负整数；修改后只影响之后创建且未显式填写宽限期的订阅授权方案，不追溯修改已有方案或 License。

每条 Admin 路由必须声明一个权限；未声明权限、角色不在允许集合、资源不属于当前 Account 时一律拒绝。V1 权限矩阵如下：

| 能力 | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| 读取本账户非 Secret 数据 | 允许 | 允许 | 允许 | 允许 |
| Account、User、角色与 Session 管理 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Product、Release、Trial Claim、签名密钥 | 允许 | 允许 | 拒绝 | 拒绝 |
| License Plan、Billing Provider、Billing Customer 对账、Offer | 允许 | 允许 | 拒绝 | 拒绝 |
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
GET    /api/v1/admin/products/:productId/trials
GET    /api/v1/admin/products/:productId/trials/:trialId
POST   /api/v1/admin/products/:productId/trials/:trialId/revoke
```

产品归档不影响已有 License。

Product 可以配置一组 V1 无需支付方式的设备试用规则：

```json
{
  "slug": "example-app",
  "name": "Example App",
  "billingEnvironment": "live",
  "trial": {
    "enabled": true,
    "durationSeconds": 1209600,
    "features": ["pro_export"]
  }
}
```

`slug` 在当前 Account 内唯一，只接受规范化的小写 URL-safe 值，用于管理端识别和自定义页面路由。`billingEnvironment` 可为 `sandbox|live|null`：`null` 表示普通支付事件不能签发正式 License；非空值是该 Product 唯一可签发正式支付 License 的环境。设置或切换环境时，服务端必须确认没有 active Offer，且不存在 `is_checkout_verification=0` 的支付 License；否则返回 `PRODUCT_BILLING_ENVIRONMENT_LOCKED`。验证 License 不锁定该字段，因为它永远不可激活。启用试用时 `durationSeconds` 必须显式提供正整数；V1 不使用隐式全局试用天数。修改 Product 的试用时长或功能只影响之后领取的 Trial Claim。

Trial Claim 查询和吊销只允许 owner/admin，并在持久层同时限定当前 `account_id + product_id + trial_id`。吊销请求必须提交非空 `reason`；操作幂等地写入 `revoked_at`、原因和管理员审计，不删除领取历史，也不允许通过“编辑到期时间”重置试用。Product 归档只阻止新领取，不隐式吊销已有 Claim。

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
- `credentialMode=opaque` 时 `signedTokenTtlSeconds` 必须为 0，`signed` 时必须大于 0；
- 非订阅方案的 `paymentGraceSeconds` 必须为 0；订阅方案省略该字段时，服务端读取当前 Account 默认值并把解析后的整数写入方案响应与数据库。

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
POST   /api/v1/admin/licenses/:licenseId/renew-term
GET    /api/v1/admin/licenses/:licenseId/activations
POST   /api/v1/admin/licenses/:licenseId/activations/:activationId/revoke
```

手动签发请求：

```json
{
  "licensePlanId": "lpl_01...",
  "customerEmail": "buyer@example.com",
  "expiresAt": null,
  "delivery": {
    "sendNotification": true
  }
}
```

`customerEmail` 为必填字段。服务端使用统一规范化规则查找或创建 Customer，再把 License 写入该 `customer_id`；客户端不能直接提交任意 Customer ID 绕过账户归属检查。

管理端和受信 API 可以签发三类 License：

- `perpetual`：`expiresAt` 必须省略或为 `null`，响应为 `renewalMode=none`；这是给朋友签发永久 License 的正确模型；
- `fixed_term`：`expiresAt` 必须省略，由服务端按方案的 `default_term_seconds` 计算，响应为 `renewalMode=none`；
- `subscription`：必须提交晚于当前时间的绝对 `expiresAt`，响应为 `renewalMode=manual`。

手动订阅不创建 Billing Subscription，且无论方案中的支付宽限期是多少，License 的 `paymentGraceSeconds` 都固化为 0。服务端不能接受请求直接传入 `renewalMode`、`paymentGraceSeconds` 或支付来源字段；这些字段由签发路径确定，避免调用方拼出相互矛盾的状态。

成功响应可以返回一次注册码，但 API 必须同时返回通知状态：

```json
{
  "license": {
    "id": "lic_01...",
    "licenseKey": "LK-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX",
    "status": "active",
    "licenseModel": "perpetual",
    "renewalMode": "none",
    "expiresAt": null,
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

#### 手动订阅续期

```text
POST /api/v1/admin/licenses/:licenseId/renew-term
```

```json
{
  "expiresAt": "2027-09-19T10:00:00Z",
  "reason": "Complimentary annual renewal"
}
```

该操作只接受 `license_model=subscription + renewal_mode=manual`。新的 `expiresAt` 必须晚于当前到期时间和当前时间；成功时只延长同一 License，保留注册码与 Activation，并记录前值、后值、原因、操作者和请求 ID。接口接收绝对时间，不接收“增加天数”；当重放值恰好等于当前 `expiresAt` 时返回当前结果而不再次延长，早于当前值才拒绝。`perpetual` 不需要续期，`fixed_term` 到期后的新授权策略不通过本接口伪装，`renewal_mode=billing` 只能由已验签支付事件推进。

### 4.6 Billing Provider

```text
GET    /api/v1/admin/billing/providers
POST   /api/v1/admin/billing/providers
PATCH  /api/v1/admin/billing/providers/:providerId
POST   /api/v1/admin/billing/providers/:providerId/test
```

测试接口只验证配置和签名样本能力，不创建 License。

Paddle Provider 配置三类互不替代的凭证：

- `clientSideToken`：必填、与 `sandbox|live` 环境匹配，作为公开字段返回给 Paddle.js；它不是 Secret；
- Webhook Secret：必填、加密保存，只用于验证原始 Paddle Webhook；
- Paddle API Key：可选、加密保存，只在启用服务器端 API 能力时需要；Get Customer/对账至少要求 `customer.read`，托管客户门户要求 `customer_portal_session.write`。

管理 API 返回 `clientSideToken` 的值或可用状态，但 Webhook Secret 与 API Key 写入后只返回是否已配置和掩码，不返回明文。基础购买、事件履约和发码不能要求 API Key；没有 API Key 时 Customer 映射通过 Webhook 收敛。

`provider` 和 `environment` 是连接身份，创建后不可 PATCH；切换 Sandbox/Live 必须创建另一条 Provider。PATCH 只允许轮换同一连接的 Client-side Token、Webhook Secret、可选 API Key 或修改状态。这样已有外部 Customer、Transaction、Subscription 和事件 ID 不会被重新解释到另一环境。

启用 Customer API 读穿后，LicenKit 服务端可以发起 Paddle Billing REST API 请求；它不是基础路径，也不是回调 Paddle Webhook：

```http
GET https://sandbox-api.paddle.com/customers/{customer_id}  # sandbox
GET https://api.paddle.com/customers/{customer_id}          # live
Authorization: Bearer <decrypted Paddle API Key>
Accept: application/json
Paddle-Version: 1
```

`customer_id` 必须来自已验签 Paddle 事件中的 `data.customer_id`，并符合 Paddle `ctm_*` 标识格式；base URL 只由 Billing Provider 的 `environment` 决定，不能由请求体或 Customer ID 决定。Sandbox Provider 只能使用 Sandbox API Key 和 Sandbox base URL，Live Provider 只能使用 Live API Key 和 Live base URL。调用只发生在服务端，不能使用 Paddle.js Client-side Token，也不能把 API Key 返回浏览器。未配置 API Key 时跳过读穿并保持事件 `pending`，等待 Customer Webhook；不能把“缺少可选 API Key”转成 `needs_attention`。

成功响应使用 `data.id`、`data.email`、`data.name`、`data.status`、`data.created_at` 和 `data.updated_at` 进入统一 Billing Customer 同步服务，并保存 `meta.request_id` 用于诊断。处理规则固定为：

- `200`：校验响应 Customer ID 与请求一致后同步并重试当前履约；
- `401`、`403`：已启用的 API 读穿配置无效、过期或缺少权限。事件保持 `pending`，将 `BILLING_PROVIDER_API_AUTH_INVALID` 和字段级脱敏后的 `httpStatus + providerCode + requestId + message` 写入自己的 last error；同时按 Provider 与 `customer_read` 能力 upsert 一条 System Issue 并阻塞该事件。相同问题不重复建行，等待 Customer Webhook 或管理员修复；
- `404` 或返回 `status=archived`：外部 Customer 不可用于新履约，进入 `needs_attention`；
- `429`、`5xx`、网络超时：Inbound Event 保持 `pending`，保存 HTTP 状态、Paddle 错误码和 request ID 后退避重试。

V1 创建 Billing Provider 时只接受 `provider=paddle`，并分别配置 `sandbox` 或 `live`。其他 provider 返回 `BILLING_PROVIDER_UNSUPPORTED`；后续增加 Adapter 时保持相同 API 与领域合同。

### 4.7 Offer Mapping

```text
GET    /api/v1/admin/billing/offers
POST   /api/v1/admin/billing/offers
PATCH  /api/v1/admin/billing/offers/:offerId
POST   /api/v1/admin/billing/offers/:offerId/verification-config
POST   /api/v1/admin/billing/offers/:offerId/activate
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

创建响应的 `status` 固定为 `draft`。Offer 只有在 Billing Provider 环境等于 Product `billingEnvironment` 时才允许激活；不同环境的 draft Sandbox Offer 仍可用于管理员闭环验证，但不能签发正式 License。

PATCH 只允许修改尚无 Checkout Verification 的 draft Offer。只要存在任一验证尝试，Provider、Price、Product、Plan 和 `purchaseType` 即被锁定；需要改变映射时归档旧 Offer 并创建新 Offer，不能让旧验证证据跟随到新权益。

`verification-config` 使用 POST，因为每次调用都会创建一条短期、一次性的 Checkout Verification。它只允许 owner/admin 针对 draft Sandbox Offer 调用，响应设置 `Cache-Control: no-store`，并只返回打开这一次 Sandbox Checkout 所需的配置：

```json
{
  "verificationMode": true,
  "verificationToken": "vfy_一次性高熵随机值",
  "expiresAt": "2026-09-19T10:15:00Z",
  "checkout": {
    "provider": "paddle",
    "environment": "sandbox",
    "clientSideToken": "test_...",
    "priceId": "pri_01...",
    "quantity": 1
  }
}
```

服务端只保存 `verificationToken` 哈希；管理控制台不得写入日志、localStorage、分析事件或 URL。该 POST 还必须通过管理员 Session 权限、精确 Origin 和双提交 CSRF 校验。Admin 内部 Paddle.js 调用把令牌附加为 `custom_data.licenkit_checkout_verification`，调用方不能另行传入任意 custom data。该接口不允许 Live Offer、不公开到无鉴权路由，也不绕过一个 Price、数量 1、Webhook、Customer 解析、Fulfillment 或 Notification Gateway。令牌的权限只是在完全匹配的 Sandbox 交易中生成一条永久不可激活的验证 License，不授予正式权益。

`activate` 不接受调用方传入 `ready=true`；服务端实时执行 Checkout Readiness 检查并返回每项状态。至少包括 Product/Plan/Provider、Provider 环境等于 Product `billingEnvironment`、Client-side Token 的环境标识与 Provider 匹配、当前 Provider 配置更新时间之后最小 Paddle 事件合同中每一种事件的成功验签证据（通常由官方模拟器触发）、Notification Gateway 的 active 状态和当前配置之后的 accepted Endpoint Test、D1 `system_settings` 中未超过阈值的 Scheduled Worker 最近成功事实、`signed` 模式密钥，以及同一 Account、Product、License Plan 与 `purchaseType` 的 `billing_checkout_verifications.status=completed` 真实 Sandbox 证据。Sandbox Offer 通过 `verification-config` 产生该证据；Live Offer 可以复用对应 Sandbox 闭环证据，不执行真实扣款验证。任一必需项失败时返回 `BILLING_CHECKOUT_NOT_READY` 和管理端可见的具体检查项，不改变 Offer 状态。

PricePreview 不属于服务端 Offer 激活门禁，也不保存为 Readiness 证据。静态产品页可以直接显示源码中的价格，也可以自行调用 Paddle PricePreview；一次 Preview 成功不能证明未来页面、Origin 或 Paddle 状态仍然可用。服务端支付履约继续只信任已验签 Webhook，并精确校验 Offer、Price、数量、环境和 Customer 合同。

若 Paddle recurring price 配置了免费试用，V1 只支持要求 Checkout 预先收集支付方式的免费试用。试用天数和下一扣款时间以已验签 Paddle Subscription 为准，不复制到 Offer 或 Product Trial 配置；Offer 仍只负责把外部 Price 映射到 `subscription` License Plan。

### 4.8 Subscription 与 Inbound Event

```text
GET   /api/v1/admin/billing/customers
GET   /api/v1/admin/billing/customers/:billingCustomerId
POST  /api/v1/admin/billing/customers/:billingCustomerId/reconcile
GET   /api/v1/admin/billing/subscriptions
GET   /api/v1/admin/billing/subscriptions/:subscriptionId
GET   /api/v1/admin/billing/events
GET   /api/v1/admin/billing/events/:eventId
POST  /api/v1/admin/billing/events/:eventId/replay
GET   /api/v1/admin/billing/adjustments
GET   /api/v1/admin/billing/adjustments/:adjustmentId
POST  /api/v1/admin/billing/adjustments/:adjustmentId/resolve
GET   /api/v1/admin/system/issues
GET   /api/v1/admin/system/issues/:issueId
POST  /api/v1/admin/system/issues/:issueId/resolve
POST  /api/v1/admin/system/issues/:issueId/retry-affected-events
```

Billing Customer 详情展示 provider Customer ID、镜像邮箱、关联 Customer、`linkStatus` 和最后同步来源，但不返回服务端 API 凭证。只有 Provider 已配置相应 API Key 时才开放 `reconcile`；它使用服务器端凭证重新读取同一个外部 Customer ID，不接受调用方传入邮箱，也不自动修改或改绑 LicenKit Customer。未配置时返回 `BILLING_PROVIDER_API_CAPABILITY_DISABLED`，不影响 Webhook 驱动的购买履约。邮箱一致时可把映射恢复为 `linked`；仍不一致时保持 `email_mismatch`。

购买事件因 `BILLING_CUSTOMER_PENDING` 超时进入 `needs_attention` 时，管理响应给出外部 Customer ID、Provider 环境和来源事件引用，并建议管理员先在 Paddle Notification 日志重放 Customer 事件；若已配置 API Key，也可以 reconcile。修复后调用原 Event replay。接口不得提供“输入邮箱并继续履约”的旁路。

列表和详情必须以当前 Session 的 `account_id` 查询；详情、对账和支付履约都使用 `account_id + billing_provider_id + external_customer_id` 定位映射。API 不提供仅按外部 Customer ID 的全局查询，也不把 Paddle、未来其他平台或 sandbox/live 中相同字符串的 ID 视为同一身份。

Replay 重新执行同一持久化事件，不能跳过事件唯一约束，也不能复制为新事件规避幂等。重新排队时保留现有 `last_error_code + last_error_detail`，只有完整状态机产生成功结果或新的具体错误后才更新，避免在实际重试尚未发生时丢失最后一次可诊断事实。

System Issue 列表只返回当前账户的问题；默认先显示 open，再按 severity 与最近发生时间排序。详情返回 Issue 当前状态、Provider/能力、安全诊断、发生次数，以及通过 `system_issue_inbound_events` 关联的 Event 摘要。管理端不得根据 `last_error_detail_json` 拼接任意重试请求；服务端根据 `issue_code + capability` 决定唯一允许的验证与恢复策略。

“已修复”使用以下请求：

```json
{
  "resolutionNote": "Replaced the Paddle API key with customer.read permission.",
  "retryAffectedEvents": true,
  "expectedUpdatedAt": "2026-09-19T10:30:00Z"
}
```

提交前，界面必须根据详情接口返回的恢复预览提示：“当前关联 N 条事件，其中 M 条仍受阻且 payload 有效；是否在验证修复后重新处理这 M 条事件？”不能使用笼统的“自动重试所有错误”。`expectedUpdatedAt` 防止管理员基于已过期的问题详情提交操作。

服务端先用当前 Provider 配置执行该 capability 的最小验证。`customer_read` 使用 Paddle Customer 列表读取验证 API Key、环境与权限；`customer_portal_session` 使用该 Provider 下一个已有的 linked Billing Subscription 创建短期门户会话并立即丢弃 URL，只验证权限而不修改本地订阅。缺少这种安全上下文时不能用任意 Customer ID 猜测验证。再次 `401/403` 时 Issue 保持 open；`429/5xx` 或网络失败返回暂时无法确认，不写 resolved；成功后才写解决人、时间和说明。Customer 列表读取成功只证明当前 Key 能在配置环境使用 `customer.read`，不证明它必然属于原 Event 的正确 Paddle 商户；该事实必须在逐事件 Get Customer 时用原 Event 携带的 Customer ID 验证。若 `retryAffectedEvents=false`，只解决 System Issue，既有 Event 状态和错误完全不变。若为 `true`，只将当前仍被该 Issue 阻塞、状态为 `pending`、最近错误码仍匹配、payload 未到期的 Event 解除阻塞并设置为立即可调度；不清空 last error，不重置 attempt count。门户 capability 不接受 `retryAffectedEvents=true`，修复后仍由 Customer 发起新的短期会话请求。

已 resolved 的 `customer_read` Issue 仍可能留下两类受阻事件：管理员修复时主动选择暂不重试，或当时 payload 已过期、后来由相同 Event ID 与相同 payload Hash 的 Paddle 重投恢复。管理端可调用 `retry-affected-events` 并提交详情中的 `expectedUpdatedAt`；服务端不再次修改 Issue，只重新筛选当前仍被该 Issue 阻塞且 payload 有效的事件，解除阻塞并排回完整状态机。该动作不能用于门户 capability，也不能绕过已重新 open 或已经变化的 Issue。

```json
{
  "expectedUpdatedAt": "2026-09-19T10:31:00Z"
}
```

Scheduled Worker 对这些 Event 执行完整原始状态机，而不是直接调用发码：Billing Customer 已由 Webhook 补齐时跳过 API 读取；仍缺失时先 Get Customer 并进入统一同步服务；之后重新验证交易合同并依靠业务唯一键决定创建或关联既有 License、Subscription、Delivery。`404/archived`、身份冲突、`429/5xx`、再次 `401/403`、payload 过期和已完成业务结果分别按业务流程处理，不能由 System Issue 的 resolved 状态覆盖。

手动 Billing Customer reconcile 的 `401/403` 会 upsert 同一个 System Issue，但没有原始 Inbound Event，因此不创建虚假关联；恢复操作只允许重试 reconcile。`customer_portal_session` 的 `401/403` 使用独立 capability；管理员验证修复时生成并丢弃一个新的短期测试会话，旧门户请求和 URL 都不会重放或返回，修复后由 Customer 重新发起。

Adjustment 详情必须返回 provider、外部 Adjustment/Transaction/Subscription/Customer ID、原始 `action + type + status`、金额/币种、关联 License、自动影响、人工状态和来源事件。`resolve` 只允许 owner/admin，要求 `action` 为 `no_action|keep_suspended|reinstate|revoke|security_reset` 之一并提交非空原因。服务端根据当前 Adjustment 与 License 状态验证动作是否合法，在一个原子批次中更新 License/Activation、Adjustment 和审计；请求不能直接提交目标 License 状态。

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
  "maxAutomaticAttempts": 4
}
```

`maxAutomaticAttempts` 包含首次请求，因此默认 4 表示失败后自动重试 3 次。Endpoint 创建时可以显式调整 1 到 20，但凭证或负载到期仍会提前终止后续 Attempt。Delivery 创建时固化该值，Endpoint 后续修改不改变已有 Delivery。

创建或轮换时，签名 Secret 只返回一次。已有 Delivery 继续使用创建时固化的目标 URL 和加密 Secret，轮换只影响新 Delivery。

创建、修改和 Endpoint Test 使用同一 URL 策略：V1 只允许公网 HTTPS，拒绝 URL credentials、非标准端口、IP literal、localhost、私网、链路本地和云元数据目标。HTTP 重定向必须逐跳手动验证；任一目标不合规则返回 `OUTBOUND_ENDPOINT_NOT_PUBLIC`，不得发起请求。V1 不提供私网例外或 allowlist。

### 4.10 Outbound Delivery

```text
GET   /api/v1/admin/outbound/deliveries
GET   /api/v1/admin/outbound/deliveries/:deliveryId
POST  /api/v1/admin/outbound/deliveries/:deliveryId/retry
POST  /api/v1/admin/outbound/deliveries/:deliveryId/resume-after-configuration
```

`retry` 只适用于仍保留加密负载的 `failed` Delivery。每次调用只追加一个来源为 `manual_retry` 的 HTTP Attempt，不重置 `automaticAttemptCount`，也不启动新一轮自动重试；它不会轮换注册码或新建逻辑消息，并写入管理员审计。

`resume-after-configuration` 只适用于 `blocked_configuration`、负载未过期、尚未产生 HTTP Attempt 的 Delivery，并且当前 Notification Gateway 已 active 且最近 Endpoint Test 为 accepted。服务端在一个原子批次中绑定并固化当前 Endpoint URL 与 Secret、改为 `pending`、安排发送并写审计。它不能用于把失败的旧 Endpoint 偷换成新 Endpoint；已有 Attempt 的 Delivery 仍遵守其创建时快照和普通 retry 合同。

如果负载已经清理，接口返回 `DELIVERY_PAYLOAD_EXPIRED`，调用方需要执行 `recover-key`。

敏感负载默认最多保留 24 小时，并在 Delivery 创建时固化 `payloadExpiresAt`；Magic Link 使用 Challenge 的更早到期时间。Notification Gateway 返回 2xx 后立即清除负载，不能对 accepted Delivery 执行 retry。

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
  "email": "buyer@example.com",
  "turnstileToken": "一次性 Turnstile Token"
}
```

`turnstileToken` 最长 2048 字符。Worker 必须调用 Cloudflare Siteverify，并校验 `success=true`、`action=customer_magic_link`、返回 hostname 与 `system_settings.site_url` 的 hostname 一致。Turnstile Token 五分钟过期且只能验证一次；服务端对同一次 Siteverify 的短暂重试使用相同 idempotency key。缺失、无效、重复、过期、action/hostname 不匹配或无法确认时，在查询 Customer 前 fail-closed；Token、Secret 和完整 Siteverify 响应不进入日志、审计或 D1。

Siteverify 通过后、查询邮箱前，服务端先解析 Magic Link TTL/冷却配置，并对当前 Account 已通过 Endpoint Test 的 Notification Gateway 解密检查其签名 Secret。共享配置错误因此不会只在“邮箱存在”分支暴露；同一 Account 下已知和未知邮箱得到相同的失败边界。未配置或尚未通过测试的 Gateway 不是公开错误，后续只会为真实 Customer 创建 `blocked_configuration` Delivery。

无论是否存在匹配的 active Customer，公开响应都保持一致并使用 `Cache-Control: no-store`：

```json
{
  "success": true,
  "data": {
    "accepted": true
  }
}
```

Turnstile 验证成功后才查询 Customer。有效 Customer 使用 `customer_login_challenges(account_id, customer_id, created_at)` 检查默认 60 秒冷却：冷却命中时不创建 Challenge/Delivery，也不吊销仍有效的旧链接；冷却结束后，在一个 D1 原子批次中条件创建默认 15 分钟有效的 Login Challenge 和 `customer.portal_access_requested` Notification Delivery，并且只有新记录已创建才吊销此前未消费 Challenge、停止其尚未完成的 Delivery。无匹配 Customer 时不创建 Customer、Challenge、Delivery 或邮箱冷却记录。该流程不依赖 KV 或 Durable Object。

Turnstile 已通过、Customer 不存在、Customer 存在但命中冷却、成功创建新链接四个分支的公开响应保持相同，不包含 Customer ID、Challenge ID、冷却剩余时间或是否已发送邮件，并使用相同的缓存头、最短响应时间策略和小幅随机抖动。Magic Link 请求页可以加载 Turnstile 官方资源；携带 Magic Link Token 的 `/auth#token=...` 落地页仍不得加载任何第三方资源。

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

服务端先以 `accountSlug` 找到 Account，再用 `account_id + token_hash` 查询 Challenge。成功响应创建默认 7 天有效的服务端 Session，并设置 HttpOnly、Secure、SameSite=Lax 的 host-only Session Cookie，以及独立可读的 Secure、SameSite=Lax、host-only CSRF Cookie；服务端只保存两者 Hash。后续会话按 `account_id + session_token_hash` 查询，状态写入同时要求精确 Origin、`X-CSRF-Token` Header、CSRF Cookie 和当前 Session Hash 四者一致。过期、已消费、已吊销、无效 Token 或 disabled Customer 返回统一的 `CUSTOMER_MAGIC_LINK_INVALID`，不能暴露具体匹配状态。

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

`GET .../subscription` 对 `renewal_mode=manual` 返回发行方管理的到期时间且 `billingSubscription=null`；对 `renewal_mode=billing` 返回对应 Billing Subscription；`perpetual` 和 `fixed_term` 返回无订阅关系。客户端不得仅根据 `license_model=subscription` 假设一定存在支付门户。

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

该接口只适用于 `renewal_mode=billing`。手动订阅返回 `BILLING_SUBSCRIPTION_NOT_MANAGED`；永久或固定期限 License 返回资源不支持该操作。缺少服务端 API 凭证、外部 Customer ID 或 provider 不支持客户门户时返回明确配置错误，例如 `BILLING_CUSTOMER_PORTAL_NOT_CONFIGURED` 或 `BILLING_CUSTOMER_PORTAL_UNSUPPORTED`，并在内部保留 provider 原始错误。

## 6. 静态产品页不属于 LicenKit API

LicenKit 不提供 Public Checkout API。参考产品页和用户自定义产品页静态维护产品、方案、展示价格、Paddle 环境、Client-side Token 与 Price ID，并直接调用 Paddle.js。Price ID 同时写入 Admin 的 Offer Mapping，服务端在已验签 Webhook 中以 `account_id + billing_provider_id + external_price_id` 关联 Product 与 License Plan。

浏览器成功回调和成功 URL 都不能触发履约。静态页面可能在 LicenKit 暂时不可用、Offer 已归档或通知链路故障时继续打开 Paddle Checkout；因此入站事件必须先持久化，映射或依赖不满足时保留原始事实并进入 `pending`、`blocked_configuration` 或 `needs_attention`，不得吞掉付款或猜测授权。

Paddle Client-side Token 与 Price ID 可以进入前端；API Key、Webhook Secret、Notification Gateway Secret、验证令牌和内部诊断不得进入静态页面。Sandbox 与 Live 必须分别设置 Default Payment Link，Live 产品页必须为实际 Origin 完成 Website Approval 和打开测试。

## 7. Client API

### 7.1 激活

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

### 7.2 在线验证

```text
POST /api/v1/client/validate
```

请求必须包含 `activation_id`、`machine_token`、`fingerprint`、`release_version` 和 `release_platform`。设备平台与发布工件平台分开；两种凭证模式都调用该在线接口，`signed` 模式验证成功时可以刷新 Signed License Token，`opaque` 模式不返回 Signed License Token。

激活和在线校验都必须携带 App 内置的版本标识和平台。服务端在当前 Account 与 Product 下查找受信 Product Release；查不到时返回 `PRODUCT_RELEASE_UNKNOWN`。对受版本期限约束的永久 License，受信 `released_at > updates_until` 返回 `UPDATE_ENTITLEMENT_REQUIRED`；该错误不改变 License 状态，也不能转换成 `LICENSE_EXPIRED`。

激活和在线校验在其他 License 状态判断前拒绝 `is_checkout_verification=1`，返回 `LICENSE_CHECKOUT_VERIFICATION_ONLY`。管理员恢复、状态编辑和方案迁移也不得清除该标记；验证注册码只能证明邮件闭环，不能成为可用授权。

### 7.3 无需支付方式的 Product/设备试用

```text
POST /api/v1/client/trials/claim
POST /api/v1/client/trials/validate
```

领取请求：

```json
{
  "account_id": "acc_01...",
  "product_id": "prd_01...",
  "fingerprint": "sha256:...",
  "device_platform": "macos-arm64",
  "release_version": "2.4.0",
  "release_platform": "macos-universal"
}
```

服务端要求 Product 为 active 且已启用试用，并在当前 Account 与 Product 下找到受信 Product Release。首次领取以 `Cache-Control: no-store` 返回一次 Trial Token：

```json
{
  "success": true,
  "data": {
    "trial_id": "trl_01...",
    "trial_token": "ttk_...",
    "status": "active",
    "expires_at": "2026-10-03T10:00:00Z",
    "features": ["pro_export"]
  }
}
```

服务端只保存 Token 哈希。重复或并发领取同一 `account_id + product_id + fingerprint` 返回 `TRIAL_ALREADY_CLAIMED`，不得延长到期时间或再次返回 Token；这项业务唯一性由 D1 唯一约束承担。Trial Claim 与校验接口的流量保护由 Cloudflare Zone 级 WAF Rate Limiting Rules 按方法、路径和部署套餐支持的请求特征配置，不在应用内复制通用计数状态。

校验请求携带 `trial_id`、`trial_token`、同一设备指纹、`release_version` 和 `release_platform`。服务端同时限定 Account 与 Product，验证 Token 哈希、设备绑定、吊销状态、绝对到期时间和 Product Release；成功时更新 `last_validated_at`。未知 Release、到期和吊销分别返回 `PRODUCT_RELEASE_UNKNOWN`、`TRIAL_EXPIRED` 和 `TRIAL_REVOKED`，不得归一化成 License 错误。V1 Trial Claim 只在线有效，不返回 Signed License Token。

Paddle 免费订阅试用不调用这两个接口。它在已验签支付事件履约后得到普通 License Key，随后走 7.1 和 7.2 的正常 License 激活与校验合同。

### 7.4 主动解绑

```text
POST /api/v1/client/deactivate
```

服务端成功后 Activation 进入 `deactivated`。网络失败时 SDK 不能假装远端已经释放席位；本地是否清理凭证由 SDK 合同定义。

### 7.5 公钥集合

```text
GET /api/v1/client/products/:productId/signing-keys
```

该接口用于诊断和密钥轮换信息发布，不能替代 App 内置的信任根。响应包含 key ID、状态和公钥，不包含私钥。

## 8. Payment Inbound Webhook

```text
POST /api/v1/webhooks/payments/:accountSlug/:billingProviderId
```

V1 的首个真实实现是 Paddle；同一路由和处理顺序同时用于 Paddle Sandbox 与 Live，只由 Billing Provider 配置区分环境。

处理顺序固定为：

1. 根据 accountSlug 解析 Account，再以 `account_id + billingProviderId` 读取唯一 provider 和 environment 配置；
2. 对原始请求体执行渠道签名验证；
3. 提取稳定的外部事件 ID；
4. 提取事件中存在的外部 Customer、Transaction、Subscription 与 Adjustment ID，并尝试写入 Inbound Event；
5. 重复事件先核对已保存的 payload Hash：Hash 不同表示同一 Event ID 对应了冲突事实并返回 409；Hash 相同则返回已有接收结果。若该事件尚未完成且加密 payload 已清理或过期，本次已验签重投只恢复同一事件的 payload 与到期时间，不复制事件、不清空错误、不解除 System Issue 阻塞；
6. 新事件持久化成功后返回 2xx；
7. 请求后立即尝试履约以降低延迟；
8. 即时处理未完成时，由 Scheduled Worker 根据同一条 Inbound Event 恢复。

Billing Provider ID 只用于路由配置，不能替代验签，也不从请求体接受 `account_id`。所有已注册 provider，以及未来新增的 custom Adapter，都必须验签。没有签名配置时返回配置错误，不得继续处理。

只有 Inbound Event 已可靠持久化才返回 2xx。签名无效返回 4xx，数据库写入失败返回 5xx 让 Paddle 重试；事件已持久化后的 Customer API 超时、依赖未齐或履约失败不再改变本次接收响应，由内部状态机和 Scheduled Worker 重试，避免把 Paddle 重投当作内部任务队列。

Paddle Notification Destination 最小事件合同为 `customer.created`、`customer.updated`、`transaction.completed`、`subscription.created`、`subscription.updated`、`adjustment.created` 和 `adjustment.updated`。Offer 激活检查必须在当前 Provider 配置更新时间之后找到每种事件对应的 Inbound Event 且验签成功，通常由管理员通过官方模拟器逐项触发；不能只验证 URL 可达，也不能要求 API Key 才能读取远端配置。Customer 事件 upsert Billing Customer 镜像并尝试建立内部映射。购买事件先按外部 Customer ID 查询映射；缺失时以 `BILLING_CUSTOMER_PENDING` 保持 `pending` 并等待 Customer 事件。只有配置了具备 `customer.read` 权限的 API Key 时才调用 Paddle Get Customer 加速恢复，API 失败不改变 Webhook 等待路径。

只有 `linkStatus=linked` 才能创建新 License 和发码 Delivery。`email_mismatch`、无效/归档 provider Customer 或无法安全链接时进入 `needs_attention`。已有 Subscription 的续费根据 Subscription 直接更新原 License，不重新按邮箱链接。处理器不得读取 `custom_data.email`、Checkout 参数或调用方自报邮箱作为发码身份。

普通首次购买还必须根据已验签 Transaction 行项目验证：恰好一个行项目、`quantity=1`、Price 命中当前 active Offer、Offer Provider 环境等于 Product `billingEnvironment`，并且 Offer、Product、Plan 和 `purchaseType` 一致。任何不满足项都以保留外部 Transaction、Price、数量、Provider 环境、Product 环境和事件 ID 的具体错误进入 `needs_attention`，不创建 Customer、License、Subscription 或 Delivery；不能选择第一项、忽略附加项目或按总金额猜测授权。

唯一例外是首次验证 Transaction 的 `custom_data.licenkit_checkout_verification` 通过哈希等值查询命中同账户、当前 Offer 的 `pending` Checkout Verification，且令牌未过期、Provider 为 Sandbox、Price 和数量完全匹配。服务端以条件更新原子消费该令牌，再调用同一 Fulfillment Service 创建 `is_checkout_verification=1`、`suspended + checkout_verification` 的 License 和发码 Delivery；Delivery accepted 后验证状态才变为 completed。错误、过期、重复、Offer 不匹配或 Live Provider 的令牌进入 `needs_attention`，不得回退到普通付款。除这个窄用途随机令牌外，其他 `custom_data` 仍不得参与 Customer、Product、Plan 或授权身份判断。

Paddle 会把 Checkout Transaction 的 custom data 复制到新 Subscription，并继续复制到该 Subscription 的后续 Transaction。处理器必须先按已验签事件中的外部 Subscription ID 查询既有 Billing Subscription：如果它绑定验证 License，则后续事件按验证订阅镜像处理，不再次消费 token，也不因为 token 已使用而产生新的 `needs_attention`。只有尚无已绑定 Subscription 的首次交易才允许令牌开启验证履约。

对配置了免费试用的 Paddle recurring price，Adapter 必须从已验签事件取得 Subscription 的 `trialing` 状态、当前试用周期和下一扣款时间，再由统一 Fulfillment Service 原子创建 `subscription + billing` License、Billing Subscription 和首次发码 Delivery。`subscription.created` 和 `transaction.completed` 可以乱序到达；事实不足时 Inbound Event 保持 `pending`、把 `BILLING_DEPENDENCY_PENDING` 写入 `last_error_code` 并由同一调度器重试，不能创建半成品或对支付平台返回失败以诱发无界即时重投。试用转为 `active` 或 `past_due` 时只更新同一 License 与 Subscription；不得根据前端 Checkout 参数、未验签回调或本地计时器自行认定试用开始或结束。

若 Billing Subscription 绑定 `is_checkout_verification=1` 的 License，后续 `subscription.updated`、续费、试用转正或付款恢复只能更新支付镜像和验证诊断，不能把 License 改为 active、清除验证标记或再次发码；数据库约束应使错误状态更新直接失败并保留原始事件。此规则优先于后续 Transaction 中被 Paddle 复制的已消费 verification token。

`adjustment.created|updated` 必须按外部 Adjustment ID 幂等写入 Billing Adjustment。只有 `refund + full + approved` 和 `action=chargeback` 自动暂停已明确关联的 License，且不吊销 Activation；两者仍把 Adjustment 设为 open、Inbound Event 设为 `needs_attention`，等待管理员决定。`refund + pending_approval`、已批准部分退款、`chargeback_warning`、反转和无法关联的 Adjustment 同样进入 `needs_attention`，但不自动改变 License。`refund + rejected` 与 credit 类事件保留记录、标记 processed 且默认不改变授权。任何反转都不能隐式恢复 License；管理员通过独立 resolve API 决定 `no_action`、保持暂停、恢复、吊销或安全重置。扣款失败、取消、退款和拒付保留各自的 provider 事件类型、action、type、status、金额和原因。

## 9. Notification Webhook

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

## 10. 业务事件 Webhook

业务事件使用同一签名头，但不包含发码明文，典型事件包括：

- `license.issued`；
- `license.suspended`；
- `license.reinstated`；
- `license.revoked`；
- `activation.created`；
- `activation.deactivated`；
- `subscription.trial_started`；
- `subscription.activated`；
- `subscription.renewed`；
- `subscription.past_due`；
- `subscription.canceled`。

客户通知与业务事件是两类 Delivery，不能因为配置了通配业务事件端点就自动触发客户邮件。

订阅事件负载必须携带 `renewal_mode`；`subscription.renewed` 还携带 `renewal_source=manual|billing`，避免接收方把管理员续期误当成支付成功。Paddle provider 的原始事件类型和 ID 仍保存在来源字段中，不能被内部事件名覆盖。
