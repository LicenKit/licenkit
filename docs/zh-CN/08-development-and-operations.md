# 开发、配置与运行

## 1. 当前工程

```text
licenkit/
├── apps/server             # Hono + Cloudflare Workers + D1 + Drizzle
├── apps/admin              # React + Vite 管理控制台
├── apps/cli                # 命令行客户端
├── wrangler.jsonc          # 当前实例的 Cloudflare Worker 配置
├── dist/admin              # LicenKit Admin 部署产物
└── docs                    # V1 设计合同
```

Swift SDK 位于独立仓库 `licenkit-sdk-swift`。

## 2. 本地命令

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` 只启动 Server 与 Admin；`build`、`typecheck`、`test` 和 `deploy` 不包含产品官网、Magic Link 页面或 Customer Portal。仓库不保存这些页面的示例前端源码。

具体脚本以根目录 `package.json` 为准。重新生成 V1 migration 前，不对旧原型数据库执行兼容迁移。

根目录 `wrangler.jsonc` 是当前实例唯一的 Worker 配置来源。使用者 fork 仓库后直接修改数据库 ID、变量、环境与触发器；开发、迁移、构建和部署都读取同一文件，不选择或合并模板与覆盖配置。Secrets 仍通过 Wrangler Secret 管理，不写入该文件。

Admin 固定构建到 `dist/admin`，Worker 只在 `/admin` 路径读取静态资产；其他非 API、非 Admin 路径返回 404，根路径重定向到 `/admin/`。

Setup 时必须显式填写产品站与 Customer Portal 的 `siteUrl`，服务端用它生成邮件中的 Magic Link。当前 `siteUrl` 与 `appUrl` 必须同源；产品页只连接 Paddle，Magic Link 与 Customer Portal 通过同源 `/api/v1` 调用 LicenKit。LicenKit 不负责部署这些页面。

## 3. 环境配置

### 3.1 Worker Secrets

| 名称 | 作用 |
| --- | --- |
| `STORAGE_ENCRYPTION_KEY` | 加密签名私钥、支付 Webhook Secret、支付平台服务端 API 凭证、出站 Secret 和敏感 Delivery 负载 |
| `INITIAL_SETUP_TOKEN` | 独立部署首次 Setup 使用的一次性高熵 Secret；初始化完成后可以移除 |
| `TURNSTILE_SECRET_KEY` | Worker 调用 Turnstile Siteverify 的服务端 Secret；不返回浏览器 |

Secret 不进入代码、普通环境变量文件、日志、审计详情或 API 响应。

`STORAGE_ENCRYPTION_KEY` 使用带版本的 AES-256-GCM 信封格式。每条密文包含 key ID、随机 96-bit nonce、ciphertext 和 tag，AAD 绑定 `account_id + table + row_id + field`。轮换时新写入使用新 key，旧 key 在完成重加密前只保留解密能力。

### 3.2 Worker Variables

| 名称 | 作用 |
| --- | --- |
| `TURNSTILE_SITE_KEY` | Magic Link 请求页渲染 Turnstile Widget 的公开 Sitekey |
| `CUSTOMER_MAGIC_LINK_TTL_SECONDS` | Magic Link 最长有效时间；默认 `900`（15 分钟） |
| `CUSTOMER_MAGIC_LINK_COOLDOWN_SECONDS` | 同一 Customer 重复请求新 Magic Link 的 D1 冷却时间；默认 `60` |
| `CUSTOMER_SESSION_TTL_SECONDS` | Customer Session 服务端最长有效时间；默认 `604800`（7 天） |
| `CUSTOMER_RECENT_AUTH_SECONDS` | 敏感操作最近认证窗口；默认 `900`（15 分钟） |
| `SENSITIVE_DELIVERY_PAYLOAD_TTL_SECONDS` | 未成功敏感 Delivery 负载的最长保留时间；推荐默认 `86400`（24 小时） |
| `ADMIN_SESSION_TTL_SECONDS` | 管理员服务端 Session 最长有效时间 |

这些值在测试和正式环境使用相同代码路径，只允许显式配置值不同。未配置时使用上述默认值，不能因环境名称隐式改变。Delivery 创建时把实际截止时间固化到 `payload_expires_at`；Magic Link 取该值与 Challenge 到期时间中的较早者，accepted 后不等待 TTL 而是立即清除负载。

### 3.3 Cloudflare Bindings

| Binding | 作用 |
| --- | --- |
| `DB` | D1 主数据库 |

V1 不配置 Cloudflare Queue producer 或 consumer binding。后台工作由 D1 持久状态和 Scheduled Worker 驱动。

V1 也不配置 KV、Durable Object 或 Workers Rate Limit binding。部署者必须在 Cloudflare Zone 级 WAF Rate Limiting Rules 配置边缘保护；建议至少按方法与路径覆盖 Setup 写入、管理员登录、管理端写操作、客户端激活/校验/解绑、Trial Claim/校验、Customer 敏感写操作和 Webhook 测试。规则能力与阈值取决于实际流量和所用 WAF 套餐，不作为应用内固定额度。Magic Link 请求另由 Turnstile 和 D1 Login Challenge 冷却共同保护。

### 3.4 Scheduled Trigger

默认每分钟运行一次统一调度入口：

```text
* * * * *
```

每次运行使用有界批次分别处理：

1. 到期的 `inbound_events`；
2. 到期的 `outbound_deliveries`；
3. 已超过 `locked_until` 的 processing 任务；
4. 到期的敏感负载和保留数据清理。

即时处理和定时处理调用同一个 Fulfillment/Delivery Service，不能维护两套业务逻辑。每轮先处理可领取的 Inbound Event 与 Delivery，再以有界批次清空已超过 `payload_expires_at` 的 Inbound Event 密文并写入 `payload_cleared_at`；即使事件被 System Issue 阻塞也不能无限保留密文。Cron 频率、批次大小、租约时长和退避参数可以配置，但测试与正式环境使用同一调度模块。

只有上述统一调度入口的全部作业成功后，Worker 才更新 D1 `system_settings.scheduler_last_success_at` 与 `scheduler_last_duration_ms`。Readiness 以这组持久事实判断调度器是否在阈值内运行；自部署 V1 不为心跳配置 KV、Durable Object 或进程内共享状态。

### 3.5 数据库配置

以下内容通过控制台写入数据库，不作为 Worker 环境变量：

- Billing Provider 的环境、公开 Client-side Token、加密 Webhook Secret 和可选服务端 API 凭证；只有启用 Customer API 读穿/对账或托管客户门户时，Paddle API Key 才分别需要 `customer.read` 或 `customer_portal_session.write`；
- 默认 draft 的 Offer Mapping；
- Notification Gateway URL 和加密签名 Secret；
- License Plan；
- Product Release；
- Product/设备级免费试用配置；
- 账户业务设置，包括默认 `432000` 秒的订阅支付宽限期。

### 3.6 首次安装 Setup

V1 独立部署流程：

1. 部署前生成高熵 `INITIAL_SETUP_TOKEN` 并写入 Worker Secret；
2. 访问 Setup 页面，填写实例/初始 Account 名称、管理员姓名、邮箱和密码，并手动输入 Setup Token；
3. 服务端确认 `system_settings`、Account 和 User 均为空；
4. 在一个 D1 `batch()` 中创建固定 `system_settings` 行、首个 Account、首位 owner User、管理员 Session 和 Setup 审计；
5. 成功后设置管理员 Cookie，Setup POST 永久返回 `SETUP_ALREADY_COMPLETED`；
6. 从部署环境移除 `INITIAL_SETUP_TOKEN`。

Setup Token 不放入 URL、命令输出、日志或数据库。并发提交、错误 Token、弱密码、重复邮箱以及部分语句失败都要有负向测试。重新初始化只允许重建明确的空数据库，不提供“删除初始化状态”接口。

LicenKit Cloud 不属于 V1。代码只保留内部 Account Provisioning 接口和多账户约束，不增加 Cloud 路由、Cloud Adapter、Cloud 配置或第二套初始化流程。

## 4. V1 初始化迁移

由于 V1 没有旧数据兼容要求：

1. 先完成 `schema.ts`；
2. 对照 [`04-data-model.md`](./04-data-model.md) 和 [`schema.sql`](../schemas/schema.sql) 复核；
3. 删除旧原型 migration；
4. 生成一个新的 V1 初始 migration；
5. 在全新本地 D1 执行 migration；
6. 运行唯一约束、事务和级联行为测试；
7. 验证只有 `perpetual` 可以设置 `update_window_seconds` 和 `updates_until`；
8. 验证 Customer 邮箱、Magic Link Token、Customer Session Token 的唯一约束和关联索引；
9. 验证所有租户父表的 `(account_id, id)` 唯一键和子表复合外键；
10. 为每一类租户关联构造账户 A 子记录引用账户 B 父记录，并断言数据库拒绝；
11. 验证激活数 Trigger 在并发插入和重新激活时拒绝超限；
12. 验证 Product Release 身份字段更新和物理删除由数据库 Trigger 拒绝；
13. 验证 `system_settings` 初始化闩锁不能删除，两个并发 Setup 只有一个成功且不会留下半初始化记录；
14. 验证非订阅方案不能保存非零支付宽限期，Account 默认值只在新建订阅方案时解析，License 保存独立快照；
15. 验证 `perpetual + none` 允许 `expires_at=NULL`，`fixed_term + none` 必须到期，且手动/API 可以创建 `subscription + manual`；
16. 验证手动订阅必须有未来到期时间、支付字段为空且 `payment_grace_seconds=0`，支付订阅必须是 `subscription + billing` 并具备外部交易引用；
17. 验证手动续期只能把同一个 License 延长到更晚时间，不能修改支付续期 License，也不轮换注册码；
18. 验证同一 Account、Product 和设备指纹不能并发创建多个 Trial Claim，Trial Token Hash 不能重复；
19. 验证 `trialing` Billing Subscription 必须保存支付方式必需的试用类型、试用起止和下一扣款时间；
20. 验证 Notification Endpoint 默认 `max_automatic_attempts=4`，Delivery 固化该值，人工 retry 不重置或增加自动预算；
21. 验证 Billing Customer 的外部 Customer ID 唯一键、链接状态与可空 `customer_id` 检查约束；
22. 验证 Billing Subscription 的 `external_customer_id` 必须通过同账户、同 Provider 的复合外键命中 Billing Customer，跨账户或未知 Customer ID 均被数据库拒绝；
23. 验证相同外部 Customer ID 在不同 Provider 或 environment 下可以独立存在、同一 Provider 连接内不能重复，并验证一个 LicenKit Customer 可以关联多条 Billing Customer；
24. 验证所有映射 Repository 查询必须同时携带 `account_id + billing_provider_id + external_customer_id`，不存在只按外部 Customer ID 的方法；
25. 验证 Product `slug` 在 Account 内唯一，Paddle Client-side Token 前缀与 Provider 环境匹配，API Key 允许为空；
26. 验证 Offer 默认 `draft`，未通过 Checkout Readiness 时不能激活；
27. 验证 Billing Adjustment 外部 ID 唯一、review/resolution 字段组合约束和跨账户外键；
28. 验证 Admin/Customer CSRF Token Hash 各自唯一并绑定对应 Session；缺少或不匹配精确 Origin、CSRF Header、CSRF Cookie、Session Hash 任一条件时，Cookie 鉴权写操作均被拒绝；
29. 验证 Checkout Verification 创建后不能改绑 Account、Offer、发起人或 Token，也不能延长过期时间；
30. 验证 `system_issues` 对同一账户、Provider、capability 和错误码只保留一行，重复发生增加次数，resolved 后再次发生重新打开同一行；
31. 验证 `system_issue_inbound_events` 不重复关联同一 Event，并且跨账户 Issue/Event 外键被拒绝；
32. 验证非空 `blocking_system_issue_id` 阻止 Scheduler 领取 Event；仅解决 Issue 不会隐式唤醒 Event，而解除当前阻塞不删除永久 Issue/Event 关联；
33. 在 migration 发布前冻结并评审。

不得先生成迁移再反向修改文档来迎合偶然的表结构。

## 5. Notification Gateway 联调

外部接收方至少实现：

1. 读取原始 HTTP body；
2. 验证 `X-LicenKit-Timestamp` 和 `X-LicenKit-Signature`；
3. 按 `X-LicenKit-Delivery` 幂等；
4. 将消息可靠写入自己的邮件发送任务存储；
5. 写入成功后返回 2xx；
6. 写入失败时返回非 2xx 和可诊断错误。

LicenKit 的 Endpoint Test 只发送 `endpoint.test`，不会携带真实注册码，也不会创建 License。

真实联调需要覆盖：

- 首次发码；
- 接收端 500 后自动 retry；
- 接收端超时；
- 签名 Secret 错误；
- 重复 Delivery；
- 人工 retry；
- 首次失败后最多自动重试 3 次，并为最多 4 次请求分别保存 Attempt；
- Endpoint URL 或 Secret 轮换后，旧 Delivery 仍使用创建时快照；
- HTTP、URL credentials、非标准端口、IP literal、localhost、私网、链路本地、云元数据地址和跳转到这些目标的重定向全部被拒绝且不产生请求；
- 注册码找回生成新码；
- Magic Link 通知、自动 retry 和过期后拒绝消费；
- Notification Gateway 接受后立即清除敏感负载；
- 未成功敏感负载默认 24 小时到期，Magic Link 以 15 分钟为更早上限，负载到期后拒绝 retry。
- 缺少 Gateway 或 Endpoint Test 未 accepted 时，Checkout Readiness 失败且 Offer 不能激活；
- 异常产生的 `blocked_configuration` Delivery 在配置完成后只能通过显式绑定动作恢复；负载过期时必须轮换注册码。

## 6. 支付平台联调

V1 首个且必须完成的支付闭环是 Paddle。Paddle Adapter 使用官方 Sandbox 和官方 Webhook 签名流程；Live 只替换 Provider 环境和 Secret，不切换处理模块。测试顺序：

1. 配置 Billing Provider 的环境匹配 Client-side Token 与 Webhook Secret；暂不配置 API Key，证明基础购买、Customer 映射和发码不依赖它；
2. 创建 Product `slug`、选择唯一 `billingEnvironment` 并创建 draft Offer，确认不同环境 Offer、缺少 Notification Gateway、事件合同或验收证据时无法激活，管理端展示具体检查项；
3. 订阅最小合同 `customer.created`、`customer.updated`、`transaction.completed`、`subscription.created`、`subscription.updated`、`adjustment.created`、`adjustment.updated`，逐项发送官方模拟事件并验证能够验签、持久化和被 Readiness 识别；轮换 Webhook Secret 后旧证据必须失效；
4. 配置并测试 Notification Gateway，确认 `endpoint.test` 为 accepted 后联通状态更新；
5. owner/admin 通过 POST draft Sandbox Offer 的 `verification-config` 创建短期一次性令牌，并由 Admin 内部 Paddle.js 调用完成首个真实 Sandbox Checkout；只打开一个 Price、数量 1，令牌不进入日志、URL、localStorage 或分析事件；
6. 在 Paddle Sandbox 与 Live 分别设置 Default Payment Link；为实际 Live 产品页完成 Website Approval，并在该 Origin 运行一次不付款的 Checkout 打开测试；未批准 Origin 或缺少 Default Payment Link 时保留 Paddle 原始错误并 fail-fast；
7. 验证外部 Customer ID 映射到唯一 LicenKit Customer，首次发码只使用 Paddle Customer 实体中的邮箱，不读取 `custom_data.email` 或 Checkout 自定义邮箱；
8. 验证 Sandbox 闭环只创建一组标记为 Checkout Verification 的 suspended License/Subscription（如有）/Delivery，注册码通过 Notification Gateway 发出但激活、恢复和迁移均被拒绝；Delivery accepted 后 verification 才 completed，Offer 才可通过后续激活检查；
9. 激活与 Product 环境一致的 Offer 后，从静态产品页用对应 Price ID 打开 Checkout；直接构造多 Price、数量大于 1、未知 Price、draft Offer、Provider/Product 环境不一致、过期或重复验证令牌交易，分别进入 `needs_attention` 且不发正式 License；
10. 使用配置免费试用期的 recurring price 完成要求预先绑定支付方式的真实 Sandbox Checkout；
11. 验证已验签事件创建 `trialing` Billing Subscription、普通 License 和首次发码 Delivery，且不创建 Trial Claim；
12. 触发试用结束后的真实扣款或官方时间模拟，验证同一 License 从试用周期转入付费周期；
13. 触发真实续费或时间模拟并验证同一 License 延期；
14. 测试试用结束或正常续费时的扣款失败、恢复和取消；
15. 验证扣款失败后按 License 固化值执行 5 天宽限期，Account 默认值变化不影响存量 License；
16. 分别模拟待审批全额退款、已批准全额退款、已批准部分退款、rejected 退款、`action=chargeback`、`chargeback_warning` 和 reverse；验证只有已批准全额退款与 `action=chargeback` 自动暂停，均不吊销 Activation，反转不自动恢复；
17. 对 open Billing Adjustment 分别执行保持暂停、恢复、吊销、安全重置和 no action，验证权限、状态变化与审计；
18. 重放相同事件验证幂等；
19. 分别让 Paddle `subscription.created` 与 `transaction.completed` 先到，验证依赖未齐时保持可重试、齐全后只创建一组 License/Subscription/Delivery；
20. 对订阅验证交易触发一次后续 Subscription/续费事件，验证 Paddle 复制的 verification custom data 不会再次消费令牌、不创建新 License/Delivery，也不会把验证 License 改为 active；
21. 分别让新 Customer 的 `customer.created` 先到、购买事件先到，并让已有 Paddle Customer 再次购买；购买先到时以 `BILLING_CUSTOMER_PENDING` 等待 Customer Webhook，三条路径最终只履约一次；
22. 另外配置只具备 `customer.read` 的 API Key，验证购买先到时 Get Customer 可以加速同一同步路径；Sandbox Key 只能调用 Sandbox base URL、Live Key 只能调用 Live base URL；
23. 模拟 Customer Webhook 延迟、API 暂时失败和等待超时，验证事件保留 Paddle request ID、HTTP 状态与原始错误，并只在超过上限或确认不可恢复时进入 `needs_attention`；分别用 Paddle Notification 重放 Customer 事件、配置只读 API Key 后 reconcile 两条路径恢复，再 replay 原购买事件；
24. 让 Customer 读穿分别返回 `401` 和 `403`，验证 Event 保持 pending 并保存 HTTP 状态、Provider 原始 code、request ID 与 message；相同 Provider/capability 只产生一条 open System Issue，多条 Event 均可追溯；
25. 更新 API Key 后执行“已修复但不重试”，验证 Issue resolved 而 Event 错误不变；再次触发相同错误时重开同一 Issue；
26. 执行“已修复并重新处理”，分别覆盖 Customer Webhook 已补齐、Get Customer 200、404/archived、429/5xx、再次 401/403、邮箱冲突、payload 过期和业务结果已存在，验证只对符合条件的 Event 运行完整状态机且不会重复发码；
27. 手动 reconcile 的 `401/403` 只 upsert System Issue 而不伪造 Event；客户门户 capability 独立去重，修复后不自动重放旧门户请求；
28. 发送较旧的 Customer/Subscription/Adjustment 状态事件，验证不会覆盖较新的镜像和状态；
29. 修改 Paddle Customer 邮箱，验证不会自动改绑或修改 LicenKit Customer，新签发进入 `email_mismatch` 人工处理，已有订阅仍续期原 License；
30. 为 API Key 增加 `customer_portal_session.write` 后创建真实 Sandbox 客户门户会话；移除该能力只禁用门户，不影响购买；
31. 在 Paddle 取消自动续费，并验证本地状态只通过后续 Webhook 更新。

Mock 数据可以用于单元测试，但必须通过与正式相同的 Adapter 接口进入系统。

## 7. Customer Portal 联调

Customer Portal 至少验证：

1. Magic Link 请求必须通过 Turnstile 服务端 Siteverify，并校验固定 action 与 `site_url` hostname；无效、过期、重复或 hostname/action 不匹配时在 Customer 查询前拒绝；
2. 使用 Cloudflare 官方测试 Sitekey/Secret 覆盖成功、失败和重复 Token，测试与正式环境走同一 Widget、请求字段和 Siteverify Adapter；
3. 有效邮箱首次请求创建 Login Challenge 和 Notification Delivery；
4. 默认 60 秒内重复请求命中 D1 Challenge 冷却，不创建新 Challenge/Delivery，也不吊销旧链接；冷却结束后的并发请求最多创建一组新记录；
5. Customer 不存在、命中冷却和成功创建具有相同状态、响应体、缓存头和最短响应时间策略；
6. Magic Link Token 只保存哈希且只能消费一次；
7. 冷却结束后成功创建新链接才吊销旧 Challenge、停止旧 Delivery，旧链接无法登录；新建失败时旧链接保持有效；
8. Magic Link 请求页 CSP 只增加 Turnstile 所需官方来源；Token 落地页仍阻止所有第三方资源，Token 不进入首个 HTTP 请求、Referer、浏览器历史或应用日志；GET、预取和链接扫描不消费 Challenge，只有显式用户动作后的 POST 才消费；
9. 过期、已消费、已吊销 Token 和 disabled Customer 不能创建 Session；
10. Customer Session 退出、过期和管理员吊销后立即失效；
11. 最近认证过期后，设备释放、找回、安全重置和支付门户创建都要求重新 Magic Link 验证；
12. Customer 只能查询自己名下的 License、Subscription 和 Activation；
13. 账户 A 的 Session 不能访问账户 B 的任何 Customer 资源，越权 ID 不泄露资源是否存在；
14. 释放设备写入 `deactivated` 和 Customer 审计，不删除 Activation；
15. 普通找回保留激活，安全重置吊销全部激活；
16. 找回和安全重置成功页只展示一次新注册码，同时创建通知 Delivery，不写入缓存、本地存储、日志或分析事件；
17. Customer Portal 没有邮箱修改入口，Customer API 也不接受该操作；
18. Magic Link 15 分钟、请求冷却 60 秒、Session 7 天、最近认证 15 分钟的默认边界值和显式配置覆盖均有测试；
19. Customer 写操作拒绝跨站请求。

## 8. 无需支付方式的 Product/设备试用联调

本节只验证 Trial Claim；Paddle 免费订阅试用在第 6 节联调。Product/设备试用至少验证：

1. Product 未启用试用或未显式配置正数时长时拒绝领取；
2. 首次领取只返回一次 Trial Token，数据库只保存 Token Hash；
3. 相同 Account、Product 和设备指纹的重复与并发领取都返回 `TRIAL_ALREADY_CLAIMED`，且不改变原到期时间；
4. 错误 Token、不同设备指纹、过期和吊销分别返回可诊断错误；
5. 账户 A 的 Trial ID 或 Token 不能在账户 B 使用；
6. 领取和校验都拒绝未知 Product Release，客户端自报时间无效；
7. Product 后续修改试用时长或功能不改变已有 Claim 快照；
8. Trial Token 丢失不能仅凭指纹补发；
9. 断网不返回本地试用有效；
10. D1 唯一约束继续拒绝同一 Account、Product 和设备指纹的重复/并发领取；部署验证同时确认 Trial Claim/校验路径已纳入 Zone 级 WAF Rate Limiting Rules，不在应用中建立限流表。
11. owner/admin 可以查询和吊销本账户 Trial Claim，member/viewer 与跨账户请求默认拒绝，吊销不删除历史且写入审计。

设备指纹不是硬件证明，这组测试验证的是 V1 合同和基础滥用控制，不宣称能够抵抗修改后的客户端。

## 9. 管理端权限联调

每个 Admin 路由必须由自动化测试覆盖 owner、admin、member、viewer 和无权限 Session。至少验证：

1. 角色未明确允许的动作默认 403；
2. 禁用 User、吊销 Session 或修改角色后，下一次请求立即按新状态判定；
3. 不能降级或禁用最后一个 active Owner；
4. 账户 A 的任意角色不能读取、修改或探测账户 B 的资源；
5. 批量操作、导出、后台 replay/retry 与单资源详情使用同一账户条件；
6. Secret 读取接口只返回配置状态和掩码。

## 10. Readiness 与诊断

启动和部署检查至少报告：

- D1 schema version；
- 初始化状态；未初始化时只允许 Setup 路由，已初始化时 Setup 写接口必须关闭；
- D1 `system_settings` 中 Scheduled Worker 最近一次完整成功时间和运行耗时；
- Cloudflare Zone 级 WAF Rate Limiting Rules 已覆盖 Setup、登录、管理写操作、客户端凭证、Trial 和 Customer 敏感写路径；该项通过部署控制面核对，Worker `/system/readiness` 不持有 Cloudflare 管理凭证，也不伪造可自检状态；
- 最老 pending Inbound Event 与 Delivery 的等待时间；
- Secret 是否存在且格式可用；
- active Billing Provider 配置数量；
- active Paddle Provider 的 Client-side Token 前缀、Webhook Secret、环境和最小事件合同是否匹配；
- 仅在启用 API 读穿、对账或客户门户时，检查 Paddle API Key 是否可解密、环境匹配且具备该能力需要的最小权限；
- `pending`、`email_mismatch` 和 `needs_attention` Billing Customer 数量与最老等待时间；
- active Notification Gateway 是否存在；
- active Notification Gateway 最近一次 Endpoint Test 是否 accepted，以及当前配置是否晚于该测试；
- 每个 active Offer 的 Checkout Readiness、真实 Sandbox 端到端验收和当前就绪状态；
- Product `billing_environment`、active Offer Provider 环境和非验证支付 License 来源环境是否一致；
- pending/needs_attention Checkout Verification 数量、最老等待时间，以及验证 License 被异常激活或改为 active 的约束检查；
- 部署 Customer Portal 时 Magic Link TTL、Session TTL、最近认证窗口和 Notification Gateway 是否有效；
- 敏感 Delivery 负载 TTL 是否有效，以及最老未清理敏感负载的年龄；
- 启用支付平台客户门户时，对应 Billing Provider 服务端 API 凭证是否可解密；
- Turnstile Sitekey/Secret、Siteverify 连通性、固定 action 和 `site_url` hostname 是否匹配；
- open System Issue 数量、最早发生时间、最近 Provider request ID 和仍受阻的 Inbound Event 数量；
- pending/failed Inbound Event 数量；
- open Billing Adjustment 数量、最老等待时间及自动暂停 License 数量；
- pending/failed Delivery 数量；
- 使用 `signed` 凭证模式但缺少 active signing key 的 Product。
- Client 使用但没有对应受信 Product Release 的版本与平台。
- 启用 Product/设备试用但缺少正数时长的 Product。

诊断响应只返回状态和引用，不返回 Secret 或敏感 Payload。

## 11. 日志规则

必须记录：

- request ID；
- account、provider、external event ID；
- License、Subscription、Delivery、Checkout Verification 引用；
- 原始错误分类、HTTP 状态和错误代码；
- 重试次数和下一次时间。

禁止记录：

- 注册码和机器令牌明文；
- Signed License Token 完整文本；
- 签名私钥和所有 Secret；
- 完整支付请求中的不必要个人信息；
- 解密后的 Delivery 敏感负载；
- Magic Link Token、完整访问 URL 和 Customer Session Token。
- Trial Token 明文和原始设备指纹。

脱敏按字段执行，不能为了省事把整条错误或整个包体替换成不可诊断的占位符。

## 12. Product Release 与服务部署边界

Product Release 是被授权 App 的发布记录，不等于 LicenKit 服务自身部署。受信发布流程必须：

1. 先产出不可变 App 构建工件；
2. 对具体平台文件计算 SHA-256；
3. 以 Product、version、platform、Hash 和 UTC 发布时间创建 Release；
4. 若配置下载地址，验证该地址返回工件的 Hash 与记录一致；
5. 发布后不修改身份字段；同版本需要替换二进制时使用新的版本标识并创建新 Release。

## 13. LicenKit 服务发布边界

本地测试通过只说明源码在本地验证。发布完成需要分别证明：

- 源码 revision；
- migration revision；
- 构建工件身份；
- 部署目标和配置；
- 线上 readiness；
- 一条独立请求 readback；
- 支付和 Notification Gateway 的环境均为预期环境。

测试与正式版本不使用不同代码路径。正式发布只替换环境资源和 Secret。
