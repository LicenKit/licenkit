# 系统架构

## 1. 架构结论

LicenKit 当前是一套运行在 Cloudflare Workers + D1 上的自部署授权服务。核心模型按多租户设计，但当前产品入口只开放一个 Instance。

```text
Deployment（运行环境）
└── Instance（租户/授权业务空间）
    ├── Membership ── User（全局管理员身份）
    ├── Product / Plan / License / Activation
    ├── Customer / Customer Session
    ├── Billing / Webhook
    └── Email / System Issue / Instance Audit
```

关键边界：

- User 负责邮箱密码身份；
- Instance 负责业务隔离；
- Membership 负责 User 在 Instance 中的角色与状态；
- Invitation 负责加入 Instance，不由 Owner 创建他人密码；
- Customer 与 User 是独立身份；
- Deployment 级运行异常不进入 Instance 业务表。

当前主线从空数据库建立新合同，不提供旧表、旧字段、旧 URL、旧环境变量、旧 CLI 选项或旧 Token Claim 的兼容层。

## 2. 运行拓扑

```text
Admin SPA ───────────────┐
Customer Site（使用方） ─┼─ HTTPS ─> Cloudflare Worker / Hono
CLI / Swift SDK ─────────┤                    │
Payment Provider ────────┘                    ├─ D1
                                              ├─ Static Assets
Cloudflare Cron ─> scheduled() ───────────────┤
                                              ├─ Payment Provider API
                                              └─ Email Provider API
```

Admin 与 API 同源部署。Customer Site 可以由使用方在同站的另一个 Origin 独立实现和托管。两者作为 `instances.admin_api_url` 与 `instances.site_url` 保存；Worker 先按请求 Origin 解析 Instance，再用该 Instance 的 Customer Site Origin 建立精确 CORS 边界。Customer Site 只通过公开 API 交互，不能直接读取 D1 或持有服务端 Secret。

## 3. 模块职责

### M01 Deployment Setup

- 校验 `INITIAL_SETUP_TOKEN`；
- 提供三步 Setup 状态；
- 原子创建首位 User、Instance、Owner Membership、Admin Session、审计和 Bootstrap 完成记录；
- 通过 `deployment_bootstrap` 固定单例行关闭 Setup。

Setup Token 只存在请求和页面内存，不持久化 Hash，也不写日志。

### M02 User、Session 与 Membership

- 邮箱密码登录与 User Profile；
- Session/CSRF Token Hash 和撤销；
- 每请求读取 active Membership；
- Owner/Admin/Member/Viewer 现有权限矩阵；
- 最后一个 active Owner 的数据库不变量；
- 密码修改撤销其他 Admin Session。

Session 只绑定 User，不长期缓存 Instance 角色。

### M03 Invitation

- Owner 创建、撤销和重新发送 Invitation；
- 使用当前 Instance 的 Email Integration；
- 新 User 自设密码，已有 User 先认证；
- 原子接受、Membership、新 User/Session（如需要）与审计；
- 与 Customer Magic Link 共享服务端一次性链接组件。

Admin Invitation 页面属于 LicenKit；Customer Magic Link 页面属于使用方 Customer Site。两端通过合同测试保持相同安全机制，不虚构共享前端包。

### M04 Product、Plan 与 Signing

- Product、Release 和 Signing Key；
- License Plan 条款与修订；
- Product → Plan 的支付宽限期快照；
- Ed25519 Key 生命周期；
- Release Artifact Hash 与更新权益判断。

### M05 License、Activation 与 Trial

- 手动/API/支付签发；
- Plan → License 条款快照；
- Registration Key、Machine Token 和 Signed License Token；
- 席位上限、激活、验证、停用和撤销；
- 无需支付方式的设备 Trial Claim。

Signed License Token 使用 `ins` Claim。CLI/SDK 按显式 `instanceId/instanceID` 验证，不接受旧 Claim。

### M06 Billing 与 Webhook

- Instance 内 Provider 配置；
- Offer Mapping；
- Webhook 原始 Body 验签和持久化；
- Billing Customer、Subscription、Adjustment 镜像；
- 幂等、乱序保护和履约；
- Sandbox 闭环验证。

Webhook 路径先使用 Instance ID 解析 Instance，然后只在该边界内选择 Provider 和处理对象。

### M07 Email Delivery

- Email Integration 和 Provider Template Binding；
- 类型化、版本化变量合同；
- 先持久化 Delivery，再调用 Provider；
- 自动重试、等待配置、人工重发和敏感变量清理；
- Customer 与 Instance Invitation 两类收件人。

模板文案和 HTML 由 Provider 托管，LicenKit 不复制模板正文。

### M08 Customer 身份与 Portal API

- Magic Link Challenge；
- Customer Session；
- License、设备和支付订阅读取；
- 释放设备、普通找回和安全重置。

