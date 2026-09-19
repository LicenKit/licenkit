# 开发、配置与运行

## 1. 当前工程

```text
licenkit/
├── apps/server    # Hono + Cloudflare Workers + D1 + Drizzle
├── apps/web       # React + Vite 管理控制台与客户授权中心
├── apps/cli       # 命令行客户端
└── docs           # V1 设计合同
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

具体脚本以根目录 `package.json` 为准。重新生成 V1 migration 前，不对旧原型数据库执行兼容迁移。

## 3. 环境配置

### 3.1 Worker Secrets

| 名称 | 作用 |
| --- | --- |
| `STORAGE_ENCRYPTION_KEY` | 加密签名私钥、支付 Webhook/API Secret、出站 Secret 和敏感 Delivery 负载 |
| `INITIAL_SETUP_TOKEN` | 独立部署首次 Setup 使用的一次性高熵 Secret；初始化完成后可以移除 |

Secret 不进入代码、普通环境变量文件、日志、审计详情或 API 响应。

`STORAGE_ENCRYPTION_KEY` 使用带版本的 AES-256-GCM 信封格式。每条密文包含 key ID、随机 96-bit nonce、ciphertext 和 tag，AAD 绑定 `account_id + table + row_id + field`。轮换时新写入使用新 key，旧 key 在完成重加密前只保留解密能力。

### 3.2 Worker Variables

| 名称 | 作用 |
| --- | --- |
| `CUSTOMER_MAGIC_LINK_TTL_SECONDS` | Magic Link 最长有效时间；默认 `900`（15 分钟） |
| `CUSTOMER_SESSION_TTL_SECONDS` | Customer Session 服务端最长有效时间；默认 `604800`（7 天） |
| `CUSTOMER_RECENT_AUTH_SECONDS` | 敏感操作最近认证窗口；默认 `900`（15 分钟） |
| `ADMIN_SESSION_TTL_SECONDS` | 管理员服务端 Session 最长有效时间 |

这些值在测试和正式环境使用相同代码路径，只允许显式配置值不同。未配置 Customer 相关变量时使用上述默认值，不能因环境名称隐式改变。

### 3.3 Cloudflare Bindings

| Binding | 作用 |
| --- | --- |
| `DB` | D1 主数据库 |

V1 不配置 Cloudflare Queue producer 或 consumer binding。后台工作由 D1 持久状态和 Scheduled Worker 驱动。

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

即时处理和定时处理调用同一个 Fulfillment/Delivery Service，不能维护两套业务逻辑。Cron 频率、批次大小、租约时长和退避参数可以配置，但测试与正式环境使用同一调度模块。

### 3.5 数据库配置

以下内容通过控制台写入数据库，不作为 Worker 环境变量：

- Billing Provider 和加密 Webhook/API Secret；
- Offer Mapping；
- Notification Gateway URL 和加密签名 Secret；
- License Plan；
- Product Release；
- 账户业务设置。

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
14. 在 migration 发布前冻结并评审。

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
- Endpoint URL 或 Secret 轮换后，旧 Delivery 仍使用创建时快照；
- HTTP、URL credentials、非标准端口、IP literal、localhost、私网、链路本地、云元数据地址和跳转到这些目标的重定向全部被拒绝且不产生请求；
- 注册码找回生成新码；
- Magic Link 通知、自动 retry 和过期后拒绝消费；
- 敏感负载到期后拒绝 retry。

## 6. 支付平台联调

每个支付 Adapter 使用平台官方 sandbox 和官方 Webhook 签名流程。测试顺序：

1. 配置 Billing Provider；
2. 配置 Offer Mapping；
3. 验证一条官方模拟事件；
4. 完成真实 sandbox Checkout；
5. 验证首次发码；
6. 触发真实续费或时间模拟；
7. 验证同一 License 延期；
8. 测试扣款失败、恢复和取消；
9. 重放相同事件验证幂等；
10. 乱序发送事件验证旧事件不覆盖新状态；
11. 使用真实 sandbox Customer 创建支付平台托管门户会话；
12. 在支付平台取消自动续费，并验证本地状态只通过后续 Webhook 更新。

Mock 数据可以用于单元测试，但必须通过与正式相同的 Adapter 接口进入系统。

## 7. Customer Portal 联调

Customer Portal 至少验证：

1. 有效邮箱请求创建 Login Challenge 和 Notification Delivery；
2. 不存在的邮箱返回相同公开响应，但不创建 Customer 或 Challenge；
3. 存在和不存在两类请求具有相同状态、响应体、缓存头和最短响应时间策略；
4. Magic Link Token 只保存哈希且只能消费一次；
5. 请求新链接会吊销旧 Challenge、停止旧 Delivery，旧链接无法登录；
6. 落地页的 CSP 阻止第三方资源，Token 不进入首个 HTTP 请求、Referer、浏览器历史或应用日志；GET、预取和链接扫描不消费 Challenge，只有显式用户动作后的 POST 才消费；
7. 过期、已消费、已吊销 Token 和 disabled Customer 不能创建 Session；
8. Customer Session 退出、过期和管理员吊销后立即失效；
9. 最近认证过期后，设备释放、找回、安全重置和支付门户创建都要求重新 Magic Link 验证；
10. Customer 只能查询自己名下的 License、Subscription 和 Activation；
11. 账户 A 的 Session 不能访问账户 B 的任何 Customer 资源，越权 ID 不泄露资源是否存在；
12. 释放设备写入 `deactivated` 和 Customer 审计，不删除 Activation；
13. 普通找回保留激活，安全重置吊销全部激活；
14. 找回和安全重置成功页只展示一次新注册码，同时创建通知 Delivery，不写入缓存、本地存储、日志或分析事件；
15. Customer Portal 没有邮箱修改入口，Customer API 也不接受该操作；
16. Magic Link 15 分钟、Session 7 天、最近认证 15 分钟的默认边界值和显式配置覆盖均有测试；
17. Customer 写操作拒绝跨站请求；
18. 登录、找回、设备释放和门户会话创建均受限流保护。

## 8. 管理端权限联调

每个 Admin 路由必须由自动化测试覆盖 owner、admin、member、viewer 和无权限 Session。至少验证：

1. 角色未明确允许的动作默认 403；
2. 禁用 User、吊销 Session 或修改角色后，下一次请求立即按新状态判定；
3. 不能降级或禁用最后一个 active Owner；
4. 账户 A 的任意角色不能读取、修改或探测账户 B 的资源；
5. 批量操作、导出、后台 replay/retry 与单资源详情使用同一账户条件；
6. Secret 读取接口只返回配置状态和掩码。

## 9. Readiness 与诊断

启动和部署检查至少报告：

- D1 schema version；
- 初始化状态；未初始化时只允许 Setup 路由，已初始化时 Setup 写接口必须关闭；
- Scheduled Worker 最近一次成功时间和运行耗时；
- 最老 pending Inbound Event 与 Delivery 的等待时间；
- Secret 是否存在且格式可用；
- active Billing Provider 配置数量；
- active Notification Gateway 是否存在；
- 部署 Customer Portal 时 Magic Link TTL、Session TTL、最近认证窗口和 Notification Gateway 是否有效；
- 启用支付平台客户门户时，对应 Billing Provider API Secret 是否可解密；
- pending/failed Inbound Event 数量；
- pending/failed Delivery 数量；
- 使用 `signed` 凭证模式但缺少 active signing key 的 Product。
- Client 使用但没有对应受信 Product Release 的版本与平台。

诊断响应只返回状态和引用，不返回 Secret 或敏感 Payload。

## 10. 日志规则

必须记录：

- request ID；
- account、provider、external event ID；
- License、Subscription、Delivery 引用；
- 原始错误分类、HTTP 状态和错误代码；
- 重试次数和下一次时间。

禁止记录：

- 注册码和机器令牌明文；
- Signed License Token 完整文本；
- 签名私钥和所有 Secret；
- 完整支付请求中的不必要个人信息；
- 解密后的 Delivery 敏感负载；
- Magic Link Token、完整访问 URL 和 Customer Session Token。

脱敏按字段执行，不能为了省事把整条错误或整个包体替换成不可诊断的占位符。

## 11. Product Release 与服务部署边界

Product Release 是被授权 App 的发布记录，不等于 LicenKit 服务自身部署。受信发布流程必须：

1. 先产出不可变 App 构建工件；
2. 对具体平台文件计算 SHA-256；
3. 以 Product、version、platform、Hash 和 UTC 发布时间创建 Release；
4. 若配置下载地址，验证该地址返回工件的 Hash 与记录一致；
5. 发布后不修改身份字段；同版本需要替换二进制时使用新的版本标识并创建新 Release。

## 12. LicenKit 服务发布边界

本地测试通过只说明源码在本地验证。发布完成需要分别证明：

- 源码 revision；
- migration revision；
- 构建工件身份；
- 部署目标和配置；
- 线上 readiness；
- 一条独立请求 readback；
- 支付和 Notification Gateway 的环境均为预期环境。

测试与正式版本不使用不同代码路径。正式发布只替换环境资源和 Secret。
