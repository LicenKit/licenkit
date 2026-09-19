# 领域模型与命名

## 1. 问题与范围

LicenKit 的核心任务不是“生成一串注册码”，而是把可信的购买事实转换成客户端能够执行的授权事实。

```text
购买事实
  -> 支付履约
  -> License 及其授权条款
  -> 设备激活
  -> 在线校验及可选的签名离线校验
```

支付平台、邮件系统和客户端都只消费或产生这个链路中的一部分信息，任何一个外部系统都不能代替 LicenKit 成为授权事实来源。

## 2. 命名体系

### 2.1 Account（账户）

一个独立的软件发行主体，也是未来 LicenKit Cloud 中的租户安全边界。产品、Release、支付配置、Customer、License 和出站端点都属于账户。

LicenKit 是未来 LicenKit Cloud SaaS 的子集，因此 V1 保留完整多账户能力，但 Cloud 控制面不属于本期实现范围。独立部署通过首次安装 Setup 创建一个初始 Account 和 Owner，后续业务仍走相同的账户解析、授权和查询路径。未来 Cloud 只能接入相同的内部 Account Provisioning 边界，V1 不实现 Cloud API 或 Cloud Adapter。

`account_id` 必须来自已验证的管理员 Session、Customer Session、Billing Provider 路由或固定客户端配置，不能信任请求体中一个未经绑定的任意值。

### 2.2 Customer（客户）

Customer 表示获得一个或多个 License 的购买者身份。它属于一个 Account，由支付履约或管理员手动签发自动创建，不通过公开注册页面创建。

Customer 使用经过规范化的邮箱作为联系与 Magic Link 验证渠道，但邮箱不是 License 的主键。License 通过稳定的 Customer ID 归属客户，因此修改联系邮箱不需要迁移 License 身份。

Customer 与管理员 User 是两套独立身份：Customer 不能登录管理控制台，管理员权限也不能通过 Customer Portal 获得。

### 2.3 Product（产品）

被授权的软件。产品拥有客户端标识和签名密钥，但不直接定义售卖权益。

### 2.4 Product Release（产品发布记录）

Product Release 是服务端认可的一个具体可分发构建，用于判定版本更新权益。每条记录至少包含：

- 版本标识 `version`；
- 发布工件平台标识 `platform`，与 Activation 记录的设备平台是两个字段；
- 可空说明 `description`；
- 可空下载地址 `download_url`；
- 构建文件 SHA-256 `artifact_sha256`，必填；
- 由发布流程写入的可信 UTC 发布时间 `released_at`。

同一 Product 的 `version + platform` 唯一。发布后，版本、平台、发布时间和 Hash 不可原地修改；说明和下载地址可以更新。新二进制或新 Hash 必须创建新的 Release 记录，不能覆盖已有发布事实。

Hash 用于下载完整性检查和发布审计，不是远程证明：被修改的客户端仍可能伪造版本号。LicenKit 能保证的是不再信任客户端自报的发布时间，并把服务端认可的 Release 身份签入授权凭证。

### 2.5 License Plan（授权方案）

授权方案替代旧名称 `Policy`。它是签发未来 License 时使用的可编辑模板，例如 Personal Lifetime、Pro Annual 或 Team Monthly。

授权方案定义：

- 授权模型：买断、固定期限或订阅；
- 凭证模式：不透明凭证或签名凭证；
- 最大激活数；
- 功能列表；
- 默认期限、Signed License Token 有效期和支付宽限期；
- 是否允许继续用于新签发。

授权方案编辑只影响之后签发的 License。停止销售使用 `archived`，不会让已有 License 失效。

### 2.6 License Terms（授权条款）

授权条款是签发时从授权方案解析并固化到 License 的实际权益。它不是独立销售模板，而是已售合同的机器可执行表达。

V1 固化以下字段：

- `license_model`；
- `credential_mode`；
- `max_activations`；
- `features`；
- `updates_until`；
- `signed_token_ttl_seconds`；
- `payment_grace_seconds`；
- 来源授权方案 ID 和 revision。

