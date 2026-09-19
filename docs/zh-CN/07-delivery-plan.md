# V1 开发计划与现状差距

## 1. 当前结论

现有仓库可以保留为实现参考，但不能在原数据模型上继续局部修补后直接称为 V1。V1 需要先重建 Schema 和领域服务，再迁移已有可复用实现。

这不是更换技术栈，也不是为了兼容旧数据的迁移项目。目标是用现有技术底座实现已经确认的新合同。

## 2. 当前原型事实

| 领域 | 当前事实 | V1 判断 |
| --- | --- | --- |
| Product、License、Activation 原型 | 已有管理和客户端路由，测试可运行 | 可复用算法和局部实现 |
| Policy | 激活时读取当前 Policy，编辑会影响存量 License | 必须改为 License Plan + License Terms |
| 注册码存储 | License 表保存单向哈希 | 保留 |
| 注册码轮换 | 当前轮换会删除全部设备绑定 | 拆成普通找回与安全重置 |
| Swift SDK | 初始化强制公钥，激活强制 Signed License Token | 必须支持 `opaque` 模式无公钥 |
| 后台调度 | 代码包含 Queue producer/consumer，但仓库部署配置没有 Queue binding，缺少 binding 时会静默跳过 | V1 移除 Queue，改为 D1 任务状态 + Scheduled Worker |
| Scheduled Worker | 当前 Cron 每日运行且只清理未使用的过期 License | 改为每分钟运行统一调度入口，并把清理保留为独立作业 |
| 支付配置 | 多渠道配置混在账户 JSON 字段 | 拆成 Billing Provider 表 |
| 价格映射 | 放在 Policy metadata，找不到时存在回退 | 拆成 Offer Mapping，缺失时失败 |
| 产品购买页 | 没有公开 Checkout 配置合同、可复用 Web SDK 或收款就绪门禁 | 新建公开 API、无界面 SDK 和可修改参考模板 |
| 订阅 | 事件处理不完整，续费可能进入新 License 签发路径 | 重新实现 Subscription 状态模型 |
| 入站幂等 | 代码有查询检查，当前运行 Schema 与文档约束不完全一致 | 新 Schema 使用数据库唯一约束 |
| 邮件发码 | 只有通用业务事件广播概念，没有完成可验证的客户邮件闭环 | 新建 Notification Gateway 和 Delivery 流程 |
| 再次发送 | 没有对 Retry、找回和安全重置作语义区分 | 按三种动作重新实现 |
| 客户自助 | 没有 Customer、Magic Link、Customer Session 或 Customer API | 新建 Customer Portal，不引入密码注册体系 |
| 免费试用 | 只有未闭环的领取概念 | V1 同时实现独立 Product/设备 Trial Claim，以及要求支付方式的 Paddle 免费订阅试用；两套状态不能混用 |
| 文档状态 | 旧计划把支付和出站模块标为已完成 | 旧完成度声明作废 |

## 3. 开发阶段

### Phase 0：领域与 Schema 基线

目标：代码开始重构前，建立可执行的数据和接口合同。

- [ ] 删除旧 Drizzle migration，生成新的 V1 初始 migration；
- [ ] 实现独立部署一次性 Setup：`INITIAL_SETUP_TOKEN`、首个 Account、首位 Owner、Session 和初始化闩锁原子提交；
- [ ] Setup 完成后永久关闭；Cloud 仅保留内部 Account Provisioning 接口，不实现 Cloud API 或 Adapter；
- [ ] 建立 License Plan、含 `renewal_mode` 的 License Terms 和 Activation 模型；
- [ ] 建立 Product Release 与受信发布时间模型；
- [ ] 建立 Product 试用配置和 Trial Claim 模型；
- [ ] 建立 Admin Session、Customer、Login Challenge 和 Customer Session 模型；
- [ ] Admin Session 与 Customer Session 分别保存唯一 CSRF Token Hash；所有 Cookie 鉴权写操作同时校验精确 Origin、CSRF Header、CSRF Cookie 和当前 Session 绑定，SameSite 不作为唯一防护；
- [ ] 建立带公开 `slug` 的 Product，以及 Billing Provider、Billing Customer 稳定映射、默认 draft Offer、Subscription、Adjustment 和 Inbound Event；
- [ ] 建立 Outbound Endpoint、Delivery 和 Attempt；
- [ ] 把文档目标 DDL、Drizzle Schema 和 TypeScript DTO 对齐；
- [ ] 为所有关键唯一约束、复合外键和激活数 Trigger 增加数据库测试；
- [ ] 所有 Repository/Service 接口强制接收 `account_id`，删除仅按租户资源 ID 查询的方法；
- [ ] 建立默认拒绝的角色权限表与路由权限元数据。

