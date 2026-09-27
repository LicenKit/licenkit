# 领域模型与命名

本文定义当前 LicenKit 主线的领域语言。这里的名称是数据库、API、Admin、CLI 和 SDK 的共同合同，不是界面文案的同义词集合。

## 1. 三条核心边界

### 1.1 Deployment（部署）

Deployment 是一组已经运行的 Worker、D1、静态 Admin 和资源绑定。它是运行环境，不是租户，也不是管理员身份。

- 当前自部署版：一个 Deployment 只开放一个 Instance；
- 目标数据模型：允许一份 D1 保存多个 Instance，以兼容未来 SaaS；
- 当前产品不提供创建第二个 Instance 或切换 Instance 的入口。

### 1.2 User（管理员用户）

User 是使用邮箱和密码登录 Admin 的全局身份：

- 邮箱大小写不敏感且全局唯一；
- 显示名称不参与认证；
- User 不保存全局角色或全局状态；
- 一个 User 可以通过 Membership 加入多个 Instance，并在各 Instance 拥有不同角色；
- User 与购买产品的 Customer 是两套身份，不能因为邮箱相同而自动合并。

当前自部署版允许 User 修改自己的显示名称和密码，邮箱只读。修改密码必须验证当前密码，并撤销该 User 除当前请求 Session 外的全部 Admin Session。

### 1.3 Instance（实例/租户）

Instance 是授权业务空间，也是唯一的租户隔离边界。Product、Customer、License、支付、邮件、Customer Session、System Issue 和实例审计都必须归属明确的 Instance。

Instance 只有一个稳定 ID：首次 Setup 生成不带类型前缀的 22 位 Base64URL 随机字符串，用于数据关联、客户端配置、签名 Token 和支付 Webhook 路由。Customer Portal 与 Magic Link 由 Admin/API Origin 唯一解析 Instance，不再使用第二套人工标识。

当前自部署版创建的唯一 Instance 保持 `active`。Admin 可以展示状态，但不提供修改状态的 API 或界面；`suspended/archived` 仅为未来 SaaS 控制面预留。

## 2. 身份与授权

### 2.1 Instance Membership（实例成员关系）

Membership 表达某个 User 在某个 Instance 中的角色和访问状态。

角色：

```text
owner / admin / member / viewer
```

状态：

```text
active    正常访问
disabled  暂停访问，可以恢复
removed   软移除；重新加入必须再次接受邀请
```

只有 active Membership 可以进入 Instance。角色必须在每个业务请求中从数据库读取，不能长期固化在 Session 或相信客户端提交值。

每个 active Instance 至少保留一个 active Owner。降级、暂停、软移除或删除最后一个 active Owner 必须由数据库约束拒绝，稳定错误码为 `LAST_ACTIVE_OWNER_REQUIRED`。

### 2.2 Instance Invitation（实例邀请）

Invitation 是 Owner 邀请某个邮箱加入当前 Instance 的待确认事实。它保存规范化邮箱、目标角色、Token Hash、有效期、发送记录和终态，不在接受前创建占位 User 或 Membership。

- 新邮箱：受邀者自己设置密码，原子创建 User、Membership、Session 并接受邀请；
- 已存在 User：必须先登录或完成等价身份确认，且 User 邮箱与邀请邮箱一致；
- `pending` 可以进入 `accepted/revoked/expired`，三个终态不能再次转换；
- 同一 Instance 和邮箱最多只有一个 pending Invitation；
- 重新发送会撤销旧 Invitation 并生成新 Token 与新 Delivery，旧链接立即失效；
- `removed` Membership 重新加入时必须关联一条新接受的 Invitation。

邀请链接与 Customer Magic Link 共用服务端一次性链接组件，但使用不同数据表、端点和成功副作用。共同安全合同是：高熵 Token、只存 Hash、可信 Origin、URL Fragment、页面立即清理 Fragment、Token 只在内存、明确 POST 消费、过期/撤销/并发终态守卫，以及敏感值不进入日志和浏览器持久化。

