# API 参考

## 1. 范围

本文档定义 V1 接口边界和关键语义。版本迭代可以增加兼容字段，但不得改变既有鉴权、状态所有权和领域不变量。

接口分为五组：

| 接口 | 调用方 | 鉴权 |
| --- | --- | --- |
| Initial Setup API | 独立部署首次安装 | `INITIAL_SETUP_TOKEN`，且数据库必须未初始化 |
| Admin API | 管理控制台和自动化工具 | 管理员 Session |
| Customer Portal API | 客户授权中心 | Magic Link 与 Customer Session |
| Client API | 集成 LicenKit SDK 的 App | 注册码或机器令牌 |
| Payment Inbound Webhook | 支付平台 | 渠道原始请求签名 |

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

API 错误不得丢弃上游来源。支付和邮件投递错误在管理接口中应返回 provider、external event ID 或 Delivery ID、HTTP 状态及脱敏后的原始错误。

### 2.1 Instance 标识合同

Instance 只有一个稳定 ID。首次 Setup 使用 128 位安全随机数生成 22 位 Base64URL 字符串，不带类型前缀；它用于服务端数据关联、签名 Token 与支付 Webhook 路由。数据库和服务端内部 JSON 使用 `instance_id`，TypeScript 使用 `instanceId`，Signed License Token 使用 `ins` Claim。Client API、Swift SDK 和 CLI 不再要求调用方重复提交 Instance；Server 通过全局唯一 Product ID 解析租户边界。

系统不接受由浏览器提交的 Instance 选择字段。Admin/API Origin 唯一映射 Instance，Customer 请求再校验对应的 Customer Site Origin。Instance 不属于管理员登录凭据。

CLI 激活只提交 Product 与构建身份，例如：

```bash
licenkit activate LK-... \
  --product prd_01... \
  --release 2.4.0 \
  --release-platform macos-universal
```

CLI 不再接受 `--instance` 或 `LICENKIT_INSTANCE_ID`；服务端通过 Product ID 解析 Instance。

## 3. Initial Setup API

Setup 只服务独立部署的首次安装，不是公开注册或 SaaS Instance 创建 API。

```text
GET  /api/v1/setup/status
POST /api/v1/setup/verify-token
POST /api/v1/setup
```

Setup 使用三个独立页面：第一步只验证部署 Token；第二步收集首位 User 的显示名称、邮箱和密码；第三步收集首个 Instance 的名称、LicenKit Admin/API 地址与 Customer Site 地址。前两步不写数据库，Token 只保存在当前页面内存，刷新或关闭后必须重新验证。Instance ID 由服务端在最终提交时自动生成。

第一步请求：

```json
{
  "setup_token": "one-time-secret-from-deployment"
}
```

第三步最终提交完整输入：

```json
{
  "setup_token": "one-time-secret-from-deployment",
  "user": {
    "name": "Alex",
    "email": "alex@example.com",
    "password": "user-entered-password"
  },
  "instance": {
    "name": "Example Studio Licensing",
    "admin_api_url": "https://license.example.com",
    "customer_site_url": "https://www.example.com"
  }
}
```

`setup_token` 与部署 Secret `INITIAL_SETUP_TOKEN` 常量时间比较，不进入 URL、日志、审计详情或错误回显。验证接口与最终提交都检查精确 Origin、Secret、`deployment_bootstrap` 未完成，以及 User、Instance、Membership 仍为空，并返回 `Cache-Control: no-store`。管理员密码执行与正常登录一致的长度校验和密码 KDF，只保存 Hash。

`admin_api_url` 是 LicenKit 管理后台和 API 的规范 Origin。Setup 页面默认填入当前浏览器的 `window.location.origin`，服务端要求它与实际 Setup 请求 Origin 完全一致，不能包含路径、尾随斜杠、credentials、query 或 fragment。`customer_site_url` 是用户自己的官网或 Customer Portal 基础地址，供邮件 Magic Link 和 Turnstile hostname 使用，可以包含基础路径，但不能包含 credentials、query 或 fragment。两个地址可以跨 Origin，但必须保持同协议、同可注册站点；Setup 在写入前拒绝跨站组合。正式环境及普通域名必须使用 HTTPS；只有显式非正式环境的 `localhost` 或 `127.0.0.1` 允许 HTTP，IPv6 loopback 当前不支持。

最终提交再次验证 Token 和全部输入，并在一个 D1 原子批次中创建 User、Instance、Owner Membership、Admin Session、`instance.setup_completed` 审计和固定 `deployment_bootstrap(singleton_key='deployment')` 完成记录。任一步失败全部回滚，并发请求只能有一个成功；失败批次只有重新读取到完成记录时才转换为 `SETUP_ALREADY_COMPLETED`，否则保留原始错误。批次提交后才设置 Session Cookie；响应中断不回滚已经完成的 Setup，管理员可正常登录重建 Session。

初始化完成后，GET 返回 `initialized=true`，验证和提交固定返回 `SETUP_ALREADY_COMPLETED`。自部署不暴露创建第二个 Instance 或切换 Instance 的公开/管理 API。

## 4. Admin API

### 4.1 管理员会话与默认拒绝授权

管理员登录只提交 `email + password`。服务端按规范化邮箱查询全局 User，确认自部署数据库恰好存在一个 active Instance，并读取该 User 对唯一 Instance 的 active Membership。Admin Session 只绑定 User，不保存 Instance 或长期缓存角色；每个请求重新读取当前 Membership，构造 `userId + instanceId + instanceRole` 上下文。没有 active Membership 时拒绝进入 Instance。

登录成功后设置 HttpOnly、Secure、SameSite=Lax 的 host-only Session Cookie，以及独立的 Secure、SameSite=Lax、host-only CSRF Cookie；后者允许同源前端读取。服务端只保存两者 Hash。除登录外，所有 Cookie 鉴权的 POST/PUT/PATCH/DELETE 同时要求精确 Origin、`X-CSRF-Token` Header 与 CSRF Cookie 常量时间相等，并确认 CSRF Token Hash 属于当前 Session；SameSite 只是附加保护。登录和 Setup 没有既有 Session，仍必须执行精确 Origin 检查，并由部署层 Zone 级 WAF Rate Limiting Rules 保护。

```text
POST /api/v1/admin/auth/login
GET  /api/v1/admin/auth/session
POST /api/v1/admin/auth/logout

GET   /api/v1/admin/instance

GET   /api/v1/admin/profile
PATCH /api/v1/admin/profile
POST  /api/v1/admin/profile/password

GET   /api/v1/admin/members
PATCH /api/v1/admin/members/:userId

GET  /api/v1/admin/invitations
POST /api/v1/admin/invitations
POST /api/v1/admin/invitations/:invitationId/revoke
POST /api/v1/admin/invitations/:invitationId/resend

POST /api/v1/invitations/accept
```

`GET /admin/instance` 对四种 active 角色开放，只读返回当前 Instance 的 ID、名称、`admin_api_url`、`customer_site_url` 和状态。当前自部署不提供 Instance 状态修改接口；`suspended/archived` 的修改主体属于未来 SaaS 控制面。

Profile 只操作当前 User：显示名称可修改，邮箱只读，不存在修改邮箱 API。修改密码必须验证当前密码，并在同一个原子写入中替换密码 Hash、写 identity 审计并撤销该 User 除当前请求外的其他 Admin Session；撤销对该 User 所属的全部 Instance 生效。

Members 与 Invitation 只允许 active Owner 管理。Owner 可以邀请邮箱、调整 Membership 角色、暂停、恢复或软移除 Membership，但不能修改其他 User 的显示名称、邮箱、密码或全局 Session。Membership 状态为 `active/disabled/removed`；`removed` 重新加入必须接受新邀请。最后一个 active Owner 的降级、暂停或移除由数据库不变量拒绝并返回 `LAST_ACTIVE_OWNER_REQUIRED`。

