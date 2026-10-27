# 核心业务流程

本文从用户动作到数据库提交说明关键流程。所有 Instance 业务步骤都必须先确定 Instance 边界；跨表状态变化必须由一个 D1 原子批次提交。

## 1. 首次 Setup

### 1.1 页面一：验证部署 Token

用户只输入 `INITIAL_SETUP_TOKEN`：

```http
POST /api/v1/setup/verify-token
Content-Type: application/json

{
  "setup_token": "..."
}
```

服务端校验精确 Origin、Secret 是否配置、Token 是否匹配，以及 `deployment_bootstrap` 和身份/实例关系是否仍为空。接口不写数据库，响应带 `Cache-Control: no-store`，也不回显或记录 Token。

Admin 只在当前页面内存保存 Token。刷新、关闭标签页或返回后必须重新输入；Token 不能进入 URL、Cookie、Local Storage、Session Storage、日志或分析事件。

### 1.2 页面二：收集首位 User

收集显示名称、邮箱和密码。邮箱与密码用于登录，显示名称只用于界面和审计。该页只做前端校验，不单独持久化。

### 1.3 页面三：收集首个 Instance

收集实例名称、Admin/API URL 和 Customer Site URL。Instance ID 由服务端使用 128 位安全随机数自动生成，用户不填写。

最终一次提交：

```http
POST /api/v1/setup
Content-Type: application/json

{
  "setup_token": "...",
  "user": {
    "name": "Owner Display Name",
    "email": "owner@example.com",
    "password": "..."
  },
  "instance": {
    "name": "Tidest Licensing",
    "admin_api_url": "https://license.tidest.app",
    "customer_site_url": "https://tidest.app"
  }
}
```

服务端重新验证 Token 和全部输入，并在一个 D1 批次中依次创建 User、Instance、Owner Membership、Admin Session、`instance.setup_completed` 审计和 `deployment_bootstrap` 固定单例行。任一步失败全部回滚；并发提交最多一个成功。

批次提交成功后才设置 Session Cookie。如果响应中断导致 Cookie 未落地，Setup 仍然完成，用户可通过正常登录重新建立 Session。

## 2. Admin 登录与授权

登录只接受：

```json
{
  "email": "owner@example.com",
  "password": "..."
}
```

流程：

1. 规范化邮箱并查询全局 User；
2. 验证密码；
3. 确认自部署数据库恰好有一个 active Instance；
4. 查询该 User 对唯一 Instance 的 active Membership；
5. 创建只绑定 User 的 Admin Session；
6. 写入 identity scope 登录审计。

后续业务请求通过 Session 得到 User，再实时读取 Membership，形成 `userId + instanceId + instanceRole`。Membership 已 disabled/removed 时立即拒绝当前 Instance 访问。

Cookie 鉴权写请求必须同时校验精确 Origin、CSRF Cookie、`X-CSRF-Token` 和当前 Session 绑定的 CSRF Hash。

## 3. Profile

### 3.1 修改显示名称

当前 User 只能修改自己的显示名称。写入 User 并追加 identity scope 审计；不影响任何 Membership。

### 3.2 邮箱只读

当前自部署不提供邮箱修改 API 或界面。未来如支持，必须由 Platform 全局邮件通道验证新邮箱，不能借用任意 Instance 的 Email Integration。

### 3.3 修改密码

用户提交当前密码和新密码。服务端验证当前密码后，在同一原子批次中：

1. 更新密码 Hash；
2. 撤销该 User 除当前请求 Session 外的全部 Admin Session；
3. 写入 identity scope 审计。

撤销是 User 全局范围，因此旧 Session 不能继续访问该 User 所属的任何 Instance。

## 4. Members 与 Invitation

### 4.1 邀请成员

只有当前 Instance 的 active Owner 可以创建 Invitation。请求只指定邮箱和角色，不能为受邀者设置密码或修改其 User 资料。

服务端在一个批次中：

1. 把同邮箱已经过期的 pending Invitation 转为 expired；
2. 生成高熵 Token，仅持久化 Hash；
3. 创建 `instance_invitation` 类型的 Email Delivery；
4. 创建 Invitation 并关联 Delivery；
5. 写入 instance scope 审计。

邮件 URL 使用 `/admin/invitations/accept#token=...`。Provider 调用发生在 Delivery 已持久化之后。

### 4.2 接受邀请

落地页从 Fragment 读取 Token 后立即清理地址栏，Token 只保存在页面内存，用户明确提交后才 POST 消费。

- 已存在 User：先建立有效 Admin Session，服务端确认 Session User 的规范化邮箱等于 Invitation 邮箱；
- 新邮箱：受邀者提交显示名称和自己选择的密码。

接受批次按 Invitation 主键执行终态更新，让数据库 Trigger 处理重复、撤销、过期和并发争用；随后创建或恢复 Membership、写入 `joined_by_invitation_id`，必要时创建 User/Session，并写入审计。任何一步失败全部回滚。

### 4.3 调整成员

Owner 可以修改 Membership 角色、暂停、恢复或软移除：