### 2.3 Admin Session

Admin Session 只绑定 `user_id`，只证明全局 User 身份，不固化 Instance 或角色。请求进入业务路由后再读取当前 Instance 的 active Membership，形成：

```text
userId + instanceId + instanceRole
```

Membership 被暂停或软移除后，已有 Session 也不能继续访问该 Instance。密码修改撤销其他 Session 的范围是 User 全局范围，不能缩小到某个 Instance。

## 3. 授权业务对象

### 3.1 Customer（客户）

Customer 是某个 Instance 内购买或持有 License 的主体。Customer 邮箱只在 Instance 内唯一。Customer 不等于 User，也不共享 Admin Session、密码或 Membership。

### 3.2 Product 与 Product Release

Product 是可授权的软件或数字产品；Product Release 是产品的不可变发布事实，由 `version + platform + artifact_sha256` 标识可验证构建物。

Product 还持有：

- 支付环境；
- 默认支付宽限期 `payment_grace_seconds`，默认 `0`；
- 无需支付方式的设备试用配置；
- active/archived 生命周期。

Release 记录不替代应用构建、签名、托管或发布流程。

### 3.3 License Plan（授权方案）

License Plan 是新 License 的条款模板，保存修订号和以下快照来源：

- `license_model`：`perpetual/fixed_term/subscription`；
- `credential_mode`：`opaque/signed`；
- 有效期、更新权益期、激活上限、功能集；
- Signed Token TTL；
- 支付型订阅的 `payment_grace_seconds`。

创建订阅 Plan 时，从 Product 固化当前宽限期；非订阅 Plan 的宽限期固定为 `0`。Product 后续变化不追溯已有 Plan。

### 3.4 License

License 是已经签发给 Customer 的授权事实。它必须固化签发时的 Plan 修订、授权模型、续期模式、凭证模式、功能、激活上限、Signed Token TTL 和支付宽限期。

License 状态为 `active/suspended/revoked`。Plan 后续修改不追溯已签发 License。

### 3.5 凭证与 Signed License Token

- Registration Key：仅在签发、找回或安全轮换的响应/邮件变量中短暂出现；数据库保存 Hash；
- Machine Token：绑定一次 Activation，数据库保存 Hash；
- Signed License Token：供本地离线验证，必须由 Product 的 Ed25519 Key 签名。

Signed License Token 使用 `ins` Claim 表示 Instance ID，不接受旧 Claim 别名。CLI 和 SDK 必须同时校验 Instance、Product、License、Activation、设备指纹、有效期和签名。

### 3.6 Activation 与 Trial Claim

Activation 是 License 占用的设备席位。释放设备只终止 Activation，不改变 License 所有权。

Trial Claim 是 Product 与设备指纹的一次性试用事实。它在领取时固化时长、功能和绝对过期时间；Product 配置变化只影响后续首次领取。支付平台的订阅试用是另一套模型。

## 4. 支付与履约

### 4.1 Billing Provider 与 Offer Mapping

Billing Provider 保存当前 Instance 的支付环境和加密凭据。Offer Mapping 把外部 Price 精确映射到 Product、License Plan 和购买类型。

Webhook 不能根据价格名称、金额或客户端参数猜测方案。所有 Provider、Customer、Product、Plan 和 License 关联都必须带 `instance_id`。

### 4.2 Billing Customer 与 Subscription

Billing Customer 是外部 Provider Customer 到 Instance Customer 的映射。唯一身份至少由 `instance_id + billing_provider_id + external_customer_id` 组成。

Billing Subscription 保存 Provider 订阅的镜像状态，不是 License 本身。License 的有效性由已固化条款与履约事件共同决定。

### 4.3 Inbound Event 与幂等履约

Inbound Event 保存已经验签的 Provider 事件、处理状态、原始事件时间和受限保留的加密载荷。幂等键、领取、重试和更新都不能跨 Instance。

Webhook 接收和履约是两个阶段：先验证并持久化，再由即时处理或 Scheduled Worker 原子履约。重复事件必须返回既有结果，而不是重复签发 License。