邀请接受页固定为 LicenKit `admin_api_url` 下的 `/admin/invitations/accept#token=...`，不能使用 Customer `customer_site_url`。Token 只在页面内存保管，页面立即清理 Fragment，GET 和邮件扫描器不能消费；用户明确操作后才 POST。接受前不创建占位 User 或 Membership。新邮箱由受邀者设置密码；已有 User 必须先通过有效 Admin Session 或等价邮箱密码认证。接受或撤销的并发终态由 D1 Trigger 在原子批次内抛错，失败方不能留下 User、Membership、Session、Delivery 或审计副作用。

登录、Session 查询、Setup 成功与 Invitation 接受都返回同一上下文形状：

```json
{
  "user": { "id": "usr_01...", "name": "Alex", "email": "alex@example.com" },
  "instance": { "id": "3Jd9K_aP0qUwbL6F7sTn2Q", "name": "Example Studio", "admin_api_url": "https://license.example.com", "customer_site_url": "https://www.example.com", "status": "active" },
  "membership": { "role": "owner", "status": "active" },
  "expires_at": "2026-09-28T10:00:00Z"
}
```

邀请创建提交 `{ "email": "member@example.com", "role": "member" }`，并在同一原子批次中创建 `instance.member_invited@1` Email Delivery；明文 Token 不返回给邀请人。若邮件配置未就绪，Delivery 进入 `waiting_configuration`，之后仍由统一 Dispatcher 与 Scheduled Worker 恢复。重新发送会撤销旧 pending Invitation、终止旧 Delivery，并创建新的 Invitation、Token 和 Delivery。接受请求三选一：已有 Admin Session 只提交 `{ token }`；已有 User 可提交 `{ token, existing_user: { email, password } }`；新 User 提交 `{ token, new_user: { name, password } }`。

每条 Admin 路由必须声明一个权限；未声明权限、角色不在允许集合、资源不属于当前 Instance 时一律拒绝。V1 既有业务权限矩阵不因身份重构而改变：

| 能力 | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| 读取当前 Instance 非 Secret 数据 | 允许 | 允许 | 允许 | 允许 |
| Invitation 与 Membership 管理 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Product、Release、Trial Claim 的写入与运维 | 允许 | 允许 | 拒绝 | 拒绝 |
| License Plan、Billing Provider、Billing Customer 对账、Offer | 允许 | 允许 | 拒绝 | 拒绝 |
| Email Integration、Binding 与人工重发 | 允许 | 允许 | 拒绝 | 拒绝 |
| Activation 释放等低风险支持操作 | 允许 | 允许 | 允许 | 拒绝 |
| License 签发、找回、安全重置、暂停与吊销 | 允许 | 允许 | 拒绝 | 拒绝 |
| Customer 身份字段与状态修改 | 允许 | 允许 | 拒绝 | 拒绝 |
| License Terms 批量迁移 | 允许 | 允许 | 拒绝 | 拒绝 |
| Inbound Event replay、Delivery retry | 允许 | 允许 | 拒绝 | 拒绝 |
| 审计与诊断读取 | 允许 | 允许 | 仅本人操作结果 | 只读脱敏摘要 |

权限判断从服务端路由元数据、当前 User 与实时 Membership 得出，不能接受请求体传入角色或 Instance ID。所有资源查询都把请求上下文的 `instance_id` 写入数据库条件；路径中的资源 ID 不能替代租户条件。

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
  "name": "Example App",
  "billing_environment": "live",
  "payment_grace_seconds": 0,
  "trial": {
    "enabled": true,
    "duration_seconds": 1209600,
    "features": ["pro_export"]
  }
}
```

Product 由服务端生成的全局唯一 `id` 标识，创建请求不接受第二套人工标识。创建 Product 时 LicenKit 同时自动生成 Ed25519 密钥对：私钥加密后只保存在服务端，Admin 产品详情与 Product API 只返回 Key ID、算法、状态和公钥。管理员不上传、下载或查看私钥；应从 Admin 复制公钥并随 `signed` 模式 App 构建交付。

`billing_environment` 可为 `sandbox|live|null`：`null` 表示普通支付事件不能签发正式 License；非空值是该 Product 唯一可签发正式支付 License 的环境。设置或切换环境时，服务端必须确认没有 active Offer，且不存在 `is_checkout_verification=0` 的支付 License；否则返回 `PRODUCT_BILLING_ENVIRONMENT_LOCKED`。验证 License 不锁定该字段，因为它永远不可激活。

`payment_grace_seconds` 是非负整数，Product 创建默认 `0`。创建订阅 License Plan 时省略该字段会固化 Product 当时的值；非订阅 Plan 固定为 `0`。支付型订阅 License 再从 Plan 固化该值，Product 后续修改不追溯已有 Plan 或 License，Plan 后续修改也不追溯已签发 License。启用试用时 `duration_seconds` 必须显式提供正整数；V1 不使用隐式全局试用天数。修改 Product 的试用时长或功能只影响之后领取的 Trial Claim。

Trial Claim 查询和吊销只允许 owner/admin，并在持久层同时限定当前 `instance_id + product_id + trial_id`。吊销请求必须提交非空 `reason`；操作幂等地写入 `revoked_at`、原因和管理员审计，不删除领取历史，也不允许通过“编辑到期时间”重置试用。Product 归档只阻止新领取，不隐式吊销已有 Claim。

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
  "download_url": "https://downloads.example.com/app-2.4.0-universal.dmg",
  "artifact_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "released_at": "2026-09-19T10:00:00Z"
}
```