普通编辑授权方案不得修改这些存量值。升级、降级或批量赠送权益必须使用显式迁移操作并写入审计日志。

### 2.7 License

License 是一位客户持有的一份授权身份。它包含：

- 注册码哈希；
- 稳定的 Customer 归属；
- 固化后的授权条款；
- 当前状态与到期时间；
- 支付来源和外部绑定；
- 激活列表。

订阅每次续费更新同一个 License 的有效期，不创建新的 License。

### 2.8 Activation（激活）

激活表示一个 License 当前授权了一台设备。它替代旧名称 `Machine`，因为系统管理的是授权关系，不是设备资产本身。

激活包含设备指纹哈希、机器令牌哈希、平台、名称、最近验证时间和状态。吊销激活应保留历史记录，不直接删除，以便回溯席位变化。

### 2.9 三类凭证

| 凭证 | 用途 | 是否长期保存明文 | 是否可离线证明授权 |
| --- | --- | --- | --- |
| License Key（注册码） | 创建或恢复设备激活 | 否，只保存规范化后的哈希 | 否 |
| Machine Token（机器令牌） | 已激活设备调用在线验证和解绑接口 | 否，只保存哈希 | 否 |
| Signed License Token（签名授权令牌） | 客户端本地验证签名授权快照，包括无网络场景 | 客户端保存签名文本 | 是，限 Token 有效期内 |

注册码格式与凭证能力是两个维度。注册码本身始终可以采用高熵、易输入的格式化随机串；`credential_mode` 只决定激活成功后服务端签发哪组设备凭证。

### 2.10 License Model 与 Credential Mode

`license_model` 描述 License 的有效期如何演进，不描述支付平台：

| 值 | 定义 | `expires_at` 的来源 |
| --- | --- | --- |
| `perpetual` | 永久 License，不因时间自然失效 | 必须为空 |
| `fixed_term` | 签发时确定固定有效期，到期后不会因支付事件自动延长 | 签发时间加固化的期限 |
| `subscription` | 有效期跟随外部订阅周期，续费延长同一个 License | 支付平台的 `current_period_end` |

`license_model` 是 License Terms 的一部分。授权方案后续修改不能追溯改变已售 License 的生命周期。

它与支付映射中的 `purchase_type` 不是同一个字段：前者描述 License 如何到期，后者描述支付事件是一次性购买还是订阅。V1 要求二者保持一致：`one_time` 只能映射到 `perpetual` 或 `fixed_term`，`subscription` 只能映射到同名的 License model。

`credential_mode` 描述客户端得到的凭证集合，不描述是否联网。两种模式都使用相同的在线激活和在线校验接口：

| 值 | 激活返回 | SDK 公钥要求 | 断网时能否独立证明授权 |
| --- | --- | --- | --- |
| `opaque` | `activation_id` + `machine_token` | 不需要 | 不能，只能使用宿主应用明确允许的短期缓存策略 |
| `signed` | 上述凭证 + Ed25519 `signed_license_token` | 必须配置受信公钥 | 可以，在 Token 有效期内本地验签 |

Machine Token 的内容对客户端没有可解释语义，只能由服务端查询和判定。`signed` 模式不会替代 Machine Token，而是在相同在线流程上额外增加 Signed License Token。

### 2.11 Update Entitlement（版本更新权益）

版本更新权益与 License 使用期限是两个独立维度。V1 只对 `perpetual` License 提供版本期限限制：

| 授权方式 | 使用权 | 可使用的版本 |
| --- | --- | --- |
| 永久全版本 | 永久 | 所有未来版本 |
| 永久限期更新 | 永久 | `updates_until` 时间点及之前发布的版本 |
| 固定期限 | 到 `expires_at` | 有效期内不额外限制版本 |
| 订阅 | 跟随订阅周期 | 订阅有效期内不额外限制版本 |

授权方案使用相对字段 `update_window_seconds`：

- `NULL`：不限制未来版本；
- 正整数：从 License 生效时间开始计算版本更新窗口。

License 签发时把相对窗口解析为绝对的 `updates_until`：