Customer Site 的页面、路由、品牌和托管由使用方负责。

### M09 System Issue 与审计

- `system_issues` 聚合可归属 Instance 的 Billing/Webhook/Email 业务错误；
- 业务对象继续保存自己的状态和原始错误；
- identity/instance 两类审计范围；
- Issue 只告警，不作为产品操作门禁。

### M10 Admin、CLI 与 SDK

- Admin 提供 Instance、Members、Profile、System Issues 及共用顶部告警；
- Instance 状态只读，不提供切换或新建入口；
- CLI/SDK 对外使用 Instance 命名并验证 `ins` Claim；
- 客户端不持有私钥或 Provider Secret。

## 4. 请求上下文与隔离

### 4.1 Admin 请求

```text
Session Cookie
  -> session_token_hash
  -> User
  -> 自部署唯一 active Instance
  -> 当前 active Membership
  -> userId + instanceId + instanceRole
```

写请求额外校验精确 Origin、CSRF Cookie、`X-CSRF-Token` 和 Session 绑定的 CSRF Hash。

### 4.2 Customer 请求

```text
请求 URL Origin == instances.admin_api_url -> Instance
跨 Origin 请求：Origin == Origin(instances.site_url)
同 Origin GET：请求 URL Origin == Origin(instances.site_url)
  -> API Host 的 Customer Session/Instance Cookie
  -> Instance
  -> Customer Session Token Hash
  -> instance_id + customer_id
```

跨 Origin Customer Auth、读取和写入接口都先验证请求 Host 对应的 Instance，再验证该 Instance 的精确 Customer Site Origin；浏览器普通同 Origin GET 不携带 Origin，因此仅在请求 URL Origin 与 Customer Site Origin 相同时允许缺少该 Header。写请求始终要求 Origin，并继续校验 HttpOnly CSRF Cookie、`X-CSRF-Token` 和 Session Hash；页面只从 Magic Link 消费响应或受 Session 保护的 CSRF Bootstrap 接口取得 Token。只有返回 2xx 的 Customer Session 请求 best-effort 更新 `last_seen_at`；遥测写入失败记录独立错误链路但不覆盖业务响应，重定向、业务错误、鉴权或 CSRF 失败不会更新。

Customer Session 不与 Admin Session 混用。

### 4.3 Client 请求

客户端显式发送 `instance_id + product_id`。Registration Key、Machine Token 或 Trial Token 的查找和更新都同时包含 Instance；Signed License Token 本地校验 `ins`。

### 4.4 Webhook 请求

Instance ID 来自路径，不从 Event Payload 猜测。服务端在该 Instance 内定位 Provider，使用原始 Body 验签，再以 Instance 范围的幂等键持久化。

## 5. 写入边界与事务

### 5.1 Setup

User、Instance、Owner Membership、Session、审计和 Bootstrap 固定单例行必须位于同一个 D1 `batch()`。只有提交成功后才设置浏览器 Cookie。

### 5.2 Membership 修改

角色/状态更新、必要 Session 处理和审计位于同一个批次。数据库 Trigger 在最后一个 active Owner 被移除时抛出 `LAST_ACTIVE_OWNER_REQUIRED` 并回滚。

### 5.3 Invitation 接受

终态更新必须按 Invitation 主键触发数据库守卫。Invitation、Membership、可选 User/Session、Delivery 处理和审计原子提交；影响 0 行不是事务失败机制。

Invitation URL 使用 Instance 的 `admin_api_url`，不能使用 Customer `site_url`。写入 Delivery 前，邮件合同严格比较该 Origin；变量随后以绑定 `instance_id + table + row_id + field` 的 AES-GCM Envelope 保存。Scheduled Worker 没有浏览器请求 Origin，因此解密时依赖 Envelope 认证证明变量来自已校验的持久化 Delivery，并重新校验 HTTPS、无 credentials/query、固定 Admin 路径与 Token 形状，但不执行无法获得依据的第二次 Origin 比对。

### 5.4 Customer Magic Link

Challenge 终态更新、Customer Session、Delivery 处理和审计原子提交。数据库 Trigger 对重复、过期、撤销或并发消费抛出 `CUSTOMER_LOGIN_CHALLENGE_NOT_CONSUMABLE`，整个批次回滚。

### 5.5 支付履约

至少把 Inbound Event 状态、Customer/Provider 映射、Subscription/Adjustment、License、Delivery 和审计中的相关写入放入一个明确履约批次。Provider 网络调用不能假装属于 D1 事务；先保存意图/状态，提交后调用，再持久化结果。

### 5.6 License Key 轮换

旧 Key 失效、`key_version` 增加、Rotation、Delivery 和审计原子提交。明文新 Key 只存在于当前响应或加密 Delivery 变量的有限生命周期内。

## 6. D1 原子性规则

