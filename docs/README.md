# LicenKit V1 文档入口

本目录描述 LicenKit V1 的目标产品合同。它用于指导重新开发，不是当前代码完成度声明。

## 文档状态规则

- **已确认**：已经在本轮设计讨论中确定，后续实现应遵守；
- **推荐**：默认采用，只有出现明确成本或业务约束时才调整；
- **待决定**：会改变实现或产品行为，开发前需要确认；
- **当前差距**：现有代码与目标合同不一致的地方。

如果文档之间出现冲突，以以下顺序为准：

1. 领域模型中的不变量；
2. 核心业务流程；
3. 数据模型和 API 合同；
4. 开发与运行文档；
5. 当前代码和旧迁移仅作为原型参考。

## 已确认的 V1 决策

1. V1 支持买断、固定期限和订阅制 License。
2. `Policy` 更名为 `License Plan`，中文统一称“授权方案”。
3. 授权方案是未来签发模板；签发时生成不可被普通方案编辑追溯修改的 `License Terms`。
4. 订阅续费延长同一个 License，不生成新 License 和新注册码。
5. 注册码只保存单向哈希。找回注册码时生成新码，旧码立即失效。
6. 普通找回不清退已有激活；安全重置才同时吊销全部激活。
7. 所有模式都通过相同的在线激活和在线校验接口；差异只在服务端是否额外签发可离线验证的凭证。
8. `credential_mode=opaque` 只返回不透明的 Machine Token，不要求 SDK 配置公钥；`credential_mode=signed` 额外返回 Ed25519 Signed License Token，SDK 必须使用内置公钥验证。
9. `perpetual` License 可以不限制未来版本，也可以只永久使用 `updates_until` 之前发布的版本；版本更新权益与 License 使用期限是两个独立维度。
10. LicenKit 不集成 Resend API 或 SMTP。客户邮件由 LicenKit 调用客户配置的通知 Webhook，由外部接收方完成发送。
11. 自动重试复用同一个投递消息；人工“再次发送注册码”执行注册码轮换并创建新的投递消息。
12. V1 不使用 Cloudflare Queues。D1 中的入站事件和 Delivery 是任务事实来源，Scheduled Worker 负责重试和崩溃恢复。
13. V1 允许重新设计数据表和迁移，不承担旧原型数据兼容。
14. V1 提供 Customer Portal 所需的 Customer API，购买者使用 Magic Link 建立 Session；LicenKit 不提供 Portal 前端，也不提供自主注册、密码和找回密码流程。
15. Customer 由支付履约或人工签发自动创建；管理员 User 与 Customer 是两套独立身份。
16. 客户可以查看自己的 License、释放设备席位、找回注册码和执行安全重置，但不能自行暂停、吊销或修改 License Terms。
17. 支付方式、自动续费和取消由支付平台托管页面处理；LicenKit 只创建跳转会话，并以支付 Webhook 作为订阅状态的最终来源。
18. V1 保留完整多账户能力。`account_id` 是服务端授权上下文和数据库关联的一部分，不是仅用于展示或未来兼容的字段。
19. 所有租户资源查询和写入都必须显式携带当前 `account_id`；跨租户关联由复合外键或等价数据库约束拒绝，角色权限采用默认拒绝。
20. 版本更新权益只信任服务端发布的 Product Release。客户端提交版本号和平台，服务端查出受信 `released_at`，不接受客户端自报发布时间。
21. LicenKit Cloud 不属于 V1 实现范围，只保留内部扩展边界。独立部署在首次安装的 Setup 页面原子创建首个 Account 和 Owner；初始化完成后 Setup 永久关闭。
22. Magic Link 默认有效 15 分钟，Customer Session 默认有效 7 天，Customer 敏感操作的最近认证窗口默认 15 分钟。
23. 注册码找回和安全重置成功后，在最近认证页面一次性展示新注册码并同时创建通知 Delivery。
24. V1 不开放 Customer 自助修改登录邮箱；由管理员显式修改并吊销旧 Challenge 与 Session。
25. V1 出站 Webhook 只允许公网 HTTPS，不支持任意私网目标。
26. V1 首个必须完成真实联调的支付平台是 Paddle；Stripe 和其他支付 Adapter 不属于首发闭环。
27. 订阅支付宽限期的账户默认值为 5 天。该默认值保存在 Account，创建订阅授权方案时解析为方案实际值，签发时再固化到 License Terms；不是不可配置的代码常量。
28. Paddle 调整事件按 `action + type + status` 处理：已批准的全额退款和 `action=chargeback` 自动暂停 License，但不吊销 Activation；部分退款、待审批退款、`chargeback_warning` 和反转事件进入人工处理且不自动恢复。管理员再选择保持暂停、恢复、吊销或安全重置。
29. Notification Webhook 默认在首次请求之外自动重试 3 次，即最多 4 次 HTTP Attempt；凭证到期可以提前终止重试。
30. V1 同时支持两类免费试用：无需支付方式的 Product/设备级 Trial Claim，以及要求预先绑定支付方式、由 Paddle 管理周期的免费订阅试用。两者使用不同状态机和凭证，不能互相冒充。
31. 管理员和受信 API 可以直接签发订阅 License，但必须提供明确的未来到期时间并使用 `renewal_mode=manual`；该 License 不绑定 Paddle、没有支付宽限期，只能通过显式、可审计的手动续期延长。
32. 管理员可以签发永久 License；永久授权使用 `license_model=perpetual`、`renewal_mode=none`、`expires_at=NULL`，不要求 `expiresAt`。V1 不增加语义矛盾的“永久订阅”状态。
33. Paddle Customer 解析以 `customer.created`/`customer.updated` 为正常路径，使用外部 Customer ID 建立稳定映射。购买事件先到时保持 `pending`，等待关联 Customer 事件后重试；若配置了具备 `customer.read` 权限的 Paddle API Key，可以用服务器端 API 读穿加速恢复，但 API Key 不是基础购买和发码闭环的必需配置。`custom_data.email` 不作为 Customer 身份或发码地址来源。
34. Paddle Client-side Token 是公开的前端凭证，只用于初始化 Paddle.js、预览价格和打开 Checkout；Webhook Secret 用于验证入站事件；API Key 只允许服务端使用，启用托管客户门户时需要 `customer_portal_session.write`，启用 API 对账/读穿时需要对应只读权限。
35. 普通支付履约只接受一个 active Offer 对应的 Price，数量固定为 1。已验签事件不满足“一个已映射 Price、数量 1”时进入 `needs_attention`，不猜测发码；draft Sandbox Offer 只允许走第 39 条的一次性管理员验证例外。
36. Offer 默认处于 `draft`。只有 Client-side Token、Webhook 事件合同、Notification Gateway、调度器、签名密钥（如需要）和真实 Sandbox 购买到通知接管链路均通过检查，才允许显式激活；激活后静态产品页仍直接连接 Paddle，运行期异常由入站事件和告警暴露。
37. 产品页静态维护产品、方案、展示价格和 Paddle Price ID，直接调用 Paddle.js，不依赖 LicenKit Checkout API 或 Web Checkout SDK。浏览器 Checkout 回调只用于界面反馈，不能创建 Customer、License 或发码。
38. Paddle Notification Destination 的最小事件合同为 `customer.created`、`customer.updated`、`transaction.completed`、`subscription.created`、`subscription.updated`、`adjustment.created`、`adjustment.updated`。缺少任一项时 Offer 不能激活；额外事件可以用于更细诊断，但不能替代最小合同。
39. Product 明确选择唯一的公开收款环境。普通付款只有在 Provider 环境与 Product 一致且 Offer 已激活时才能签发可用 License；管理员的 Sandbox 端到端验证使用短期一次性令牌，生成的验证 License 永久不可激活，测试卡不能兑换正式授权。
40. 自定义产品页配置公开的 Paddle 环境、Client-side Token 和 Price ID；同一 Price ID 在 LicenKit Offer 中关联 Product 与 License Plan。商户仍需在 Sandbox/Live 分别设置 Default Payment Link，并为实际 Live 页面完成 Website Approval。

