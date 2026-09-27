# 邮件 Provider 模板与 Delivery 精简设计

状态：已实现，尚未部署

## 1. 要解决的问题

LicenKit 当前只需要发送业务邮件，没有对外的出站业务 Webhook。原设计把邮件、Webhook、配置测试和每次发送尝试都放进通用 Outbound 模型，带来了三个实际问题：

1. Delivery 固化 Provider 请求快照，配置修改后，未成功邮件仍使用旧 API Key、From、Reply-To 或模板；
2. revision 和“已测试证据”被当作业务发送门禁，但它既不能证明远程模板仍然正确，也会阻止本可成功的真实发送；
3. 每次 Attempt 一行以及多组错误字段增加了数据和操作复杂度，却没有改变重试决策。

精简后的业务规则是：

> 只要邮件尚未成功，每次发送都读取当前 active Integration 和 Binding。Delivery 只保存业务事件发生时确定的收件人、合同版本和变量。

## 2. 删除范围

完整删除以下未使用能力：

- `outbound_endpoints`
- `outbound_deliveries`
- `outbound_attempts`
- 出站 Webhook Dispatcher 和 Scheduler 分支
- `prepareNotificationDelivery`
- `prepareEndpointTestDelivery`
- Admin 的“业务 Webhook”和“Outbound Delivery”页面/API
- 对应旧测试与旧文档

Paddle 入站 Webhook 不在删除范围内，仍由 `inbound_events` 接收和处理。

## 3. 数据模型

所有邮件相关表都必须包含 `account_id`，用于租户隔离。`email_deliveries` 额外强制包含 `customer_id`，因为每封业务邮件都属于一个 Customer。

### 3.1 `email_integrations`

保存当前 Provider 连接配置。这里没有 revision；配置变化直接成为下一次发送使用的当前配置。

| 字段 | 约束 | 用途 |
|---|---|---|
| `id` | TEXT，主键 | Email Integration ID |
| `account_id` | TEXT，非空，外键 | 所属 Account；所有读写都按 Account 过滤 |
| `provider` | TEXT，非空，V1 仅 `resend` | 选择 Provider Adapter |
| `name` | TEXT，非空 | 管理端显示名称 |
| `credential_ciphertext` | TEXT，非空 | 版本化 Provider 凭证的加密结果；API 不回显 |
| `default_from_email` | TEXT，非空 | 发送时使用的当前 From 邮箱 |
| `default_from_name` | TEXT，可空 | 发送时使用的当前 From 名称 |
| `reply_to_email` | TEXT，可空 | 发送时使用的当前 Reply-To |
| `max_automatic_attempts` | INTEGER，1–20 | 当前配置允许的自动 Provider 调用总次数，包含首次调用 |
| `status` | TEXT，`active`/`disabled` | 是否可被发送流程选中；同一 Account 最多一个 active |
| `created_at` | TEXT，非空 | 创建时间 |
| `updated_at` | TEXT，非空 | 最近配置变化时间 |

### 3.2 `email_template_bindings`

把代码中预定义的邮件合同绑定到当前 Provider 模板。Binding 是配置，不保存测试历史。

| 字段 | 约束 | 用途 |
|---|---|---|
| `id` | TEXT，主键 | Binding ID |
| `account_id` | TEXT，非空，外键 | 所属 Account |
| `email_integration_id` | TEXT，非空，复合外键 | 所属 Integration，必须与 Account 一致 |
| `notification_type` | TEXT，非空 | 代码合同名称，例如 `customer.license_issued` |
| `contract_version` | INTEGER，>= 1 | 代码合同版本 |
| `provider_template_ref` | TEXT，非空 | 当前 Provider Template ID 或 Alias |
| `status` | TEXT，`active`/`disabled` | 是否可被发送流程选中 |
| `created_at` | TEXT，非空 | 创建时间 |
| `updated_at` | TEXT，非空 | 最近配置变化时间 |

同一 `account_id + email_integration_id + notification_type` 只有一条当前 Binding。`contract_version` 是这条当前配置要求使用的代码合同版本；升级后不保留旧版本兼容通道。

### 3.3 `email_deliveries`

每封业务邮件一行。没有 Attempt 子表，也不保存 Provider 请求快照。