完成条件：空数据库可以一次初始化；目标表、约束和索引与文档一致；没有旧 Policy 或 Machine 的新代码路径。

### Phase 1：License 核心与客户端协议

目标：不依赖支付也能手动签发、激活和验证完整 License。

- [ ] License Plan CRUD 和 revision；
- [ ] License Terms 固化；
- [ ] 永久全版本与永久限期更新两种版本权益；
- [ ] Product Release CRUD、发布字段不可变和未知 Release 拒绝；
- [ ] 显式延长已售 License 的 `updates_until`；
- [ ] 手动签发永久、固定期限和手动续期订阅，并返回一次性注册码；
- [ ] 手动订阅必须提供未来到期时间、支付宽限期为 0，并通过独立审计操作续期同一个 License；
- [ ] 永久赠送 License 使用 `perpetual + none + expires_at=NULL`，不要求到期时间；
- [ ] 手动签发时按规范化邮箱创建或匹配 Customer；
- [ ] Activation 历史状态和原子席位限制；
- [ ] `opaque` 凭证模式激活/校验；
- [ ] `signed` 凭证模式激活/校验；
- [ ] 普通找回和安全重置；
- [ ] 无需支付方式的 Product/设备试用领取、在线校验、管理员查询与吊销、限流和 Trial Token 安全存储；
- [ ] Swift SDK 对齐两种模式。

完成条件：`opaque` 模式不配置公钥可以使用；`signed` 模式可以离线验签；授权方案编辑不改变已有 License；客户端自报发布时间不能影响版本资格，永久 License 在更新截止后仍可使用符合资格的旧版本；永久手动签发不要求到期时间，手动订阅只能显式延长；两种找回行为有独立测试；Product/设备试用重复或并发领取不能延长时间，错误 Token、设备不匹配、到期、吊销和未知 Release 都被独立拒绝，断网不宣称试用有效。

### Phase 2：可靠出站通知

目标：先让手动签发和找回邮件链路真实可用，再连接支付自动履约。

- [ ] Notification Gateway 配置表和管理 API；
- [ ] Endpoint 连通与签名测试；
- [ ] Transactional Outbox；
- [ ] 每分钟 Scheduled Worker、任务租约和过期租约恢复；
- [ ] 请求后的即时处理与 Scheduled Worker 使用同一个处理入口；
- [ ] Delivery 和 Attempt 状态；
- [ ] `customer.license_issued`；
- [ ] `customer.license_recovered`；
- [ ] `customer.license_security_reset`；
- [ ] `customer.portal_access_requested`；
- [ ] 自动 retry 和人工 retry；
- [ ] 默认首次请求加 3 次自动重试，Attempt 序号、退避和到期提前终止可验证；
- [ ] Delivery 固化目标 URL 与签名 Secret，Endpoint 更新不改变既有重试；
- [ ] 出站 URL 只允许公网 HTTPS，完成端口、地址和逐跳重定向校验；V1 不支持私网目标；
- [ ] 敏感负载加密、accepted 后立即清理、未成功负载默认 24 小时到期，以及 Magic Link 更短生命周期清理；
- [ ] 控制台展示阻塞配置、pending、accepted 和 failed。
- [ ] Notification Gateway 缺失或 Endpoint Test 未 accepted 时，Offer 激活和公开 Checkout API 均不可收款；
- [ ] 对异常产生的 `blocked_configuration` Delivery 提供“配置完成后绑定并发送”，仅允许负载未过期且零 Attempt 的记录；

完成条件：在真实外部接收端点中完成一次签名验证并接管邮件发送任务；关闭接收端点后能观察失败、保留注册码负载并在恢复后成功 retry；中断即时处理后 Scheduled Worker 可以恢复同一 Delivery；全程不调用 Cloudflare Queues 和 Resend API。

### Phase 3：Paddle 端到端闭环

目标：使用 Paddle 完成真实 Sandbox 购买和订阅生命周期。