## 5. 邮件与一次性链接

### 5.1 Email Integration 与 Template Binding

Instance 配置自己的邮件 Provider 和模板引用。LicenKit 管理类型化、版本化的变量合同；邮件主题、HTML、文案和模板版本由 Provider 托管。

### 5.2 Email Delivery

Delivery 必须在调用 Provider 前持久化。`accepted` 只表示 Provider 已接收请求，不等于邮件已送达。

当前收件人类型只有：

```text
customer
instance_invitation
```

每条 Delivery 都有非空 `instance_id`。Invitation Delivery 没有 `customer_id`；Customer Delivery 必须通过复合外键证明 Customer 属于同一 Instance。

### 5.3 Customer Magic Link

Customer Login Challenge 消费必须把以下副作用放进同一个 D1 原子批次：

- Challenge 进入 consumed 终态；
- 创建 Customer Session；
- 结束相关 Delivery；
- 写入审计。

批次内按 Challenge 主键执行终态更新，让数据库 Trigger 在重复、过期、撤销或并发消费时抛出 `CUSTOMER_LOGIN_CHALLENGE_NOT_CONSUMABLE` 并回滚全部副作用。不能使用带 `status` 条件且影响 0 行的更新来模拟事务失败。

## 6. System Issue 与 Scheduler

System Issue 是 Instance 业务错误的聚合告警，只记录可明确归属某个 Instance 的 Billing、Webhook 和 Email 等错误。业务对象仍保存自己的状态和原始错误；Issue 不替代原始记录，也不作为产品操作门禁。

Deployment 级异常，例如 Worker 启动失败、D1 不可用、Cron 顶层异常或绑定错误，由 Cloudflare Cron Events、Workers Logs 和部署平台报告，不写入 `system_issues`。

系统不持久化 Scheduler 最近成功时间或独立健康表。Scheduled Worker 可以跨 Instance 发现到期任务，但必须先分页得到 Instance，再在每个 Instance 内使用 `instance_id + object_id + status/lease` 领取和更新。

## 7. 审计边界

审计范围只有：

- `identity`：`instance_id` 为空、User actor 非空，记录登录、登出、显示名称和密码变更；
- `instance`：`instance_id` 非空，记录实例业务、Membership、Invitation 和 Setup 完成。

Instance Owner 只能读取当前 Instance 的审计，不能读取成员的全局身份审计。

## 8. 命名合同

对外只使用 Instance 术语，不保留旧租户字段别名或双写：

| 边界 | 形式 | 示例 |
| --- | --- | --- |
| 数据库、JSON | `snake_case` | `instance_id` |
| TypeScript | `camelCase` | `instanceId` |
| Swift | Swift 惯例 | `instanceID` |
| 环境变量 | 大写下划线 | `LICENKIT_INSTANCE_ID` |
| CLI | 长选项 | `--instance` |
| Signed Token | 短 Claim | `ins` |
| Customer 路由 | 固定路径 | `/customer/auth` |

返回完整对象时不重复前缀：

```json
{
  "instance": {
    "id": "3Jd9K_aP0qUwbL6F7sTn2Q"
  }
}
```

## 9. 核心不变量

1. 所有 Instance 业务查询、唯一约束、复合外键和幂等键都包含 `instance_id`。
2. User 的身份字段与 Membership 的实例权限分别管理。
3. 每个 active Instance 始终至少有一个 active Owner。
4. Invitation 和一次性链接最多成功消费一次，终态争用失败会回滚同批次全部副作用。
5. Setup 完成只能由 `deployment_bootstrap(singleton_key='deployment')` 表达，并与完整初始关系一起原子提交。
6. Product → Plan → License 的支付宽限期逐级固化，不做追溯更新；非订阅值始终为 `0`。
7. System Issue 与 Scheduler 状态都不决定产品操作是否允许。
8. 当前主线从空数据库建立新合同，不提供旧字段、旧 Claim 或旧路径兼容层。