| 字段 | 约束 | 用途 |
|---|---|---|
| `id` | TEXT，主键 | Email Delivery ID |
| `account_id` | TEXT，非空，外键 | 所属 Account；调度和 Admin 查询的租户边界 |
| `customer_id` | TEXT，非空，复合外键 | 收件 Customer；必须属于同一 Account |
| `notification_type` | TEXT，非空 | 业务邮件合同名称 |
| `contract_version` | INTEGER，>= 1 | 创建时校验变量所用的代码合同版本 |
| `recipient_email` | TEXT，非空 | 业务事件发生时确定的收件地址 |
| `variables_ciphertext` | TEXT，可空 | 业务变量的加密 JSON；cancelled/expired 时立即清除，accepted 后按保留期限清除 |
| `send_expires_at` | TEXT，可空 | 内容本身的业务发送期限；当前用于 Magic Link |
| `variables_expires_at` | TEXT，可空 | Provider accepted 后才写入的敏感变量清理时间 |
| `status` | TEXT，非空 | `pending`、`processing`、`waiting_configuration`、`retry_scheduled`、`accepted`、`failed`、`expired` 或 `cancelled` |
| `attempt_count` | INTEGER，>= 0 | 已实际调用 Provider 的次数；本地配置/合同校验失败不增加 |
| `next_attempt_at` | TEXT，可空 | Provider 明确返回可重试结果后的下一次调度时间 |
| `provider_message_id` | TEXT，可空 | Provider 接受请求后返回的消息 ID |
| `last_error_json` | TEXT，可空，JSON Object | 当前最后一次失败的结构化诊断；保留原始错误类型、码、HTTP 状态和必要脱敏详情 |
| `locked_by` | TEXT，可空 | processing 租约持有者 |
| `locked_until` | TEXT，可空 | processing 租约到期时间 |
| `accepted_at` | TEXT，可空 | Provider 接受请求的时间 |
| `created_at` | TEXT，非空 | Delivery 创建时间 |
| `updated_at` | TEXT，非空 | 最近状态变化时间 |

不保留以下字段，因为它们不能帮助当前发送决策：

- `license_id`：业务关联由现有业务表的 `delivery_id` 表达，Delivery 本身只需要 Customer；
- `request_ciphertext`：请求应在发送时由最新配置和事件变量生成，固化它会制造旧配置；
- `last_http_status`、`last_error_code`、`last_response_redacted`：合并为一个结构化 `last_error_json`，保留完整但经过必要脱敏的诊断；
- Provider/Template/From/Reply-To 快照和 revision：下一次发送读取当前配置；
- idempotency key 字段：由 `Delivery ID + 当前规范化请求摘要` 确定性计算，不必持久化。

### 3.4 业务表外键

以下 `delivery_id` 改为引用同 Account 的 `email_deliveries`：

- `customer_login_challenges.delivery_id`
- `license_key_rotations.delivery_id`
- `billing_checkout_verifications.delivery_id`

## 4. 变量合同和取值

邮件 Contract 预定义在服务端代码中，不由管理员在数据库自由编辑。合同定义：

- `notification_type` 和版本；
- 每个变量的名称、类型、必填性、格式、长度/范围、是否敏感；
- 管理端测试使用的安全示例值。

以邀请码变量为例，如果合同中定义 `invitation_code`，业务代码在邀请事件发生时读取真实邀请码，并传给 `prepareEmailNotificationDelivery`：

```ts
await prepareEmailNotificationDelivery({
  accountId,
  customerId,
  notificationType: "customer.invitation_created",
  contractVersion: 1,
  recipientEmail,
  variables: { invitation_code: invitation.code },
});
```

该函数会补齐 `account_name` 公共变量，用事件当时声明的代码合同立即校验，然后把完整变量 JSON 加密写入 `email_deliveries.variables_ciphertext`。实际收件地址只保存在 `email_deliveries.recipient_email` 并作为 Provider 请求的 `to`。发送时解密，并按当前 Binding 指定的代码合同版本重新校验，再把变量传给当前 Provider 模板。

如果代码合同后来新增必填的第四个变量，而旧 Delivery 只有三个：