`description` 和 `download_url` 可空，`artifact_sha256` 必填。`version + platform` 在 Product 内唯一。创建后 `version`、`platform`、`artifact_sha256` 和 `released_at` 不允许 PATCH；说明与下载地址可以修改。若二进制或 Hash 变化，创建新的 Release，不能覆盖已有发布事实。

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
  "product_id": "prd_01...",
  "name": "Pro Lifetime with 1 Year Updates",
  "license_model": "perpetual",
  "credential_mode": "signed",
  "max_activations": 3,
  "features": ["pro_export", "batch_processing"],
  "update_window_seconds": 31536000,
  "signed_token_ttl_seconds": 2592000,
  "payment_grace_seconds": 0
}
```

- `license_model` 描述有效期生命周期：永久、固定期限或随订阅周期更新；
- `credential_mode` 不描述是否联网。`opaque` 只签发 Machine Token，`signed` 在相同在线流程上额外签发 Signed License Token；
- `update_window_seconds` 只适用于 `perpetual`；`null` 表示所有未来版本，正整数表示签发后的版本更新窗口；
- `credential_mode=opaque` 时 `signed_token_ttl_seconds` 必须为 0，`signed` 时必须大于 0；
- 非订阅方案的 `payment_grace_seconds` 必须为 0；订阅方案省略该字段时，服务端读取当前 Product 值并把解析后的整数写入方案响应与数据库。

更新成功后 revision 递增。响应需要明确：

```json
{
  "revision": 4,
  "affects_existing_licenses": false
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
  "license_plan_id": "lpl_01...",
  "customer_email": "buyer@example.com",
  "expires_at": null,
  "delivery": {
    "send_notification": true
  }
}
```

`customer_email` 为必填字段。服务端使用统一规范化规则查找或创建 Customer，再把 License 写入该 `customer_id`；客户端不能直接提交任意 Customer ID 绕过 Instance 归属检查。

管理端和受信 API 可以签发三类 License：

- `perpetual`：`expires_at` 必须省略或为 `null`，响应为 `renewal_mode=none`；这是给朋友签发永久 License 的正确模型；
- `fixed_term`：`expires_at` 必须省略，由服务端按方案的 `default_term_seconds` 计算，响应为 `renewal_mode=none`；
- `subscription`：必须提交晚于当前时间的绝对 `expires_at`，响应为 `renewal_mode=manual`。

手动订阅不创建 Billing Subscription，且无论方案中的支付宽限期是多少，License 的 `payment_grace_seconds` 都固化为 0。服务端不能接受请求直接传入 `renewal_mode`、`payment_grace_seconds` 或支付来源字段；这些字段由签发路径确定，避免调用方拼出相互矛盾的状态。

成功响应可以返回一次注册码，但 API 必须同时返回通知状态：

```json
{
  "license": {
    "id": "lic_01...",
    "license_key": "LK-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX",
    "status": "active",
    "license_model": "perpetual",
    "renewal_mode": "none",
    "expires_at": null,
    "updates_until": "2027-09-19T10:00:00Z"
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

语义：轮换注册码、保留 active Activation、创建新的 `customer.license_recovered` Email Delivery。

#### 安全重置

```text
POST /api/v1/admin/licenses/:licenseId/security-reset
```

语义：轮换注册码、吊销全部 active Activation、创建新的 `customer.license_security_reset` Email Delivery。

两者必须使用不同接口和审计动作，避免调用方通过一个模糊布尔值误清退设备。

#### 延长版本更新权益

```text
POST /api/v1/admin/licenses/:licenseId/extend-updates
```

请求传入新的绝对 `updates_until`；`null` 表示升级为不限制未来版本。该操作只适用于 `perpetual` License，新值不能早于当前值，不改变 `expires_at`、注册码或 Activation，并且必须记录前值、后值和原因。

#### 手动订阅续期

```text
POST /api/v1/admin/licenses/:licenseId/renew-term
```

```json
{
  "expires_at": "2027-09-19T10:00:00Z",
  "reason": "Complimentary annual renewal"
}
```

该操作只接受 `license_model=subscription + renewal_mode=manual`。新的 `expires_at` 必须晚于当前到期时间和当前时间；成功时只延长同一 License，保留注册码与 Activation，并记录前值、后值、原因、操作者和请求 ID。接口接收绝对时间，不接收“增加天数”；当重放值恰好等于当前 `expires_at` 时返回当前结果而不再次延长，早于当前值才拒绝。`perpetual` 不需要续期，`fixed_term` 到期后的新授权策略不通过本接口伪装，`renewal_mode=billing` 只能由已验签支付事件推进。

### 4.6 Billing Provider

```text
GET    /api/v1/admin/billing/providers
POST   /api/v1/admin/billing/providers
PATCH  /api/v1/admin/billing/providers/:providerId
POST   /api/v1/admin/billing/providers/:providerId/test
```

测试接口只读取当前配置、正式事件验签时间和 Simulator 逐事件测试证据；它不伪造签名样本，也不创建 License。

Paddle Provider 配置四类互不替代的凭证：

- `client_side_token`：必填、与 `sandbox|live` 环境匹配；LicenKit 记录该公开 Token，并在 Sandbox Admin Checkout 测试中返回给官方 Paddle.js。正式产品页仍自行嵌入对应 Live Token；它不是 Secret；
- Platform Webhook Secret：必填、加密保存，只验证 Paddle `traffic_source=platform` 正式业务目标发来的原始 Webhook；
- Simulator Webhook Secret：必填、加密保存，只验证另一条 `traffic_source=simulation` 测试目标发来的原始 Webhook；
- Paddle API Key：可选、加密保存，只在启用服务器端 API 能力时需要；Get Customer/对账至少要求 `customer.read`，托管客户门户要求 `customer_portal_session.write`。

管理 API 返回 `client_side_token` 的值或可用状态，但两类 Webhook Secret 与 API Key 写入后只返回是否已配置，不返回明文。基础购买、事件履约和发码不能要求 API Key；没有 API Key 时 Customer 映射通过 Webhook 收敛。

管理后台把“编辑支付通道”和“检查本地配置”分开：编辑入口负责更新公开 Token、修改两类 Webhook Secret、替换或移除 API Key 以及启停通道；检查入口只读取已保存配置和验证证据，不在诊断界面修改凭证。

`provider` 和 `environment` 是连接身份，创建后不可 PATCH；切换 Sandbox/Live 必须创建另一条 Provider。PATCH 只允许修改同一连接的 Client-side Token、两类 Webhook Secret、可选 API Key 或状态。Platform 与 Simulator Secret 分别维护内部版本；任一 Secret 修改后，只使对应入口在修改前形成的验证证据失效。这样已有外部 Customer、Transaction、Subscription 和事件 ID 不会被重新解释到另一环境。

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
- `401`、`403`：已启用的 API 读穿配置无效、过期或缺少权限。事件进入 `needs_attention`，将 `BILLING_PROVIDER_API_AUTH_INVALID` 和字段级脱敏后的 `http_status + provider_code + request_id + message` 写入自己的 last error；同时按 Provider 与 `customer_read` 操作累加一条被动 System Issue。修复配置后从原 Event 执行 Replay；
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
  "billing_provider_id": "bpr_01...",
  "external_price_id": "pri_01...",
  "product_id": "prd_01...",
  "license_plan_id": "lpl_01...",
  "purchase_type": "subscription"
}
```

创建响应的 `status` 固定为 `draft`。Offer 只有在 Billing Provider 环境等于 Product `billing_environment` 时才允许激活；不同环境的 draft Sandbox Offer 仍可用于管理员闭环验证，但不能签发正式 License。

PATCH 只允许修改尚无 Checkout Verification 的 draft Offer。只要存在任一验证尝试，Provider、Price、Product、Plan 和 `purchase_type` 即被锁定；需要改变映射时归档旧 Offer 并创建新 Offer，不能让旧验证证据跟随到新权益。

`verification-config` 使用 POST，因为每次调用都会创建一条短期、一次性的 Checkout Verification。它只允许 owner/admin 针对 draft Sandbox Offer 调用，响应设置 `Cache-Control: no-store`，并只返回打开这一次 Sandbox Checkout 所需的配置：

```json
{
  "verification_mode": true,
  "verification_token": "vfy_一次性高熵随机值",
  "expires_at": "2026-09-19T10:15:00Z",
  "checkout": {
    "provider": "paddle",
    "environment": "sandbox",
    "client_side_token": "test_...",
    "price_id": "pri_01...",
    "quantity": 1
  }
}
```

服务端只保存 `verification_token` 哈希；管理控制台不得写入日志、localStorage、分析事件或 URL。Admin 内部 TypeScript 把响应转换为 `verificationToken` 后，再通过 Paddle.js 将令牌附加为 `custom_data.licenkit_checkout_verification`；调用方不能另行传入任意 custom data。该 POST 还必须通过管理员 Session 权限、精确 Origin 和双提交 CSRF 校验。该接口不允许 Live Offer、不公开到无鉴权路由，也不绕过一个 Price、数量 1、Webhook、Customer 解析、Fulfillment 或 Email Delivery。令牌的权限只是在完全匹配的 Sandbox 交易中生成一条永久不可激活的验证 License，不授予正式权益。

`activate` 不接受调用方传入 `ready=true`；服务端实时执行 Checkout Readiness 检查并返回每项状态。至少包括 Product/Plan/Provider、Provider 环境等于 Product `billing_environment`、Client-side Token 的环境标识与 Provider 匹配、当前 Provider 配置更新时间之后最小 Paddle 事件合同中每一种事件的成功验签证据（通常由官方模拟器触发）、active Email Integration 和可用凭证、`customer.license_issued@1` 的 active Template Binding、`signed` 模式密钥，以及同一 Instance、Product、License Plan 与 `purchase_type` 的 `billing_checkout_verifications.status=completed` 真实 Sandbox 证据。Sandbox Offer 通过 `verification-config` 产生该证据；Live Offer 可以复用对应 Sandbox 闭环证据，不执行真实扣款验证。配置测试、System Issue 与 Scheduler 健康都不作为 Offer 激活门禁；Scheduler 最近成功时间不持久化，远程状态在 Cloudflare Cron Events 与 Workers Logs 中验收。任一必需项失败时返回 `BILLING_CHECKOUT_NOT_READY` 和管理端可见的具体检查项，不改变 Offer 状态。

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
POST  /api/v1/admin/system/issues/:issueId/process
```

Billing Customer 详情展示 provider Customer ID、镜像邮箱、关联 Customer、`link_status` 和最后同步来源，但不返回服务端 API 凭证。只有 Provider 已配置相应 API Key 时才开放 `reconcile`；它使用服务器端凭证重新读取同一个外部 Customer ID，不接受调用方传入邮箱，也不自动修改或改绑 LicenKit Customer。未配置时返回 `BILLING_PROVIDER_API_CAPABILITY_DISABLED`，不影响 Webhook 驱动的购买履约。邮箱一致时可把映射恢复为 `linked`；仍不一致时保持 `email_mismatch`。

购买事件因 `BILLING_CUSTOMER_PENDING` 超时进入 `needs_attention` 时，管理响应给出外部 Customer ID、Provider 环境和来源事件引用，并建议管理员先在 Paddle Notification 日志重放 Customer 事件；若已配置 API Key，也可以 reconcile。修复后调用原 Event replay。接口不得提供“输入邮箱并继续履约”的旁路。

列表和详情必须以当前请求上下文的 `instance_id` 查询；详情、对账和支付履约都使用 `instance_id + billing_provider_id + external_customer_id` 定位映射。API 不提供仅按外部 Customer ID 的全局查询，也不把 Paddle、未来其他平台或 sandbox/live 中相同字符串的 ID 视为同一身份。

Replay 重新执行同一持久化事件，不能跳过事件唯一约束，也不能复制为新事件规避幂等。重新排队时保留现有 `last_error_code + last_error_detail`，只有完整状态机产生成功结果或新的具体错误后才更新，避免在实际重试尚未发生时丢失最后一次可诊断事实。

System Issue 列表只返回当前 Instance 最近的业务错误，按 `last_seen_at` 倒序。每项包含 `category`、`source_type`、`source_id`、`operation`、原始 `error_code`、字段级脱敏的最近诊断、发生次数、首次/最近时间，以及 `pending|processed` 状态。owner/admin 可以调用 `process` 将待处理标为已处理；这不修改原业务对象，也不跳过其重试或恢复流程。同一错误再次发生时，原 Issue 会累加次数并重新变为待处理。Admin 的主要页面顶部共用 Instance 告警：展示最近待处理 Issue、最近发生时间和待处理数量，并链接到完整列表。

每条 `system_issues.instance_id` 都非空；只有能归属明确 Instance 的 Billing、Webhook、Email、Delivery 和业务任务错误进入列表。Worker 部署、资源绑定、Cron 顶层异常或数据库整体不可用等 Deployment 级故障只进入部署平台和运行日志。Issue 和告警组件不禁用产品操作，也不保存 Scheduler 最近成功时间。

Issue 的人工状态不改变任务状态。管理端根据 `source_type + source_id` 引导管理员回到 Billing Provider、Inbound Event 或 Email Delivery；实际测试、Replay、Retry 和取消发送由这些原对象的 API 完成。


Adjustment 详情必须返回 provider、外部 Adjustment/Transaction/Subscription/Customer ID、原始 `action + type + status`、金额/币种、关联 License、自动影响、人工状态和来源事件。`resolve` 只允许 owner/admin，要求 `action` 为 `no_action|keep_suspended|reinstate|revoke|security_reset` 之一并提交非空原因。服务端根据当前 Adjustment 与 License 状态验证动作是否合法，在一个原子批次中更新 License/Activation、Adjustment 和审计；请求不能直接提交目标 License 状态。

### 4.9 Email Template Contract

```text
GET /api/v1/admin/email-template-contracts
GET /api/v1/admin/email-template-contracts/:notificationType/versions/:contractVersion/examples/:provider
```

列表返回 `customer.license_issued@1`、`customer.license_recovered@1`、`customer.license_security_reset@1`、`customer.portal_access_requested@1` 和 `instance.member_invited@1` 的稳定变量合同，包含名称、类型、必填性、敏感性、格式、说明与安全示例。示例接口返回 Provider 特定的参考 subject/HTML/text 和文件名；这些内容用于在 Provider 中创建外部模板，不参与 LicenKit 运行时渲染。

### 4.10 Email Integration 与 Template Binding

```text
GET    /api/v1/admin/email-integrations
POST   /api/v1/admin/email-integrations
PATCH  /api/v1/admin/email-integrations/:integrationId
POST   /api/v1/admin/email-integrations/:integrationId/rotate-credential
POST   /api/v1/admin/email-integrations/:integrationId/disable
POST   /api/v1/admin/email-integrations/:integrationId/enable
GET    /api/v1/admin/email-integrations/:integrationId/template-bindings
POST   /api/v1/admin/email-integrations/:integrationId/template-bindings/install-defaults
PUT    /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType
POST   /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/disable
POST   /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/enable
POST   /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/test
POST   /api/v1/admin/email-integrations/:integrationId/template-bindings/:notificationType/retry-waiting
```

V1 `provider` 只允许 `resend`。创建时提交 `name`、`api_key`、`default_from_email`、可选 `default_from_name`/`reply_to_email` 和 `max_automatic_attempts`。API Key 加密保存；响应只返回 `credential_configured`，不返回密钥。Provider 是不可变连接身份。Integration 不含 revision；凭证、From 或 Reply-To 修改后，未成功 Delivery 下一次发送直接读取最新配置。

`install-defaults` 提交 `{ full_access_api_key }`；管理端逐项安装时还会提交 `{ notification_type, contract_version }`，使一次请求只处理一份代码内置模板。服务端使用 Resend Full access Key 创建并发布对应的 subject/HTML/text 和变量声明，再把返回的 Template ID 写入缺失的 Binding。该 Key 只存在于请求内，不写入 Integration、数据库、响应或审计；日常发送仍使用 Integration 中保存的 Sending access Key。管理端通过逐模板请求展示真实进度，并在相邻模板任务之间等待 5 秒以控制 Resend 请求频率。接口不会覆盖已有 Binding；失败响应保留 Resend 原始错误、失败通知类型及已完成/待处理数量，已成功的 Binding 不回滚，再次执行只继续处理尚未绑定的合同。全部 Binding 建立后，管理端不再显示安装入口。安装完成后 LicenKit 不读取、比较、更新、删除或同步远程模板。

五种邮件 Binding 都可以通过各自的 `:notificationType/test` 端点独立执行真实 Provider Test，测试一个 Binding 不要求其他 Binding 已配置或已通过。管理端展示当前 Binding 配置，不展示或保存测试历史。

Binding PUT 使用 `{ contract_version, provider_template_ref }`。同一 Integration 和 `notification_type` 只有一条当前 Binding；改变合同版本不会保留旧兼容通道，所有未成功 Delivery 的下一次发送也使用这个当前版本。测试 POST 必须提交 `{ recipient_email }`。服务端用代码合同中的安全测试值组装请求，直接调用与业务发送相同的 Provider Adapter；不创建 Email Delivery。响应返回 `provider_accepted`、`provider_message_id`、`request_id`、`http_status`、Provider 原始 `error_code`/`error_detail`、`retry_after` 和传输诊断。结果只存在于本次响应。`provider_accepted=true` 只证明 Provider Send API 接受了本次测试，不证明最终送达，也不证明外部模板之后没有被修改。

管理员确认当前 Integration/Binding 可用后，可以调用 `retry-waiting`。服务端只把同一 Instance、通知类型和合同版本下仍有有效变量的 `waiting_configuration` Delivery 重新排入队列；真正发送时再次读取最新配置。

### 4.11 Email Delivery

```text
GET   /api/v1/admin/email-deliveries
GET   /api/v1/admin/email-deliveries/:deliveryId
POST  /api/v1/admin/email-deliveries/:deliveryId/retry
POST  /api/v1/admin/email-deliveries/:deliveryId/cancel
```

Email Delivery 返回通知类型、合同版本、Customer、唯一收件地址、当前状态、`attempt_count`、业务发送期限、accepted 后的敏感变量清理期限、下次自动重试时间、Provider Message ID、最近一次完整脱敏错误和时间字段，不返回变量密文。

`retry` 只允许尚未 accepted/expired/cancelled、未被处理器持锁且仍在业务发送期限内的 Delivery。普通发码邮件没有创建时间驱动的发送期限，因此配置修复后仍可人工重发；Magic Link 等内容本身会失效的邮件不能在业务到期后重发。网络中断、超时等结果未知时，最近错误会包含 `possible_duplicate_on_resend=true`；此时请求必须提交 `{ "confirm_possible_duplicate": true }`，明确确认可能产生重复邮件。人工和自动重发都使用当前最新 Integration/Binding。

Provider 接受并返回 Message ID 后进入 `accepted`，这就是当前一期的“已发送”，并从 accepted 时间开始计算敏感变量清理期限。`cancel` 只允许尚未发送且当前未处于 processing 的 Delivery；成功后状态为 `cancelled`，立即清除敏感变量并停止后续发送。自动重试达到 Integration 的上限后进入 `failed`，不会无限重发。

### 4.13 Customer

```text
GET    /api/v1/admin/customers
GET    /api/v1/admin/customers/:customerId
PATCH  /api/v1/admin/customers/:customerId
POST   /api/v1/admin/customers/:customerId/disable
POST   /api/v1/admin/customers/:customerId/enable
POST   /api/v1/admin/customers/:customerId/sessions/revoke
```

V1 不提供 Customer 自助修改邮箱。管理员修改 Customer 邮箱时必须规范化、检查同 Instance 唯一约束并写入审计；目标邮箱已属于另一个 Customer 时返回冲突，不自动合并。修改邮箱或禁用 Customer 必须同时吊销未消费 Magic Link 和现有 Customer Session，但不自动暂停或吊销其 License。

## 5. Customer Portal API

### 5.1 请求 Magic Link

```text
POST /api/v1/customer/auth/magic-link
```

```json
{
  "email": "buyer@example.com",
  "turnstile_token": "一次性 Turnstile Token"
}
```

`turnstile_token` 最长 2048 字符。Worker 必须调用 Cloudflare Siteverify，并校验 `success=true`、`action=customer_magic_link`、返回 hostname 与目标 `instances.site_url` 的 hostname 一致。Turnstile Token 五分钟过期且只能验证一次；服务端对同一次 Siteverify 的短暂重试使用相同 idempotency key。缺失、无效、重复、过期、action/hostname 不匹配或无法确认时，在查询 Customer 前 fail-closed；Token、Secret 和完整 Siteverify 响应不进入日志、审计或 D1。

Siteverify 通过后、查询邮箱前，服务端先解析 Magic Link TTL/冷却配置，并解密、校验当前 Instance 的 active Email Integration Provider 凭证。共享配置损坏因此不会只在“邮箱存在”分支暴露；同一 Instance 下已知和未知邮箱得到相同的失败边界。未配置 Integration/Binding 不是公开的“邮箱存在”错误；只有真实 Customer 会在后续事务中创建 `waiting_configuration` Email Delivery。

无论是否存在匹配的 active Customer，公开响应都保持一致并使用 `Cache-Control: no-store`：

```json
{
  "success": true,
  "data": {
    "accepted": true
  }
}
```

Turnstile 验证与共享邮件凭证预检通过后才查询 Customer。有效 Customer 使用 `customer_login_challenges(instance_id, customer_id, created_at)` 检查默认 60 秒冷却：冷却命中时不创建 Challenge/Delivery，也不吊销仍有效的旧链接；冷却结束后，在一个 D1 原子批次中条件创建默认 15 分钟有效的 Login Challenge 和 `customer.portal_access_requested` Email Delivery，并且只有新记录已创建才吊销此前未消费 Challenge、停止其尚未完成的 Delivery。无匹配 Customer 时不创建 Customer、Challenge、Delivery 或邮箱冷却记录。无请求 ExecutionContext 时，已提交的 Email Delivery 仍由同一 Scheduled Worker 扫描和投递，不增加环境专用发送路径。

Turnstile 已通过、Customer 不存在、Customer 存在但命中冷却、成功创建新链接四个分支的公开响应保持相同，不包含 Customer ID、Challenge ID、冷却剩余时间或是否已发送邮件，并使用相同的缓存头、最短响应时间策略和小幅随机抖动。Magic Link 请求页可以加载 Turnstile 官方资源；携带 Magic Link Token 的 `/auth#token=...` 落地页仍不得加载任何第三方资源。

通知中的 URL 使用固定 Customer Auth 路径与 Fragment 携带 Token，例如 `https://site.example.com/customer/auth#token=...`。落地页不得加载第三方资源，设置 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`，并使用只允许站点资源且 `connect-src` 精确包含 LicenKit API Origin 的严格 Content Security Policy。页面读取 Token 后立即用 `history.replaceState` 清除 Fragment。GET 或页面加载不得消费 Challenge；用户显式点击“继续登录”后才发起消费 POST，避免邮件扫描器提前消费。

### 5.2 消费 Magic Link

```text
POST /api/v1/customer/auth/magic-link/consume
```

```json
{
  "token": "mlk_..."
}
```

服务端对 Token 计算哈希，并在同一 D1 原子批次中写入 `consumed_at` 和与该 Challenge 唯一绑定的 Customer Session。Challenge 的一次性终态必须由数据库约束或 Trigger 在争用失败时直接抛错并回滚整个批次，不能在批次提交后检查条件更新的 `0` 行结果。并发消费最多一个请求成功；失败方不得留下 Session、审计、Delivery 更新或其他副作用。

服务端先以当前请求的 Admin/API Origin 找到 Instance，再用该 `instance_id + token_hash` 查询 Challenge；请求体不能选择或覆盖 Instance。成功响应创建默认 7 天有效的服务端 Session，并设置 HttpOnly、Secure、SameSite=Lax 的 host-only Session Cookie、Instance Cookie 和 CSRF Cookie；三者都不设置 `Domain`。响应正文同时返回 `csrf_token`，服务端只保存 Session 与 CSRF Token 的 Hash。后续会话按 `instance_id + session_token_hash` 查询：跨 Origin 请求要求 Origin 精确等于该 Instance 的 `customer_site_url` Origin；浏览器普通同 Origin GET 允许缺少 Origin，但请求 URL Origin 必须与它相同。状态写入始终要求精确 Origin、`X-CSRF-Token` Header、CSRF Cookie 和当前 Session Hash 四者一致。只有最终 2xx 会 best-effort 更新 `last_seen_at`；更新失败记录 `CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED`，但保留已完成的业务响应，3xx/4xx 不更新。过期、已消费、已吊销、无效 Token 或 disabled Customer 返回统一的 `CUSTOMER_MAGIC_LINK_INVALID`，不能暴露具体匹配状态。

```text
GET  /api/v1/customer/auth/csrf-token
POST /api/v1/customer/auth/logout
```

页面刷新后通过 `GET /customer/auth/csrf-token` 取回当前 Session 已绑定的同一个 CSRF Token；跨 Origin 时该接口验证精确 Customer Site Origin，同 Origin 时验证请求 URL Origin，并继续验证 Session Cookie、CSRF Cookie 与 Session Hash；响应返回 `Cache-Control: no-store`，不会旋转 Token。退出时吊销服务端 Customer Session 并清除 Cookie。所有跨 Origin Customer Auth、读取和写入接口都要求精确 Customer Site Origin；只有 Customer API 返回该 Origin 的 credentialed CORS 响应，Admin、Client 和 Webhook 不扩权。

### 5.3 当前 Customer 与 License

```text
GET /api/v1/customer/me
GET /api/v1/customer/licenses
GET /api/v1/customer/licenses/:licenseId
GET /api/v1/customer/licenses/:licenseId/activations
GET /api/v1/customer/licenses/:licenseId/subscription
```

所有查询必须在持久层同时限定当前 `instance_id + customer_id`。对不属于当前 Customer 的资源统一返回资源不存在，不能通过 ID 枚举其他 Customer 的 License 或 Activation。

Customer 响应不返回注册码哈希、机器令牌哈希、支付 Secret、支付事件原文或内部敏感 Delivery 负载。

`GET .../subscription` 对 `renewal_mode=manual` 返回发行方管理的到期时间且 `billing_subscription=null`；对 `renewal_mode=billing` 返回对应 Billing Subscription；`perpetual` 和 `fixed_term` 返回无订阅关系。客户端不得仅根据 `license_model=subscription` 假设一定存在支付门户。

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

两个接口成功后必须在最近认证页面一次性返回新注册码，并同时创建对应 Email Delivery；响应必须包含 `Cache-Control: no-store`，前端不得持久化或发送分析事件。后续 Provider 投递失败不能回滚已经成功提交的注册码轮换，但必须返回独立邮件状态供页面展示。

两个接口都要求最近 15 分钟内完成认证。超出配置窗口时返回 `CUSTOMER_RECENT_AUTH_REQUIRED`，前端只能引导客户请求新 Magic Link，不能通过确认弹窗代替重新认证。

Customer 不能通过 Customer API 暂停、恢复、吊销 License，不能修改 License Terms、`expires_at` 或 `updates_until`。

### 5.6 进入支付平台管理订阅

```text
POST /api/v1/customer/licenses/:licenseId/subscription/portal-session
```

服务端校验最近认证，并在持久层同时校验当前 Instance、Customer、License、Billing Subscription 和 Billing Provider 归属，然后由对应 Billing Adapter 创建短期支付平台客户门户会话：

```json
{
  "success": true,
  "data": {
    "url": "https://payments.example.com/customer-portal/...",
    "expires_at": "2026-09-19T10:15:00Z"
  }
}
```

该接口只返回支付平台托管 URL，不修改本地 Subscription 或 License。支付平台操作完成后，本地状态仍由后续已验签 Webhook 更新。

该接口只适用于 `renewal_mode=billing`。手动订阅返回 `BILLING_SUBSCRIPTION_NOT_MANAGED`；永久或固定期限 License 返回资源不支持该操作。缺少服务端 API 凭证、外部 Customer ID 或 provider 不支持客户门户时返回明确配置错误，例如 `BILLING_CUSTOMER_PORTAL_NOT_CONFIGURED` 或 `BILLING_CUSTOMER_PORTAL_UNSUPPORTED`，并在内部保留 provider 原始错误。

## 6. 静态产品页不属于 LicenKit API

LicenKit 不提供 Public Checkout API。参考产品页和用户自定义产品页静态维护产品、方案、展示价格、Paddle 环境、Client-side Token 与 Price ID，并直接调用 Paddle.js。Price ID 同时写入 Admin 的 Offer Mapping，服务端在已验签 Webhook 中以 `instance_id + billing_provider_id + external_price_id` 关联 Product 与 License Plan。

浏览器成功回调和成功 URL 都不能触发履约。静态页面可能在 LicenKit 暂时不可用、Offer 已归档或通知链路故障时继续打开 Paddle Checkout；因此入站事件必须先持久化，映射或依赖不满足时保留原始事实并进入 `pending` 或 `needs_attention`；邮件配置未就绪时，对应 Email Delivery 进入 `waiting_configuration`。不得吞掉付款或猜测授权。

Paddle Client-side Token 与 Price ID 可以进入前端；Paddle API Key、Webhook Secret、Email Provider API Key、Template 诊断、Delivery 敏感负载、验证令牌和内部诊断不得进入静态页面。Sandbox 与 Live 必须分别设置 Default Payment Link，Live 产品页必须为实际 Origin 完成 Website Approval 和打开测试。

## 7. Client API

Client API 使用同一组授权状态，而不是让 License、Trial 和无凭据设备各自解释一套错误码。所有成功响应都采用 `{ "success": true, "data": ... }`；请求格式错误、凭据无效、内部配置错误或服务端故障仍采用错误 Envelope，并保留原始 `code`、`request_id` 与安全的 `details`。

在线确认成功不等于授权可用。调用方必须读取 `data.state`：可用状态是 `license.active` 或 `trial.active`；到期、吊销、暂停、Activation 已失效、Release 不合格以及需要激活都是成功读取到的业务事实。

`activate`、`validate` 和 `trials/claim` 的成功响应都包含：

```json
{
  "validation": {
    "validation_interval_seconds": null,
    "validated_at": "2026-09-23T10:00:00.000Z"
  },
  "meta": {
    "request_id": "req_01..."
  }
}
```

`validated_at` 由服务端生成，表示这份业务状态何时被确认。`validation_interval_seconds` 为 `null` 时，Swift SDK 使用 3600 秒默认值；非空值限制在 3600 至 86400 秒之间。它们不等同于 Swift SDK 的最近 `/validate` 响应时间：激活和领取 Trial 虽然返回已确认业务状态，但不会启动 `/validate` 冷却。

Swift SDK 对 `/validate` 同时应用服务端建议间隔和硬编码 30 秒门槛；只有本地 Signed License Token 已过期或无效时可以绕过建议间隔，但仍不能绕过 30 秒门槛。两个门槛都从最近一次明确 `/validate` Server 结果开始计算：合法的成功业务响应，或已收到 HTTP 状态的失败响应。DNS、TLS、超时、断网等没有 HTTP 响应的失败，以及 HTTP 2xx 但正文不符合合同的响应，都不能推进这两个时间。HTTP 失败可以推进 `/validate` 响应冷却，但不得改写 `validated_at` 或伪造新的业务快照。LicenKit CLI 只共享这些网络字段和状态合同；当前每次显式执行 `licenkit validate` 都会联网，不使用 Swift SDK 的本地双门槛。

### 7.1 激活

```text
POST /api/v1/client/activate
```

请求：

```json
{
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
    "signed_license_token_expires_at": null,
    "signing_key_id": null,
    "license_expires_at": null,
    "terms": {
      "license_model": "perpetual",
      "renewal_mode": "manual",
      "max_activations": 3,
      "features": ["pro_export"],
      "updates_until": "2027-09-19T10:00:00Z"
    },
    "state": {
      "kind": "license",
      "status": "active",
      "expires_at": null,
      "terms": {
        "license_model": "perpetual",
        "renewal_mode": "manual",
        "max_activations": 3,
        "features": ["pro_export"],
        "updates_until": "2027-09-19T10:00:00Z"
      }
    },
    "validation": {
      "validation_interval_seconds": null,
      "validated_at": "2026-09-23T10:00:00.000Z"
    },
    "meta": {
      "request_id": "req_01..."
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

`state.expires_at` 与兼容字段 `license_expires_at` 都表示最终授权截止时间。对 `renewal_mode=billing` 的订阅，它已经包含该 License 固化的支付宽限期；调用方不得再次叠加 `payment_grace_seconds`。

`signed_token_ttl_seconds` 只用于服务端计算签发时的绝对到期时间，不要求大于或等于在线校验间隔，也不会作为原始 TTL 数值写入 Token。实际 `exp` 取“签发时间 + License 快照 TTL”与 License 最终有效截止时间（如有）中的较早值；对 billing 订阅，后者已包含支付宽限。Signed License Token Payload 写入绝对 `exp`；明文响应字段 `signed_license_token_expires_at` 是同一时刻的镜像，SDK 必须验证它与签名保护的 `exp` 完全一致。Token 提前到期时，客户端下一次主动调用 `validate()` 可以绕过建议间隔，但仍受硬编码 30 秒门槛约束。

### 7.2 在线验证

```text
POST /api/v1/client/validate
```

请求固定携带 Product、设备指纹和当前构建的 Release 身份；Server 通过全局唯一 Product ID 解析 Instance。`credential.kind` 决定本次校验哪种凭据：

```json
{
  "product_id": "prd_01...",
  "fingerprint": "sha256:...",
  "release_version": "2.4.0",
  "release_platform": "macos-universal",
  "credential": {
    "kind": "license",
    "activation_id": "act_01...",
    "machine_token": "mtk_..."
  }
}
```

三种合法的 `credential` 形状是：

| `kind` | 附加字段 | 用途 |
| --- | --- | --- |
| `license` | `activation_id`、`machine_token` | 校验已激活 License |
| `trial` | `trial_id`、`trial_token` | 校验已经领取的设备 Trial |
| `none` | 无 | 查询当前 Release 是否已登记，以及此设备是否还能领取 Trial |

验证响应固定包含 `state`、`validation` 和 `meta`。仅 License 校验可以额外包含 `credential_update`；`signed` 模式借此原子刷新 Signed License Token，`opaque` 模式返回空的签名字段。Trial 和 `none` 响应不得包含 `credential_update`。

```json
{
  "success": true,
  "data": {
    "state": {
      "kind": "license",
      "status": "active",
      "expires_at": "2026-10-01T10:00:00.000Z",
      "terms": {
        "license_model": "subscription",
        "renewal_mode": "billing",
        "max_activations": 3,
        "features": ["pro_export"],
        "updates_until": null
      }
    },
    "credential_update": {
      "credential_mode": "signed",
      "signed_license_token": "base64url.base64url.base64url",
      "signed_license_token_expires_at": "2026-09-23T11:00:00.000Z",
      "signing_key_id": "key_01..."
    },
    "validation": {
      "validation_interval_seconds": null,
      "validated_at": "2026-09-23T10:00:00.000Z"
    },
    "meta": {
      "request_id": "req_01..."
    }
  }
}
```

激活和在线校验都必须携带 App 内置的版本标识和平台。服务端在当前 Instance 与 Product 下查找受信 Product Release；查不到时返回 `PRODUCT_RELEASE_UNKNOWN`。对受版本期限约束的永久 License，受信 `released_at > updates_until` 返回 `UPDATE_ENTITLEMENT_REQUIRED`；该错误不改变 License 状态，也不能转换成 `LICENSE_EXPIRED`。

激活和在线校验在其他 License 状态判断前拒绝 `is_checkout_verification=1`，返回 `LICENSE_CHECKOUT_VERIFICATION_ONLY`。管理员恢复、状态编辑和方案迁移也不得清除该标记；验证注册码只能证明邮件闭环，不能成为可用授权。

### 7.3 统一授权状态

`state.kind` 与 `state.status` 是业务判断入口：

| `kind` | `status` 或子状态 | 关键字段 | 是否可用 |
| --- | --- | --- | --- |
| `activation_required` | `trial.available` | `duration_seconds`、`features` | 否；用户可选择领取 Trial |
| `activation_required` | `trial.unavailable` | `reason`、`code` | 否 |
| `trial` | `active` | `expires_at`、`features` | 是，但仍受客户端新鲜度窗口约束 |
| `trial` | `expired` / `revoked` | 原始 `code`，以及到期或撤销信息 | 否 |
| `license` | `active` | `expires_at`、`terms` | 是，但仍受客户端新鲜度窗口和签名 Token 到期约束 |
| `license` | `expired` / `suspended` / `revoked` | 原始 `code` 与可用诊断字段 | 否 |
| `license` | `activation_revoked` / `activation_deactivated` | 原始 `code` | 否 |
| `release_not_eligible` | `unknown_release` | `PRODUCT_RELEASE_UNKNOWN`、版本、平台 | 否 |
| `release_not_eligible` | `update_required` | `UPDATE_ENTITLEMENT_REQUIRED`、`updates_until`、`released_at` | 否 |

对 active Product，无凭据请求中的未知 Release 返回顶层 `release_not_eligible.unknown_release`，不会伪装成“Trial 不可用”。Trial 未启用或设备已经领取过分别返回 `activation_required + trial.unavailable(not_enabled)` 与 `activation_required + trial.unavailable(already_claimed)`。已归档 Product 仍是调用失败，返回 `PRODUCT_UNAVAILABLE`；Product 不存在返回资源不存在。无凭据响应不会返回历史 `trial_id` 或 Trial Token。

到期、吊销等状态仍可携带 `code` 和安全的 `details`。客户端缓存业务快照时必须保留这些字段；脱敏应按字段处理 Token、Secret、密码、注册码和 Authorization，不能整包丢弃诊断信息。

### 7.4 无需支付方式的 Product/设备试用

```text
POST /api/v1/client/trials/claim
```

领取请求：

```json
{
  "product_id": "prd_01...",
  "fingerprint": "sha256:...",
  "device_platform": "macos-arm64",
  "release_version": "2.4.0",
  "release_platform": "macos-universal"
}
```

服务端要求 Product 为 active 且已启用试用，并在当前 Instance 与 Product 下找到受信 Product Release。首次领取以 `Cache-Control: no-store` 返回一次 Trial Token：

```json
{
  "success": true,
  "data": {
    "trial_id": "trl_01...",
    "trial_token": "ttk_...",
    "status": "active",
    "expires_at": "2026-10-03T10:00:00Z",
    "features": ["pro_export"],
    "state": {
      "kind": "trial",
      "status": "active",
      "expires_at": "2026-10-03T10:00:00Z",
      "features": ["pro_export"]
    },
    "validation": {
      "validation_interval_seconds": null,
      "validated_at": "2026-09-23T10:00:00.000Z"
    },
    "meta": {
      "request_id": "req_01..."
    }
  }
}
```

服务端只保存 Token 哈希。重复或并发领取同一 `instance_id + product_id + fingerprint` 返回 `TRIAL_ALREADY_CLAIMED`，不得延长到期时间或再次返回 Token；这项业务唯一性由 D1 唯一约束承担。Trial Claim 与校验接口的流量保护由 Cloudflare Zone 级 WAF Rate Limiting Rules 按方法、路径和部署套餐支持的请求特征配置，不在应用内复制通用计数状态。

后续 Trial 校验使用 7.2 的统一 `/validate`，提交 `credential.kind=trial`。服务端同时限定 Instance 与 Product，验证 Token 哈希、设备绑定、吊销状态、绝对到期时间和 Product Release；成功时更新 `last_validated_at`。未知 Release、到期和吊销分别得到 `release_not_eligible.unknown_release`、`trial.expired` 和 `trial.revoked`，不得归一化成 License 错误。V1 Trial Claim 不签发 Signed License Token。

Paddle 免费订阅试用不调用这两个接口。它在已验签支付事件履约后得到普通 License Key，随后走 7.1 和 7.2 的正常 License 激活与校验合同。

### 7.5 主动解绑

```text
POST /api/v1/client/deactivate
```

请求携带 `product_id`、`activation_id`、`machine_token` 和 `fingerprint`；Server 通过 Product ID 解析 Instance。服务端成功后 Activation 进入 `deactivated` 并返回 `meta.request_id`。网络失败时 SDK 不能假装远端已经释放席位，也不能清除仍可用于重试的本地 Machine Token。若本地原本没有 License 凭据，SDK 可以返回 `wasDeactivated=false` 的本地结果，但这不是一次服务端确认。

### 7.6 公钥集合

```text
GET /api/v1/client/products/:productId/signing-keys
```

该接口用于诊断和密钥轮换信息发布，不能替代 App 内置的信任根。响应包含 key ID、状态和公钥，不包含私钥。

## 8. Payment Inbound Webhook

```text
POST /api/v1/webhooks/payments/:instanceId/paddle/:environment
POST /api/v1/webhooks/payments/:instanceId/paddle/:environment/simulator
```

V1 的支付渠道是 Paddle，`:environment` 只能是 `sandbox` 或 `live`。每个环境都配置两条 Paddle URL Notification Destination：不带 `/simulator` 的地址用于 `traffic_source=platform` 正式业务事件，带 `/simulator` 的地址用于 `traffic_source=simulation` 的 Simulator 测试事件。两条 Destination 使用独立 Secret，不能复用地址或 Secret；Sandbox 与 Live 都遵循同一结构。同一 Instance 的每个 Paddle 环境只允许一条 Billing Provider 配置。

正式业务入口的处理顺序固定为：

1. 根据路径中的 Instance ID 读取 Instance，再以 `instance_id + provider=paddle + environment` 读取唯一 Billing Provider 配置；
2. 对原始请求体执行渠道签名验证；
3. 提取稳定的外部事件 ID；
4. 提取事件中存在的外部 Customer、Transaction、Subscription 与 Adjustment ID，并尝试写入 Inbound Event；
5. 重复事件先核对已保存的 payload Hash：Hash 不同表示同一 Event ID 对应了冲突事实并返回 409；Hash 相同则返回已有接收结果。若该事件尚未完成且加密 payload 已清理或过期，本次已验签重投只恢复同一事件的 payload 与到期时间，不复制事件，也不清空事件已有的错误；
6. 新事件持久化成功后返回 2xx；
7. 请求后立即尝试履约以降低延迟；
8. 即时处理未完成时，由 Scheduled Worker 根据同一条 Inbound Event 恢复。

路径中的 Paddle 环境只用于定位该 Instance 的支付通道配置，不能替代验签，也不从请求体接受 `instance_id`。Sandbox 与 Live 使用同一处理流程，区别只来自对应环境的 Billing Provider 配置。没有签名配置时返回配置错误，不得继续处理。

Simulator 入口复用完全相同的原始请求体验签和 Paddle Envelope 解析逻辑，但验证自己的 Simulator Secret，且只按 `event_type` 保存测试时间、外部 Event ID、payload Hash 与 Secret 版本。模拟数据不得写入正式 `inbound_events`，不得创建 Customer、License、Subscription 或 Delivery，也不得进入履约状态机。这样 Simulator 可以证明测试目标、Secret 和共享解析逻辑能够处理某一类事件，但不能冒充真实业务事件。

只有 Inbound Event 已可靠持久化才返回 2xx。签名无效返回 4xx，数据库写入失败返回 5xx 让 Paddle 重试；事件已持久化后的 Customer API 超时、依赖未齐或履约失败不再改变本次接收响应，由内部状态机和 Scheduled Worker 重试，避免把 Paddle 重投当作内部任务队列。

当前必需事件由该 Provider 下未归档 Offer 的购买类型决定。仅有一次性购买时为 5 类：`customer.created`、`customer.updated`、`transaction.completed`、`adjustment.created`、`adjustment.updated`；存在任一订阅 Offer 时再加入 `subscription.created`、`subscription.updated`，共 7 类。Platform 与 Simulator Destination 必须订阅同一份当前清单，管理员必须在 Paddle Simulator 中为每一类分别发送 Single event；一次模拟事件不能证明其他事件可被解析。Simulator Secret 修改后必须重新完成全部当前必需事件测试；新增订阅 Offer 后只会新增尚未验证的订阅事件要求。

逐事件 Simulator 证据只用于验证测试目标和共享解析合同，不证明 Platform Destination 已正确订阅这些事件。正式入口的 `webhook_verified_at` 只能由当前 Platform Secret 下收到的真实 `traffic_source=platform` 事件形成；完整的正式业务闭环仍需在 Sandbox 通过真实 Checkout 验证，并在 Live 上线后观察真实事件。LicenKit 不要求 API Key 才能读取远端订阅配置，也不把 API Key 当作 Webhook 完整性的替代品。

Customer 事件 upsert Billing Customer 镜像并尝试建立内部映射。购买事件先按外部 Customer ID 查询映射；缺失时以 `BILLING_CUSTOMER_PENDING` 保持 `pending` 并等待 Customer 事件。只有配置了具备 `customer.read` 权限的 API Key 时才调用 Paddle Get Customer 加速恢复，API 失败不改变 Webhook 等待路径。

只有 `link_status=linked` 才能创建新 License 和发码 Delivery。`email_mismatch`、无效/归档 provider Customer 或无法安全链接时进入 `needs_attention`。已有 Subscription 的续费根据 Subscription 直接更新原 License，不重新按邮箱链接。处理器不得读取 `custom_data.email`、Checkout 参数或调用方自报邮箱作为发码身份。

普通首次购买还必须根据已验签 Transaction 行项目验证：恰好一个行项目、`quantity=1`、Price 命中当前 active Offer、Offer Provider 环境等于 Product `billing_environment`，并且 Offer、Product、Plan 和 `purchase_type` 一致。任何不满足项都以保留外部 Transaction、Price、数量、Provider 环境、Product 环境和事件 ID 的具体错误进入 `needs_attention`，不创建 Customer、License、Subscription 或 Delivery；不能选择第一项、忽略附加项目或按总金额猜测授权。

唯一例外是首次验证 Transaction 的 `custom_data.licenkit_checkout_verification` 通过哈希等值查询命中同 Instance、当前 Offer 的 `pending` Checkout Verification，且令牌未过期、Provider 为 Sandbox、Price 和数量完全匹配。服务端以条件更新原子消费该令牌，再调用同一 Fulfillment Service 创建 `is_checkout_verification=1`、`suspended + checkout_verification` 的 License 和发码 Delivery；Delivery accepted 后验证状态才变为 completed。错误、过期、重复、Offer 不匹配或 Live Provider 的令牌进入 `needs_attention`，不得回退到普通付款。除这个窄用途随机令牌外，其他 `custom_data` 仍不得参与 Customer、Product、Plan 或授权身份判断。

Paddle 会把 Checkout Transaction 的 custom data 复制到新 Subscription，并继续复制到该 Subscription 的后续 Transaction。处理器必须先按已验签事件中的外部 Subscription ID 查询既有 Billing Subscription：如果它绑定验证 License，则后续事件按验证订阅镜像处理，不再次消费 token，也不因为 token 已使用而产生新的 `needs_attention`。只有尚无已绑定 Subscription 的首次交易才允许令牌开启验证履约。

对配置了免费试用的 Paddle recurring price，Adapter 必须从已验签事件取得 Subscription 的 `trialing` 状态、当前试用周期和下一扣款时间，再由统一 Fulfillment Service 原子创建 `subscription + billing` License、Billing Subscription 和首次发码 Delivery。`subscription.created` 和 `transaction.completed` 可以乱序到达；事实不足时 Inbound Event 保持 `pending`、把 `BILLING_DEPENDENCY_PENDING` 写入 `last_error_code` 并由同一调度器重试，不能创建半成品或对支付平台返回失败以诱发无界即时重投。试用转为 `active` 或 `past_due` 时只更新同一 License 与 Subscription；不得根据前端 Checkout 参数、未验签回调或本地计时器自行认定试用开始或结束。

若 Billing Subscription 绑定 `is_checkout_verification=1` 的 License，后续 `subscription.updated`、续费、试用转正或付款恢复只能更新支付镜像和验证诊断，不能把 License 改为 active、清除验证标记或再次发码；数据库约束应使错误状态更新直接失败并保留原始事件。此规则优先于后续 Transaction 中被 Paddle 复制的已消费 verification token。

`adjustment.created|updated` 必须按外部 Adjustment ID 幂等写入 Billing Adjustment。只有 `refund + full + approved` 和 `action=chargeback` 自动暂停已明确关联的 License，且不吊销 Activation；两者仍把 Adjustment 设为 open、Inbound Event 设为 `needs_attention`，等待管理员决定。`refund + pending_approval`、已批准部分退款、`chargeback_warning`、反转和无法关联的 Adjustment 同样进入 `needs_attention`，但不自动改变 License。`refund + rejected` 与 credit 类事件保留记录、标记 processed 且默认不改变授权。任何反转都不能隐式恢复 License；管理员通过独立 resolve API 决定 `no_action`、保持暂停、恢复、吊销或安全重置。扣款失败、取消、退款和拒付保留各自的 provider 事件类型、action、type、status、金额和原因。

## 9. Email Provider 发送边界

LicenKit Worker 通过 Email Provider Adapter 直接发送邮件。V1 Resend Adapter 把已校验的通用消息转换为 Resend Email API 的 From、To、Reply-To、`template.id` 与 `template.variables`，使用加密 API Key 认证，并携带 Delivery 派生的幂等键。Provider API 目标由 Adapter 固定，管理请求不能传入任意 URL。

正式主题、HTML、文本和已发布模板版本在 Provider 中管理。LicenKit 可以通过一次性安装操作创建初始 Resend 模板；Binding 建立后只保存 Template Reference、Contract Version、变量和投递证据，不再维护远程模板内容或一致性。因此 LicenKit 可以证明某次请求使用了哪个 Template Reference 与变量，但不能还原 Provider 最终渲染内容。

Resend 成功响应必须包含有效 Message ID；否则记为 Provider 协议错误。成功后 Delivery 进入 `accepted`，该状态不等于最终送达、进入收件箱或已读。V1 不接收 Resend bounce/complaint/suppression Webhook 来更新最终送达状态。

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

邮件与业务事件是两类 Delivery，不能因为配置了通配 `event_subscriber` 端点就自动触发客户邮件。

订阅事件负载必须携带 `renewal_mode`；`subscription.renewed` 还携带 `renewal_source=manual|billing`，避免接收方把管理员续期误当成支付成功。Paddle provider 的原始事件类型和 ID 仍保存在来源字段中，不能被内部事件名覆盖。
