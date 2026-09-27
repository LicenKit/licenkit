# Swift SDK 集成

## 1. 这套 SDK 解决什么问题

Swift SDK 把 License、无需支付方式的设备 Trial，以及“当前设备还没有凭据”统一成一个授权快照。宿主 App 不需要根据不同接口拼装状态，只需要处理：

- 操作有没有执行成功；
- 当前授权是什么业务状态；
- 这份状态是否仍在可信时间窗口内；
- 失败时上一次已知状态是什么，以及如何用 `requestID` 回溯服务端请求。

SDK 不决定商业权益，不自行延长 License，也不会把网络失败改写为“已到期”“已吊销”或“仍然有效”。本文描述仓库中的本地实现；它不代表对应版本已经发布到 Swift Package Registry，也不代表服务端代码已经部署到生产环境。

完整接入步骤见[统一客户端校验开发指南](./unified-client-validation-guide.md)，HTTP 字段见 [API 参考](./api-reference.md#7-client-api)。

## 2. 配置

```swift
let configuration = LicenKitConfiguration(
    serverURL: URL(string: "https://license.example.com")!,
    productID: "prd_01...",
    signingPublicKey: "base64-encoded-ed25519-public-key"
)

LicenKit.configure(with: configuration)
```

- `productID` 来自 Admin 产品页；它全局唯一，Server 据此解析所属 Instance。
- SDK 从宿主 App 的 `CFBundleShortVersionString` 读取 Release 版本，将操作系统标识为 `macos`，并从主可执行文件单独推导 `arm64`、`x86_64` 或 `universal` 架构。
- `opaque` 模式可以省略 `signingPublicKey`。
- `signed` 模式必须内置 Admin 产品页交付的 Ed25519 公钥。运行时从授权服务下载的公钥不能自动成为信任根。
- 请求超时固定为 SDK 内部 15 秒；Keychain 使用当前 App 私有命名空间，不需要 Helper、多 Target 或 Access Group 配置。

## 3. 最小调用路径

```swift
let initial = await LicenKit.shared.validate()

let activation = await LicenKit.shared.activate(
    licenseKey: userEnteredLicenseKey,
    machineName: Host.current().localizedName
)

let trial = await LicenKit.shared.startTrial()
let deactivation = await LicenKit.shared.deactivate()
```

这些 Facade 方法不抛出网络或业务错误，而是返回 `LicenKitResult<Value>`：

```swift
public enum LicenKitResult<Value: Sendable>: Sendable {
    case success(value: Value, metadata: OperationMetadata)
    case notPerformed(
        reason: NotPerformedReason,
        cachedValue: Value?,
        metadata: OperationMetadata
    )
    case failure(
        error: LicenKitError,
        lastKnownValue: Value?,
        metadata: OperationMetadata
    )
}
```

典型处理方式：

```swift
switch await LicenKit.shared.validate() {
case .success(let snapshot, let metadata):
    render(snapshot)
    diagnostics.requestID = metadata.requestID

case .notPerformed(.cooldown, let cached, _):
    if let cached { render(cached) }

case .failure(let error, let lastKnown, let metadata):
    showConnectionOrConfigurationError(error)
    if let lastKnown { renderAsLastKnown(lastKnown) }
    diagnostics.requestID = metadata.requestID ?? error.requestID
}
```

`failure.lastKnownValue` 只是上一次已知事实，不是本次校验成功。宿主 App 是否展示它与能否继续使用功能，应分别判断。

## 4. 授权快照

`EntitlementSnapshot` 是界面与功能门禁的统一输入：

```swift
public struct EntitlementSnapshot: Codable, Equatable, Sendable {
    public let state: EntitlementState
    public let source: StateSource
    public let validatedAt: Date?
    public let receivedValidationInterval: TimeInterval?
    public let effectiveValidationInterval: TimeInterval?
    public let signedLicenseTokenExpiresAt: Date?
    public let lastValidateResponseAt: Date?
    public let signedCredentialValid: Bool?
    public let businessCode: String?
    public let details: [String: String]

    public func freshness(at now: Date = Date()) -> EntitlementFreshness
    public func isUsable(at now: Date = Date()) -> Bool
    public func hasFeature(_ feature: String, at now: Date = Date()) -> Bool
}
```

`state` 的顶层分支为：

```swift
public enum EntitlementState: Codable, Equatable, Sendable {
    case activationRequired(trial: TrialAvailability)
    case trial(TrialEntitlement)
    case license(LicenseEntitlement)
    case releaseNotEligible(ReleaseEligibilityIssue)
    case unknown
}
```

只有 `trial.active` 与 `license.active` 有可能可用；它们还必须通过 `freshness(at:)`。终态包括 Trial 到期/吊销、License 到期/暂停/吊销、Activation 撤销/解绑，以及更新权益不足。终态是服务端已确认的业务结果，不应当显示为“网络错误”；Product 不存在或已归档则仍通过失败结果保留服务端原始错误。

`businessCode` 保存 `TRIAL_EXPIRED`、`LICENSE_SUSPENDED`、`UPDATE_ENTITLEMENT_REQUIRED` 等原始业务码；`details` 保存按敏感字段脱敏后的服务端细节。不要只根据面向用户的文案做逻辑分支。

`lastValidateResponseAt` 是最近一次明确 `/validate` Server 结果的客户端接收时间；`signedCredentialValid` 记录本轮本地 Signed Token 验证结论。它们用于请求门槛和安全判断，不替代 `validatedAt`。

## 5. 状态来源与时间窗口

```swift
public enum StateSource: String, Codable, Equatable, Sendable {
    case server
    case cache
    case signedLocal
    case local
}
```

- `.server`：本次操作取得服务端响应。
- `.cache`：`validate()` 处于冷却窗口，复用近期服务端快照。
- `.signedLocal`：冷却窗口内复用快照，并重新验证了本地 Signed License Token。
- `.local`：没有发生服务端确认，例如无 License 凭据时调用 `deactivate()` 后生成的本地“需要激活”状态。

服务端返回 `validated_at` 与可空的 `validation_interval_seconds`。SDK 在后者为 `nil` 时使用 3600 秒，并把非空值限制在 3600 至 86400 秒之间。`validatedAt` 表示最近一次合法业务状态何时由 Server 确认；它不是最近一次 `/validate` 响应时间，也不能用于代替请求冷却记录。业务可用截止时间取以下时间的最早值：

1. `validatedAt + effectiveValidationInterval`；
2. License 或 Trial 的业务到期时间；
3. Signed License Token 的 `exp`。

因此，本地可用窗口不会延长业务授权或 Signed Token。`isUsable(at:)` 只在业务状态为 active 且当前时间仍早于该最早截止时间时返回 `true`。

## 6. `validate()`：一个入口、三种凭据

SDK 从 Keychain 选择凭据：优先 License，其次 Trial，否则使用 `none`，然后统一调用 `POST /api/v1/client/validate`。

- License：提交 `activation_id + machine_token`，并原子接收可选 `credential_update`。
- Trial：提交 `trial_id + trial_token`。
- None：不提交秘密，只查询此设备是否还能领取 Trial；Product Release 是否登记不影响该结果。

并发调用 `validate()` 会共享同一个 Task，避免同一时刻发出重复请求。`activate()`、`startTrial()`、`deactivate()` 与所有凭据/快照写入使用同一顺序化边界，避免较早的校验响应覆盖较新的激活或解绑结果。

冷却只约束 `validate()`，不约束 `activate()`、`startTrial()` 或 `deactivate()`。后三个显式操作也不会写入最近 `/validate` 响应时间；因此激活或领取 Trial 成功后，宿主若立即主动调用 `validate()`，SDK 仍允许这次请求。

`validate()` 的普通路径必须同时越过两个门槛：Server 建议的有效间隔，以及硬编码 30 秒。Opaque、Trial、无凭据和 Signed Token 仍然有效的 License 都遵守这两个门槛。只有 Signed Token 已过期或本地验证失败时，SDK 才绕过 Server 建议间隔，但仍遵守 30 秒门槛。

两个门槛都从最近一次明确 `/validate` Server 结果计算：

- 合法 2xx 业务响应会更新最近响应时间，并更新业务快照和 `validatedAt`；
- 明确 HTTP 失败会更新最近响应时间，但不会推进 `validatedAt` 或替换业务快照；
- DNS、TLS、超时、断网等没有 HTTP 响应的失败不更新时间；
- HTTP 2xx 但正文不能解码为合法业务数据时也不更新时间。

命中任一门槛时，`validate()` 返回 `.notPerformed(reason: .cooldown, cachedValue: ...)`。这不是错误，也不是新的服务端确认。SDK 不会在门槛结束时自动创建任务或联网。

## 7. 激活和 Signed License Token

`activate()` 成功返回：

```swift
public struct ActivationData: Equatable, Sendable {
    public let activationID: String
    public let credentialMode: CredentialMode
    public let snapshot: EntitlementSnapshot
}
```

两种凭证模式都保存 `activationID + machineToken`，区别是：

- `opaque`：没有可离线验签的授权载荷，签名相关字段必须为 `nil`。
- `signed`：同时返回 Signed License Token、`signingKeyID` 与外层到期时间；SDK 在保存前完成验签和 Claim 一致性检查。

Signed Token 必须满足：Header 为 `alg=EdDSA`、`typ=licenkit-license+jwt` 且 `kid` 受信；`ins/prd/act/fp/ver/plt/arc` 与当前配置、Activation 和设备一致；外层 `signed_license_token_expires_at` 与签名内绝对 `exp` 一致；活动 License 的功能、更新期限和最终有效期与签名 Claims 一致。Token 不携带 Product Release ID 或发布时间，SDK 不在本地重复执行 Release 发布时间与更新期限的业务比对。

Plan 的 `signed_token_ttl_seconds` 可以短于 3600 秒。它只用于服务端计算绝对 `exp`：实际到期时间是“签发时间 + License 快照 TTL”与 License 最终有效截止时间（如有）中的较早值，后者在 billing 模式下已包含支付宽限。原始 TTL 数值不进入 Token。Token 早于建议校验间隔到期不属于协议冲突：下一次宿主主动调用 `validate()` 时，SDK 绕过建议间隔并只检查 30 秒门槛。

激活成功后不长期保存 Registration Key，并清除同一设备上的 Trial 凭据。

## 8. Product/设备 Trial

`startTrial()` 调用 `POST /api/v1/client/trials/claim`。首次成功返回的 Trial Token 只写入 Keychain；服务端只保存 Token Hash。正常 License 激活后，SDK 清除 Trial 凭据。

重复领取返回 `TRIAL_ALREADY_CLAIMED` API 错误，不会返回历史 Trial ID，也不会延长试用。后续不再调用独立的 `trials/validate`，而是由统一 `validate()` 自动选择 `credential.kind=trial`。

Paddle 免费订阅试用是普通支付型 License：用户获得 Registration Key 后调用 `activate()`，不调用 `startTrial()`。SDK 不根据 Paddle 前端状态自行推断授权。

## 9. 主动解绑

```swift
public struct DeactivationData: Equatable, Sendable {
    public let wasDeactivated: Bool
    public let snapshot: EntitlementSnapshot
}
```

- 有 License 凭据时，只有服务端确认 Activation 已 `deactivated` 后才清除本地 License 凭据，并返回 `wasDeactivated=true`。
- 网络或服务端失败时返回 `.failure`，保留本地 Machine Token，使用户可以重试并真正释放远端席位。
- 本地没有 License 凭据时不发请求，返回 `wasDeactivated=false`，并生成 `source=.local`、Trial 可用性为 `.unknown` 的 `activationRequired` 快照。它不含伪造的 `validatedAt`。

## 10. 错误与诊断

`LicenKitError` 区分：未激活/未开始 Trial、API 业务错误、网络/DNS/TLS/超时/5xx、缺少受信签名密钥、Signed Token 无效、Keychain、设备指纹和协议错误。

```swift
case apiError(
    statusCode: Int,
    code: String,
    message: String,
    requestID: String?,
    details: [String: String]
)

case transportError(
    kind: TransportErrorKind,
    underlyingDescription: String
)
```

HTTP 5xx 属于 `transportError(.server(...))`，但仍保留安全的服务端 `code`、`requestID` 与 `details`；4xx 业务拒绝通过 `apiError` 原样到达宿主 App。脱敏按字段递归处理 Token、Secret、密码、注册码和 Authorization，不隐藏整个响应。

操作成功或服务端业务状态的 Request ID 位于 `OperationMetadata.requestID`；失败时还可从 `LicenKitError.requestID` 读取。记录诊断信息时不要记录 Registration Key、Machine Token、Trial Token 或 Signed License Token。

## 11. 本地凭据边界

Keychain 分别保存 License 凭据、Trial 凭据与授权快照：

- License：Activation ID、Machine Token、凭证模式、可选 Signed Token/key ID/到期时间；
- Trial：Trial ID、Trial Token；
- Snapshot：凭据主体、统一状态、服务端业务时间、收到/生效间隔、签名 Token 到期、业务码和安全细节；另保存最近一次取得明确 `/validate` Server 结果的时间，用于请求冷却。

`currentSnapshot` 是当前进程内最近加载或写入的快照。宿主 App 应在启动路径调用一次 `validate()`，让 SDK 从 Keychain 读取持久化状态并决定复用缓存还是联网；不要假设刚完成 `configure` 后该属性已经完成磁盘恢复。

## 12. 联调验收边界

仓库内构建和单元测试只能证明本地实现。正式接入还需要在目标环境验证：

- 无凭据设备能得到 Trial 可用/不可用或 Release 不合格状态；
- `opaque` 与 `signed` 激活、校验和 Token 刷新；
- 任意正数 Signed Token TTL 都只投影成绝对 `exp`，且外层到期时间与 `exp` 一致；
- Opaque、Trial、无凭据和有效 Signed 同时受到建议间隔与 30 秒门槛，过期/无效 Signed 只绕过建议间隔；
- 合法 `/validate` 业务响应与明确 HTTP 失败推进最近响应时间；无 HTTP 响应和 2xx 非法正文不推进；HTTP 失败不推进 `validatedAt`；
- 激活、领取 Trial 和解绑既不受 `/validate` 冷却，也不启动该冷却；
- License/Trial 到期、暂停、吊销、Activation 失效与 Release 不合格；
- 支付宽限期已经体现在 `expires_at`，客户端没有重复叠加；
- `request_id` 能关联实际 Worker 日志；
- 解绑失败保留凭据，解绑成功确实释放远端席位；
- 签名并发布后的宿主 App 能正常读取 Keychain。

只有发布的 SDK 版本、已部署的 Server 版本与真实环境联调都通过，才能视为完成生产闭环。