1. 先构造全部受参数化语句，再调用一次 `DB.batch()`。
2. 需要“最多一次”的终态转换必须由 Check/唯一约束/Trigger 抛错，而不是依赖更新影响行数。
3. 并发安全不能只靠应用层先读后写。
4. 数据库错误应保留原始错误码和原因链；API 可以映射稳定业务码，但不能把不同失败归一成一个无法诊断的冲突。
5. 不把外部 HTTP 调用包装成虚假的数据库事务；用持久状态和幂等恢复跨系统边界。

## 7. Scheduled Worker

Scheduled Handler 是唯一允许跨 Instance 发现任务的内部边界：

1. 分页查询存在到期任务的 active Instance；
2. 对每个 Instance 分页领取 Inbound Event 和 Email Delivery；
3. 领取和更新始终包含 `instance_id + object_id + status/lease`；
4. 清理到期的加密载荷与邮件变量；
5. 单个业务对象失败保存原始状态和 System Issue，继续处理其他对象；
6. 顶层 Worker/D1/Cron 异常进入 Workers Logs 和 Cron Events。

系统不维护 `scheduler_health` 或最近成功时间，也不以 Scheduler 状态阻塞 Admin 产品操作。

## 8. 并发与事件顺序

- Setup：固定 Bootstrap 主键使并发提交最多一个成功；
- Membership：数据库保证最后一个 active Owner 不被并发移除；
- Invitation/Magic Link：数据库终态守卫使并发消费最多一个成功；
- Activation：唯一索引和 Trigger 保证设备幂等与席位上限；
- Webhook：Instance 范围的 Event 唯一键保证幂等；
- Provider 镜像：按外部发生时间和 Event ID 拒绝旧事件覆盖新状态；
- Scheduler：租约带状态条件，超时任务可被安全重新领取。

## 9. 错误模型

错误至少保留四层：

```text
稳定业务错误码
原始数据库或 Provider 错误码
经过必要脱敏的诊断详情
request_id / event_id / delivery_id 等追踪身份
```

不得把整个错误包体隐藏，也不得丢弃具体 Provider、Trigger 或约束原因。对外响应只脱敏 Secret、Token、密码、注册码和敏感载荷。

System Issue 是聚合视图，不覆盖业务对象的原始错误。管理员标记 Issue 已处理，不会自动改变 Event、Delivery、License 或重试状态。

## 10. 配置模型

### 10.1 Deployment 配置

- Worker、D1、Assets、Cron 和 Observability：根 `wrangler.jsonc`；
- Admin/API 与 Customer Site 安全边界：Setup 写入的 Instance 级 URL；
- Setup/Encryption/Turnstile 等 Secret：Cloudflare Secrets；
- 初始 migration：`apps/server/drizzle/0000_v1_initial.sql`。

### 10.2 Instance 配置

- `instances`：随机 ID、名称、Admin/API URL、Customer Site URL、只读状态；
- Billing/Email 凭据：Admin 写入后加密存储；
- Product：支付环境、宽限期、试用；
- Plan：授权条款快照。

不建立通用 `instance_settings`，没有独立生命周期的字段直接属于其领域对象。

### 10.3 公开命名

```text
JSON / DB     instance_id
TypeScript    instanceId
Swift         instanceID
Environment   LICENKIT_INSTANCE_ID
CLI           --instance
Signed Claim  ins
```

不做别名兼容或双写。

## 11. 测试与正式环境一致性

测试和正式版本使用相同模块、接口、事务、权限和错误模型。差异只来自环境配置、资源绑定和 Provider Sandbox/Live 凭据。

测试替身必须实现同一接口和调用关系。不能通过只在测试环境存在的绕过开关证明生产路径正确。

## 12. 安全边界

- 密码使用服务端强 Hash；
- Session、CSRF、Magic Link、Invitation、Registration Key、Machine Token 只存 Hash；
- Provider Secret、邮件变量和短期敏感载荷加密存储；
- 一次性链接使用 Fragment，页面立即清理，只在内存保管；
- 所有 Instance 关联由复合外键和查询条件共同保证；
- Admin 写请求校验 Origin 与 CSRF；
- Customer Site 不持有服务端 Secret；
- 私钥不下发 CLI/SDK；客户端只配置公钥；
- 日志和审计禁止明文敏感值。

## 13. 可观测性与就绪检查

根 Wrangler 配置显式开启 Workers Observability。远程运行证据来自：

- Cloudflare Workers Logs；
- Cron Trigger 与 Cron Events；
- 请求 ID 关联的 API 日志；
- Instance 内业务对象状态和 `system_issues`。

Readiness 只检查处理请求必需的 Worker/D1 绑定和数据库访问，不读取 System Issue 或 Scheduler 状态作为业务门禁。

因此：代码存在 `scheduled()` 处理器不等于远程 Cron 已运行；本地测试通过也不等于远程 D1 migration、Bindings、Observability 或 Customer Site 已验收。