- `NULL`：永久使用所有未来版本；
- UTC 时间：只允许使用 `released_at <= updates_until` 的 App 版本。

`updates_until` 不是 License 到期时间。到达该时间不会让已获得资格的旧版本失效。修改授权方案中的 `update_window_seconds` 不得追溯修改已售 License；续费更新权益必须显式延长同一个 License 的 `updates_until` 并写入审计，不更换注册码。

客户端激活和在线校验只提交 `release_version + release_platform`。服务端必须在当前账户和 Product 下找到唯一 Product Release，并使用该记录的 `released_at` 与 `updates_until` 比较；未知 Release 默认拒绝，不能回退为客户端自报日期或当前时间。设备平台单独用于 Activation 诊断，不能替代发布工件平台。

### 2.12 Customer Portal、Magic Link 与 Customer Session

Customer Portal（客户授权中心）是购买者查看和管理自己授权的页面，不是管理控制台，也不是通用社区账号系统。

- **Magic Link**：发送到 Customer 当前邮箱的一次性短期登录凭证；服务端只保存 Token 哈希；
- **Customer Session**：Magic Link 消费成功后建立的客户会话；服务端只保存会话 Token 哈希，可过期和主动吊销；
- **Customer Portal**：使用 Customer Session 访问，只能读取当前 Customer 名下的 License、Subscription 和 Activation，并执行已明确授权的自助动作。

V1 不提供 Customer 自主注册、密码登录和找回密码。没有匹配 Customer 的邮箱请求不会创建空 Customer，也不会创建登录通知，但接口对外返回与有效邮箱相同的接受响应，避免泄露客户是否存在。

客户可以释放自己 License 下的某个 Activation。该动作记录为 `deactivated` 并保留历史，不等同于管理员因违规或风控执行的 `revoked`。客户不能自行暂停、吊销 License 或修改 License Terms。

V1 不开放 Customer 自助修改登录邮箱，由管理员执行并吊销旧 Challenge 与 Session。Customer Portal 不展示或调用邮箱修改入口。

### 2.13 Billing Provider、Offer Mapping 与 Billing Subscription

- **Billing Provider**：一个账户对某个支付平台的配置，保存环境、启用状态、加密后的 Webhook Secret，以及可选的客户门户 API Secret；
- **Offer Mapping**：把支付平台的 price/variant 标识映射到某个授权方案；
- **Billing Subscription**：把外部订阅 ID 与一个 License 绑定，并记录当前支付周期和外部状态。

支付标识必须存放在专用、可索引字段中，不能继续混入授权方案或 License 的自由格式 metadata。

支付方式、自动续费、取消和账单资料由支付平台托管页面负责。LicenKit 可以通过支付 Adapter 创建短期客户门户会话，但不能通过修改本地 Subscription 字段冒充支付平台操作成功；最终状态仍以支付 Webhook 为准。

### 2.14 Inbound Event 与 Fulfillment

Inbound Event 是支付平台发送的不可变事实。Fulfillment 是 LicenKit 根据该事实执行的领域动作，例如创建 License、延长期限或暂停使用。

同一个支付事件可以被多次投递，但只能产生一次业务结果。接收路由先绑定具体 Billing Provider，事件幂等身份由 `billing_provider_id + external_event_id` 唯一确定；支付产生 License 时还使用 `billing_provider_id + external_transaction_id` 作为业务结果唯一键，防止不同事件重复履约同一交易。

### 2.15 Outbound Endpoint、Delivery 与 Attempt

- **Outbound Endpoint**：客户配置的 Webhook 接收地址；
- **Delivery**：一条需要可靠送达的逻辑消息；
- **Attempt**：Delivery 的一次 HTTP 请求尝试。

通知端点类型分为：

- `notification_gateway`：请求外部系统发送发码、找回等客户邮件；
- `event_subscriber`：把 License、激活或订阅事件广播给客户系统。

V1 对每个账户只允许一个启用中的 `notification_gateway`，避免一次业务动作发送多封客户邮件；业务事件订阅端点可以有多个。

## 3. 领域不变量

以下约束不能由界面或调用方自行解释：