## 阅读顺序

| 文档 | 回答的问题 |
| --- | --- |
| [01-domain-model.md](./zh-CN/01-domain-model.md) | 系统中有哪些对象，每个名称是什么意思，谁是事实来源 |
| [02-business-flows.md](./zh-CN/02-business-flows.md) | 买断、订阅、客户登录、激活、找回和邮件投递如何流转 |
| [03-system-architecture.md](./zh-CN/03-system-architecture.md) | 模块如何分工，事务、调度和错误链路如何组织 |
| [04-data-model.md](./zh-CN/04-data-model.md) | V1 需要哪些表、约束和索引 |
| [05-api-contract.md](./zh-CN/05-api-contract.md) | 首次 Setup、管理端、客户授权中心、客户端、支付入站和通知出站的接口边界 |
| [06-sdk-contract.md](./zh-CN/06-sdk-contract.md) | 不透明凭证与签名凭证在 SDK 中如何表现 |
| [07-delivery-plan.md](./zh-CN/07-delivery-plan.md) | 当前已知差距、开发顺序和完成条件 |
| [08-development-and-operations.md](./zh-CN/08-development-and-operations.md) | 本地开发、配置和运行检查 |
| [09-static-product-page.md](./zh-CN/09-static-product-page.md) | 静态产品页如何直接使用 Paddle.js，并由 LicenKit Webhook 完成可信履约 |
| [10-customer-site-integration.md](./zh-CN/10-customer-site-integration.md) | 使用方站点需要实现哪些页面，以及可调用哪些 Customer API |

## 推荐的 V1 运行默认值

- 敏感 Delivery 负载最长保留 24 小时。Notification Gateway 返回 2xx 并可靠接管任务后立即清除，不为了凑满保留期继续保存；Magic Link 则以 15 分钟 Challenge 有效期为更早上限。
- Product/设备级试用不设置全局隐式天数。启用时由管理员为 Product 显式填写正数时长；Paddle 订阅试用时长则来自已验签的 Paddle Subscription，不在 LicenKit 重复配置。

截至本轮评审，没有尚待确认的 V1 领域决策；上面的 24 小时保留值是安全与可恢复性的推荐默认值，可以在实现前按实际运维能力调整。