- [ ] Billing Provider 配置：环境匹配的公开 Client-side Token、加密 Webhook Secret，以及按能力选配的 Paddle API Key；
- [ ] API Key 缺失时基础购买/发码仍通过 Customer Webhook 闭环；启用 Customer 读穿/对账或托管客户门户时分别校验最小权限；
- [ ] Product `slug`、唯一 `billing_environment`、默认 draft Offer Mapping、Checkout Readiness 和显式激活；
- [ ] Public Checkout API、无界面 Web Checkout SDK 和可修改参考产品页；
- [ ] 参考模板说明 Sandbox/Live Default Payment Link、Live Website Approval 与 CSP 前提；实际 Live Origin 完成一次不付款的 Checkout 打开测试，SDK 保留 Origin/初始化原始错误；
- [ ] owner/admin 通过 POST draft Sandbox Offer 验证配置创建短期一次性验证令牌，并用同一 SDK 运行真实 Checkout；验证 License 固定不可激活，accepted Delivery 成功后才能形成完成证据，Live Offer 复用同产品/方案/购买类型的证据并验证 Live PricePreview；
- [ ] SDK 只能按返回的 `offerId` 打开一个 Price、数量 1，不接受调用方传入任意 Price ID 或数量；
- [ ] 原始请求签名验证；
- [ ] 入站事件数据库幂等；
- [ ] Paddle Notification Destination 最小事件合同：`customer.created`、`customer.updated`、`transaction.completed`、`subscription.created`、`subscription.updated`、`adjustment.created`、`adjustment.updated`；
- [ ] `customer.created`、`customer.updated` 的 Billing Customer 镜像和稳定内部 Customer 映射；
- [ ] 购买事件先到且本地映射缺失时保持 `BILLING_CUSTOMER_PENDING`，Customer Webhook 到达后收敛；配置 API Key 时 Get Customer 只作为加速恢复；
- [ ] Customer Webhook、可选 API 读穿与定期对账按外部更新时间幂等收敛，旧事件不能覆盖新镜像；
- [ ] `custom_data.email`、Checkout 参数和占位邮箱不能创建 Customer 或决定发码地址；
- [ ] Paddle 邮箱变化只进入 `email_mismatch` 人工确认，不自动改绑 Customer；既有订阅仍续期原 License；
- [ ] 外部交易业务唯一键，证明不同事件不能重复履约同一交易；
- [ ] 服务端从已验签 Transaction 强制验证一个 active Offer Price、数量 1、Provider 与 Product 收款环境一致；多商品、多数量、未知、环境不一致或 draft Price 进入 `needs_attention`；只有精确命中未过期一次性验证令牌的 draft Sandbox Offer 可进入不可激活验证履约；
- [ ] 首次买断或订阅付款；
- [ ] Paddle recurring price 的免费试用要求预先绑定支付方式，并通过已验签事件创建 `trialing` Subscription 和同一个支付续期 License；
- [ ] 免费订阅试用成功扣款后原 License 转为付费周期，失败则进入 `past_due` 和相同宽限期，不重新发码；
- [ ] 续费延长同一个 License；
- [ ] 扣款失败后按 License 固化值执行默认 5 天宽限期，并验证付款恢复；
- [ ] 周期结束取消；
- [ ] Billing Adjustment 持久化 `action + type + status + amount`；已批准全额退款和 `action=chargeback` 自动暂停，部分/待审批/warning/反转进入人工处理且不自动恢复；
- [ ] 管理员对 Adjustment 执行保持暂停、恢复、吊销、安全重置或 no action，并记录原因和审计；
- [ ] 乱序和重复事件测试；
- [ ] 支付成功后通过 Notification Webhook 发码；
- [ ] 配置具备 `customer_portal_session.write` 的加密 Paddle API Key 后，Billing Adapter 创建支付平台托管客户门户会话；未配置时只禁用该能力，不禁用购买；

完成条件：owner/admin 先通过 draft Sandbox Offer 的验证入口完成真实闭环，验证令牌只能消费一次，验证 License 的激活、恢复和迁移均被拒绝；激活后用户可在自定义页面通过公开 API 和 Web SDK 完成 Product 所选环境的 Paddle Checkout。真实事件从 Customer 创建、付款、唯一 License 签发到外部接收方接受邮件任务闭环，并可从事件 ID 追踪到 Billing Customer、Subscription、License、Delivery、Checkout Verification 和所有 Attempt。分别证明 Customer Webhook 先到、购买事件先到后等待 Customer Webhook、配置 API Key 后读穿加速、已有 Paddle Customer 再次购买四条路径只履约一次；多商品、数量不为 1、Provider/Product 环境不一致不发正式 License；最小事件合同和 Notification Gateway 任一缺失时不能激活 Offer；至少一条免费订阅试用完成 `trialing -> active`；Adjustment 各状态映射通过；配置 API Key 后可以创建托管门户会话，但该动作不直接修改本地 Subscription。

### Phase 4：Customer Portal

目标：购买者不依赖管理员即可管理自己的授权和设备，并能进入支付平台管理订阅。