1. 一个外部订阅最多绑定一个 License，一个 License 最多绑定一个同渠道外部订阅。
2. 续费只能延长原 License，不能发新 License。
3. 同一入站支付事件只能完成一次履约。
4. 注册码轮换后旧注册码立即失效。
5. 普通找回保留已有激活；安全重置吊销全部激活。
6. 只有 `credential_mode=signed` 且 Signed License Token 验签成功时，客户端状态才能称为本地签名验证通过；无网络时才能进一步表述为离线授权有效。
7. 授权方案归档只阻止新签发，不影响存量 License。
8. 修改授权方案不得隐式改变存量 License Terms。
9. `perpetual` License 的 `updates_until` 只限制新版本资格，不能使已符合条件的旧版本失效。
10. `fixed_term` 和 `subscription` 不使用 `updates_until` 叠加第二套版本期限。
11. License 状态、到期时间、版本资格和最大激活数由服务端条款与 SDK 共同执行，客户端调用方不能自行扩大。
12. 支付履约和客户通知是两个独立状态；授权创建成功不等于邮件已经送达。
13. 出站 Webhook 返回 2xx 只表示接收方接受请求，不表示邮件进入收件箱。
14. 所有失败必须保留原始渠道、事件 ID、HTTP 状态和可诊断错误，不得归一化成无来源的“处理失败”。
15. 一个 Customer 只能访问 `customer_id` 属于自己的 License、Subscription、Activation 和相关操作。
16. Magic Link 只能消费一次；过期、已消费、已吊销或 Customer 被禁用时不能建立 Customer Session。
17. Customer Portal 发起的订阅管理只能进入支付平台托管页面，本地 Subscription 状态只能由已验证的支付事件更新。
18. Customer 释放设备只把目标 Activation 标记为 `deactivated`，不能删除历史，也不能影响其他 Customer 的授权。
19. 修改 Customer 邮箱或禁用 Customer 必须吊销其未消费 Magic Link 和现有 Customer Session，但不能隐式改变其 License 状态。
20. 任意资源关联的两端必须属于同一 Account；数据库以 `(account_id, id)` 复合外键或等价约束拒绝跨账户关联。
21. 所有管理端、Customer、支付和后台任务查询都必须把已验证的 `account_id` 作为必填条件；不得先按全局 ID 查询后再做应用层租户判断。
22. 未被角色权限矩阵明确允许的管理端操作一律拒绝。
23. 版本更新权益只使用服务端 Product Release 的 `released_at`；未知版本或平台不能通过客户端自报日期获得资格。

## 4. 状态所有权

| 状态 | 权威来源 |
| --- | --- |
| 支付是否成功、订阅周期 | 支付平台事件，经签名验证后写入 LicenKit |
| License 是否可用 | LicenKit License 状态、到期时间和授权条款 |
| 当前 App 版本是否可用 | 服务端 Product Release 的 `released_at` 与 License `updates_until`；Signed Token 携带同一发布事实供本地检查 |
| 某设备是否占用席位 | LicenKit Activation |
| Customer 是否可以访问某份 License | License 的 `customer_id` 与当前 Customer Session |
| 自动续费、取消和支付方式 | 支付平台；LicenKit 只创建托管页面会话并接收后续 Webhook |
| 本地签名授权是否可用 | `signed` 模式下客户端对 Signed License Token 的签名、设备和有效期验证 |
| 邮件请求是否被接收 | Notification Webhook HTTP 响应与 Delivery 记录 |
| 邮件是否最终投递到邮箱 | 外部邮件系统；V1 不宣称掌握该状态 |

## 5. 显式操作与普通编辑

以下动作必须是独立操作，不能隐藏在普通字段编辑中：

- 将新授权方案 revision 应用到已有 License；
- 订阅升级或降级；
- 普通找回注册码；
- 安全重置注册码并吊销激活；
- Customer 修改联系邮箱；
- 暂停、恢复和吊销 License；
- 重试失败的原出站 Delivery。

这些动作会改变已售权益、现有凭证或外部副作用，因此需要单独审计和幂等控制。