- `disabled` 可以直接恢复为 active；
- `removed` 不能直接恢复，必须重新邀请并接受；
- 不能降级、暂停或移除最后一个 active Owner；
- 数据库 Trigger 返回 `LAST_ACTIVE_OWNER_REQUIRED`，原始错误不能被归一化丢失。

成员管理不会修改他人的显示名称、邮箱、密码、全局状态或其他 Instance 权限。

### 4.4 撤销与重新发送

撤销只允许 pending Invitation 进入 revoked。重新发送不是复用旧 Token：同一批次撤销旧 Invitation、结束尚未接受的旧 Delivery，再创建新 Invitation、Token 和 Delivery。

## 5. Customer Magic Link

### 5.1 请求链接

Customer Site 不提交 Instance 选择字段。服务端由请求的 Admin/API Origin 唯一解析 Instance，再在 `instance_id + email` 范围查找 Customer，执行防枚举、冷却和 Turnstile 等公开入口保护。

Challenge 与 Delivery 在数据库中先创建，再调用 Provider。URL 使用 Fragment；Customer Site 负责立即清理 Fragment、只在内存保存 Token，并通过明确 POST 消费。

### 5.2 原子消费与并发

服务端可以先按 Token Hash 读取候选 Challenge，但在批次中必须按 Challenge 主键执行不带可消费状态条件的终态更新。数据库 Trigger 在重复、过期、撤销或并发消费时抛出 `CUSTOMER_LOGIN_CHALLENGE_NOT_CONSUMABLE`。

同一批次还创建 Customer Session、处理关联 Delivery 并写审计。Trigger 抛错时这些副作用全部回滚。两个并发请求最多一个成功，失败请求不能留下额外 Session、审计或 Delivery 变化。

## 6. 购买与支付履约

### 6.1 从产品页到 Checkout

Customer Site 由使用方实现。页面从自身配置得到 Paddle Offer 信息，不从可篡改的客户端参数决定 Product 或 Plan。Customer API 由 Admin/API Origin 唯一确定 Instance。Checkout 成功页只显示支付提交状态；License 签发以已验签 Webhook 履约为准。

### 6.2 Webhook 接收

Webhook 路径携带 Instance ID。服务端：

1. 解析 Instance；
2. 在该 Instance 内选择 Provider 配置；
3. 验证原始请求体签名；
4. 以 Instance、Provider 和外部 Event ID 幂等持久化 Inbound Event；
5. 尝试即时处理，失败则保留完整状态供 Scheduled Worker 恢复。

Sandbox 与 Live 使用相同模块、接口和状态机，只由配置和 Provider 环境不同。

### 6.3 Customer 解析

外部 Customer 映射以 `instance_id + billing_provider_id + external_customer_id` 为边界。不能按名称、支付方式或任意 `custom_data` 自动合并；邮箱不一致要保存 `email_mismatch/needs_attention` 和原始详情。

### 6.4 Offer Mapping

外部 Price 必须精确映射到同一 Instance 的 Product、License Plan 和购买类型。缺少或冲突 Mapping 时，事件进入可诊断状态并产生 Instance System Issue，不猜测替代方案。

### 6.5 买断与固定期限

首次成功付款在一个履约批次中创建或关联 Customer、签发 License、记录来源交易、创建邮件 Delivery、更新 Event 并写审计。重复事件返回既有履约结果，不重复签发。

买断和固定期限 License 的 `payment_grace_seconds` 固定为 `0`。

### 6.6 订阅与支付宽限期

创建订阅 Plan 时，从 Product 固化当时的 `payment_grace_seconds`；签发支付订阅 License 时再从 Plan 固化。Product 后续修改不追溯 Plan，Plan 后续修改不追溯 License。

- 支付成功：更新 Subscription 周期和 License 有效期；
- 扣款失败：按 License 已固化宽限期决定何时暂停；
- 恢复付款：在事件顺序允许时恢复 License；
- 取消自动续费：保存计划变更，不提前撤销仍有效的 License；
- 退款/拒付：保留 Adjustment 和 Event，并按明确策略暂停或撤销 License 与 active Activation。

Paddle 的支付方式订阅试用与 LicenKit 的设备 Trial Claim 是两套独立状态机。

### 6.7 事件顺序

Provider 对象镜像保存最近外部发生时间和 Event ID。旧事件不能覆盖较新的 Subscription、Customer 或 Adjustment 状态；但每个已验签 Event 仍保留其自身处理事实。

## 7. License 签发与邮件投递

License 签发成功与邮件发送成功是两个状态：

1. 履约事务先保存 License、Registration Key Hash、Delivery 与加密邮件变量；
2. 提交后调用 Provider；
3. Provider 接受后 Delivery 进入 `accepted`；
4. Provider 或配置失败时保存原始错误并进入等待配置、重试或失败状态；
5. Scheduled Worker 后续恢复投递，不回滚已经签发的 License。

`accepted` 不等于最终送达。人工再次发送创建新 Delivery；安全重置注册码会轮换 Key，并使旧 Registration Key 立即失效。

## 8. Scheduled Worker 与 System Issue