- [ ] Magic Link 请求的统一公开响应、限流和防枚举；
- [ ] Magic Link 默认 15 分钟、Customer Session 默认 7 天、最近认证默认 15 分钟；
- [ ] 新请求吊销旧 Challenge，Magic Link 使用 Fragment、无第三方资源落地页和地址清理；
- [ ] Login Challenge 哈希存储、短期有效、唯一 Session 绑定和 D1 原子单次消费；
- [ ] Customer Session Cookie、过期、退出和管理员吊销；
- [ ] Cookie 鉴权写操作缺少或不匹配 Origin、CSRF Header、CSRF Cookie、Session Hash 任一条件时 fail-fast，且 Admin/Customer Token 不跨命名空间复用；
- [ ] 当前 Customer 的 License、Subscription 和 Activation 查询；
- [ ] Customer 释放指定 Activation；
- [ ] Customer 普通找回与安全重置；
- [ ] 找回和安全重置后一次性页面展示新注册码并同时创建通知 Delivery；
- [ ] Customer 邮箱只允许管理员修改，Portal 不提供邮箱修改入口；
- [ ] 支付平台客户门户跳转；
- [ ] 敏感动作最近认证与重新 Magic Link 验证；
- [ ] Customer Actor 审计；
- [ ] 跨账户、跨 Customer、并发消费、过期 Token、disabled Customer、旧 Magic Link、最近认证和 CSRF 负向测试。

完成条件：一个真实通知接收端可以发送 Magic Link；链接只能消费一次；Customer 只能读取和修改自己的资源；释放设备保留 Activation 历史；找回与安全重置语义独立；支付订阅管理在支付平台完成并由 Webhook 回写最终状态，手动订阅只展示发行方管理状态。

### Phase 5：其他支付 Adapter

目标：在不改变内部领域接口的情况下加入后续支付平台。

- [ ] 第二支付平台 Adapter；
- [ ] 第三支付平台 Adapter；
- [ ] 新 Adapter 复用 Billing Customer 同步与链接服务，证明相同规范化邮箱可以链接同一 LicenKit Customer，同时保持各 Provider 映射和 Subscription 独立；
- [ ] 渠道差异状态映射和契约测试；
- [ ] 每个渠道独立真实 sandbox 验证。

支付渠道数量不能替代第一个渠道的完整闭环。没有真实端到端证据的 Adapter 不能标记为完成。

### Phase 6：管理体验与发布准备

- [ ] 管理控制台使用新命名和新 API；
- [ ] 客户授权中心页面与 Customer API 对齐；
- [ ] 配置健康检查；
- [ ] 失败事件重放和 Delivery retry；
- [ ] 操作审计和敏感字段脱敏；
- [ ] 限流、CORS、Secret 和权限复核；
- [ ] owner/admin/member/viewer 权限矩阵逐路由正向与负向验证；
- [ ] 正式环境使用与测试环境相同流程验收；
- [ ] 部署工件、迁移和线上 readback 验证。

## 4. 模块完成定义

模块只有同时满足以下条件才可标记完成：

1. 文档合同已确定；
2. Schema 和接口已实现；
3. 关键成功、失败、重复和并发分支有测试；
4. 错误保留原始来源并能在控制台定位；
5. 外部服务模块完成真实 sandbox 或真实接收端点测试；
6. 当前实现状态已更新到本文档；
7. 本地通过不等于已部署，部署状态单独记录。

## 5. 已确认的阶段默认值

1. 首发支付平台为 Paddle；Phase 3 必须完成真实 Sandbox 闭环。
2. Account 的订阅支付宽限期初始默认值为 5 天；方案和 License 分别保存解析值与固化值。
3. 已批准的全额退款和 `action=chargeback` 自动暂停 License；其他 Adjustment 状态按合同进入人工处理或不改变授权，任何反转不自动恢复。
4. Notification Gateway 默认最多 4 次 HTTP Attempt，即首次请求加 3 次自动重试。
5. 未成功的敏感 Delivery 负载推荐默认保留 24 小时；accepted 后立即清除，Magic Link 以 15 分钟有效期为更早上限。
6. 两类免费试用都进入 V1 首发：Product/设备 Trial Claim 必须显式配置时长且只支持在线校验；Paddle 免费订阅试用要求预先绑定支付方式，周期只取已验签 Paddle Subscription。
7. 管理员和受信 API 可以签发永久、固定期限和手动续期订阅；永久 License 无到期时间，只有手动订阅必须提供明确的未来到期时间。
8. 产品页使用公开 Checkout API 和无界面 SDK；Client-side Token 可公开，API Key 和 Webhook Secret 永不进入前端。

这些值已经进入对应阶段的验收用例。24 小时是推荐运行默认值；调整时只能改显式配置和新 Delivery 的 `payload_expires_at`，不能切换处理机制。
