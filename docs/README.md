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
14. V1 提供 Customer Portal（客户授权中心），购买者使用 Magic Link 登录，不提供自主注册、密码和找回密码流程。
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

## 尚待确认但不阻塞领域设计的问题

- V1 首个必须完成真实联调的支付平台是 Paddle、Stripe 还是其他平台；
- 订阅扣款失败后的默认支付宽限期；
- 退款、拒付事件默认执行暂停还是吊销；
- 通知 Webhook 自动重试次数和敏感投递负载保留时长；
- 免费试用是否继续属于 V1 首发范围。

这些问题可以改变具体配置和状态转换，但不改变本文档确定的领域边界。