Cron 每分钟触发恢复流程：

1. 发现有到期任务的 active Instance；
2. 分 Instance 分页领取 Inbound Event 和 Email Delivery；
3. 使用 `instance_id + object_id + status/lease` 更新；
4. 清理到期的加密 Webhook 载荷和邮件变量。

系统不保存 Scheduler 最近成功时间，也不因 Scheduler 或 Issue 状态禁用 Admin 操作。业务失败写回原对象并聚合为 `system_issues`；Worker/D1/Cron 顶层异常仅进入 Workers Logs 和 Cron Events。

## 9. 客户端激活与验证

客户端公共配置只使用 Server URL、全局唯一 Product ID，以及 `signed` 模式需要的内置签名公钥。Swift SDK 从宿主 App Bundle 自动读取当前构建的 Release 版本与平台；Server 从 Product ID 解析 Instance：

1. 首次启动或没有本地凭据时，以 `credential.kind=none` 调用统一校验接口；服务端确认 Product 与设备试用状态，返回需要激活以及 Trial 可用性；这条路径不要求登记 Release；
2. 用户提交 Registration Key 和设备指纹；服务端在 Instance 内查找 License，检查测试或正式环境、业务状态、包含支付宽限期的最终有效期和席位，并创建 Activation；相同 License 和设备已有 active Activation 时返回原记录，不重复占用席位；
3. 激活返回 `activation_id` 和当前授权信息；Signed 模式同时返回包含 `ins` 与 `env` Claim 且不含 `exp` 的 Signed License Token。业务到期写入 `lexp`，Product 在线复核间隔与 License 离线宽限期通过响应元数据下发；
4. Product/设备 Trial 通过 `trials/claim` 提交 Product 和设备指纹；首次创建 Trial，重复领取返回原编号、原到期时间和当前状态。之后统一使用 `/client/validate`，License 提交 `activation_id`，Trial 提交 `trial_id`，两者均携带设备指纹；
5. 统一校验把 License、Trial、无凭据三条路径投影为同一个授权状态树。到期、暂停、吊销、Activation 失效、Release 不合格和需要激活都是已确认的业务状态，不是传输失败；
6. Swift SDK 把 `validated_at`、Product 在线复核间隔与 License 离线宽限期保存为业务快照；超过离线宽限期只进入强提示，不停止授权；
7. `/validate` 另存 `lastValidateResponseAt`：合法成功业务响应或明确 HTTP 失败会推进它；DNS、TLS、超时、断网等无 HTTP 响应失败，以及 2xx 非法正文不会推进。HTTP 失败也不得推进 `validated_at`；
8. SDK 的 `validate(trigger:)` 按宿主标注的用户主动或静默意图区分请求门槛。所有新请求从上次请求尝试起遵守固定 30 秒间隔；Product 在线复核间隔只约束静默调用。用户主动、缓存 active Trial/License 首次到期、Release 身份变化首次静默复核，以及 Signed Token 本地失效可豁免 Product 间隔；到期和 Release 变化的提前尝试各只执行一次。两种未执行原因分别返回 SDK 本地代码 `SDK_VALIDATION_MIN_INTERVAL` 与 `SDK_VALIDATION_PRODUCT_INTERVAL`，不混同服务端 HTTP 429；
9. `activate()`、`startTrial()` 和 `deactivate()` 不受冷却限制，也不写 `lastValidateResponseAt`。显式操作返回的 `validated_at` 仍是业务事实，但不能代替最近 `/validate` 响应时间；
10. 仅在服务端确认解绑后清除 License 凭据。无凭据解绑只产生 `source=local` 的“需要激活”快照，不伪造一次在线验证；
11. 同一 Swift SDK 实例内并发发起的实际 `/validate` 请求共享结果；若静默调用因 Product 间隔被跳过，同时到来的用户主动调用仍会独立判断。激活、领取 Trial、解绑和快照写入与校验使用同一顺序化边界，避免旧响应覆盖新状态。

LicenKit CLI 共享 Server 的统一请求、状态和 Signed Token 合同，但不运行 Swift SDK 的本地冷却协调器；当前每次显式执行 `licenkit validate` 都向 Server 发起请求。

状态快照保留业务 `code` 和按字段脱敏的安全 `details`；操作结果另保留 `request_id`，使宿主应用可以把用户看到的状态与服务端日志串联。协议/凭据错误和传输失败不改写成授权终态。公开合同不接受旧字段、旧 CLI 选项、旧环境变量或旧 Claim。

## 10. Customer Site 边界

LicenKit 提供 Customer、Magic Link、License/Activation 和 Billing API 合同，不接管使用方站点的页面、路由、品牌、Cookie UI 或托管。

使用方 Customer Site 必须实现：

- `/customer/auth` 对应的登录入口或自身等价路由；
- Fragment Token 读取、立即清理和内存保管；
- License、设备和订阅管理界面；
- 对 API 原始错误码的安全展示或支持 ID 关联。

站点不能自行签发 License、直接读取 D1、持有 Provider Secret，或把 Magic Link Token 写入查询参数、日志和持久化存储。