1. Dispatcher 解密旧变量并按当前合同校验；
2. 校验失败时不调用 Provider；
3. `status` 变为 `waiting_configuration`；
4. `attempt_count` 不增加；
5. `last_error_json` 保存具体合同错误和缺失变量信息。

旧 Delivery 不可能自动推导新增变量。要继续发送，必须由业务上可证明的来源补齐变量；如果没有可靠来源，就让它保持不可发送，而不是猜值。

## 5. 发送与重试

每次自动或人工发送都执行同一条路径：

1. 领取 Delivery 租约；
2. 检查变量是否过期；
3. 加载当前 active Integration，以及该 `notification_type` 唯一的当前 active Binding；
4. 解密并校验当前凭证、收件人和事件变量；
5. 使用当前 From、Reply-To、Template Ref 和变量构造 Provider 请求；
6. 在真正调用 Provider 前把 `attempt_count + 1`；
7. 保存本次最终状态和一份 `last_error_json`。

没有 `outbound_attempts`。处理问题需要的是 Delivery 当前状态、总尝试次数和最后一次完整诊断，不需要逐次请求历史。

### 5.1 自动重试

- Provider 明确拒绝且明确可重试，例如 429/部分 5xx：进入 `retry_scheduled`；
- Provider 明确认定凭证或模板配置错误：进入 `waiting_configuration`，等待管理员修复；
- 本地配置、凭证或合同校验失败：进入 `waiting_configuration`，不消耗 Provider 尝试次数；
- 业务发送期限到期：进入 `expired` 并清除密文；有效 processing 锁到期前不得被抢占；
- Provider 接受：进入 `accepted`，保存消息 ID，并从此时开始计算敏感变量清理期限；
- 管理员取消尚未发送的 Delivery：进入 `cancelled` 并立即清除密文。

### 5.2 结果未知

网络中断、超时或 2xx 响应缺少有效消息 ID 时，无法证明 Provider 是否已经接收请求：

- 状态进入 `failed`；
- 不自动重发；
- `last_error_json.possible_duplicate_on_resend = true`；
- 管理员人工重发前必须确认可能产生重复邮件；
- 确认后仍使用当前最新配置重发。

幂等键由 Delivery ID 和当前 Provider 请求摘要计算。同一请求的重试得到相同 key；配置、模板或变量变化后得到新 key，避免把不同请求错误地视为同一个 Provider 请求。

## 6. 配置测试

配置测试只属于配置页面的即时操作：

1. 管理员选择 Binding；
2. 输入测试收件邮箱；
3. 服务端使用相同 Provider Adapter、当前 Integration/Binding 和合同示例变量直接发送；
4. 页面立即显示 accepted 或原始脱敏错误；
5. 不创建 Delivery，不保存测试状态、时间、错误或消息 ID；
6. 测试成功后，管理员可以显式把该合同下 `waiting_configuration` 且变量仍有效的 Delivery 重新排队。

测试不是业务发送门禁。它帮助操作人闭环配置，但不能证明 Provider 远程模板之后不会变化。

## 7. Admin 页面与 API

保留：

- Email Integration 配置、凭证轮换、启用/禁用；
- 使用不落库的临时 Resend Full access Key，一次性创建、发布并绑定缺失的内置默认模板；成功绑定后不再读取、更新、删除或同步远程模板；
- Template Binding 配置、合同变量和参考模板；
- 即时发送测试；
- Email Delivery 列表、诊断和人工重发；
- 统一 System Issue 页面展示最近邮件错误，并允许标记待处理/已处理；同一错误再次出现会重新变为待处理。恢复动作仍回到配置或具体 Delivery。

删除：

- Binding revision、Integration revision；
- 测试 Delivery ID、accepted 时间和任何持久化测试状态；
- 业务 Webhook 页面/API；
- 通用 Outbound Delivery 页面/API；
- Attempt 列表。

## 8. 迁移边界

`0001_email_delivery_schema.sql` 尚未部署，因此直接以最终结构重写，不保留旧 0001 的兼容路径。迁移会：

1. 创建邮件专用表；
2. 重建四个业务表的 Delivery 外键；
3. 删除三个 Outbound 表；
4. 重建因表重建受影响的数据库触发器。

应用迁移前仍必须按常规流程确认目标 D1、备份和 migration 历史。本设计文档不表示已部署到任何环境。
