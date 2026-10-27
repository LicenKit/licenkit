# Client 统一授权校验与冷却策略设计

日期：2026-09-23

状态：历史设计，2026-10-27 归档。本文保留 2026-09-23 的方案与当时验证记录；设备随机令牌、验证中凭据和部分校验窗口规则已被后续实现替代，不能作为当前接入要求。

适用版本：2026-09-23 的 LicenKit Server V1 Client API 与 Swift SDK 设计快照。当前字段和行为以[API 参考](../../zh-CN/api-reference.md#7-client-api)及[统一校验指南](../../zh-CN/unified-client-validation-guide.md)为准；当前在线校验使用 Activation 或 Trial 编号与设备指纹，不生成额外的随机设备令牌。

适用范围：LicenKit Server 当前主线、`licenkit-sdk-swift` 下一破坏性版本，以及依赖 Client Validate 网络合同的 LicenKit CLI。本文的本地冷却和 `lastValidateResponseAt` 是 Swift SDK 宿主运行时合同；CLI 是显式命令工具，不因共享 Server 字段而自动继承该本地调度策略，当前每次显式执行 `licenkit validate` 都会联网。

## 1. 问题场景

当前 Swift SDK 把授权判断拆成多条公开调用路径：

- 正式 License 使用 `validate()` 在线校验；
- Product/设备 Trial 使用 `validateTrial()` 在线校验；
- 本地凭据使用 `checkLocalStatus()` 检查；
- 调用方还可能读取 `cachedStatus`，自行判断最近一次请求留下的状态。

这些接口返回不同对象，并通过“正常返回、抛出错误、修改缓存”三种方式表达结果。例如 Trial 到期时，`validateTrial()` 抛出 `TRIAL_EXPIRED`，同时把 `cachedStatus` 改成 `trialExpired`。宿主 App 必须理解 SDK 内部保存的是 License 还是 Trial，选择不同函数，再把错误与缓存拼成一个界面状态。

Server 也分别提供：

```text
POST /api/v1/client/validate
POST /api/v1/client/trials/validate
```

这使“判断当前用户能否使用产品”没有一个完整入口，也容易让宿主 App 把网络失败、业务失效和本地未请求混成同一种失败。

本设计将授权判断收敛为一个公开 `validate()`，同时保留原始错误诊断、签名凭据校验和 Server 业务状态的区别。

## 2. 已确认的产品决策

1. 允许 Swift SDK 与 Client Validate 协议进行破坏性升级，不保留旧公开接口或旧请求格式兼容层。
2. 所有公开操作使用同一种泛型结果包装器，但各操作保留自己的强类型业务数据。
3. 宿主 App 只调用一个 `validate()` 获取当前授权状态；SDK 内部决定校验 License、Trial，或查询尚未激活设备的 Trial 可用性。
4. “本次操作是否执行”和“当前授权是什么状态”是两个维度，不能放进同一个状态枚举。
5. `notPerformed` 表示本次没有发起请求，主要用于冷却期内的客户端流控；它不是授权状态。
6. 在线校验间隔默认 `3600` 秒，最小 `3600` 秒，最大 `86400` 秒。
7. Server 返回的 `validation_interval_seconds` 可以为 `null`；`null` 表示使用默认值 `3600` 秒。
8. Server 只返回 `validated_at` 与 `validation_interval_seconds`；`next_validation_at` 是可由前两者推导的值，不进入网络合同。
9. 冷却期结束不会自动触发请求。只有宿主代码主动调用 `validate()` 时，SDK 才判断本次是否需要联网。
10. SDK 不增加后台定时器、自动轮询、App 生命周期自动请求、冷却结束事件或失败自动重试。
11. Product 的在线复核间隔只决定客户端多久尝试联网；License Plan 的离线宽限期只决定何时进入强提示。超过两者都不会单独停止授权。
12. Signed License Token 没有独立 `exp`；Opaque 与 Signed 共享业务到期、在线复核和离线宽限规则。
13. 网络、DNS、TLS、超时、服务端故障、凭据错误和业务授权状态继续分开表达；统一接口不得丢弃原始错误码、请求 ID 或脱敏后的 details。
14. Product 保存必填 `validation_interval_seconds`，默认 3600 秒、范围 3600 至 86400 秒；Plan 保存 `offline_grace_seconds`，默认 30 天，并在签发时固化到 License。
15. 冷却只约束 `validate()`；`activate()`、`startTrial()` 和 `deactivate()` 不受冷却限制，也不写最近一次 `/validate` 响应时间。
16. 普通 `validate()` 同时受 Product 在线复核间隔和硬编码 30 秒门槛。只有 Signed Token 本地验证失败时绕过在线复核间隔，但仍受 30 秒门槛。
17. 两个门槛从最近一次明确 `/validate` Server 结果计算：合法业务成功或明确 HTTP 失败会推进；没有 HTTP 响应的失败和 2xx 非法业务正文不会推进。
18. HTTP 失败只推进 `/validate` 响应冷却，不推进 `validatedAt`，也不形成新的业务快照。
19. `offline_grace_seconds` 同时适用于 Opaque 与 Signed。超过后 SDK 返回 `offlineGraceExceeded`，但 `isUsable()` 仍为真；业务到期和凭据有效性是独立的硬边界。

## 3. 设计原则

### 3.1 三个独立维度

一次授权判断必须同时表达：

| 维度 | 回答的问题 | 示例 |
| --- | --- | --- |
| 操作结果 | 本次调用做了什么 | `success`、`notPerformed`、`failure` |
| 授权状态 | 当前能否使用产品 | Trial 可用、Trial 中、License 有效、License 到期 |
| 证据来源 | 这个结论来自哪里 | Server、本地签名、冷却期缓存 |

这三个维度不能互相替代：

- 网络失败不等于 License 到期；
- 冷却期没有发请求不等于校验失败；
- 本地存在缓存不等于缓存仍处于可用窗口；
- Server 成功确认 License 已吊销，属于“操作成功、授权不可用”。

### 3.2 统一包装器不等于统一业务数据

激活、校验、开始 Trial 和解绑需要的数据不同。设计统一结果容器，但不创建一个包含大量可选字段的万能响应对象。

目标 Swift 合同：

```swift
public enum LicenKitResult<Value: Sendable>: Sendable {
    case success(
        value: Value,
        metadata: OperationMetadata
    )

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

公开操作使用相同包装器：

```swift
func activate(...) async -> LicenKitResult<ActivationData>
func startTrial() async -> LicenKitResult<EntitlementSnapshot>
func validate() async -> LicenKitResult<EntitlementSnapshot>
func deactivate() async -> LicenKitResult<DeactivationData>
```

结果枚举保证调用方不能构造“既成功又失败”或“失败但没有错误”的无效组合。

`OperationMetadata` 至少保存：

```swift
public struct OperationMetadata: Sendable {
    public let source: StateSource
    public let requestID: String?
    public let validatedAt: Date?
    public let receivedValidationInterval: TimeInterval?
    public let effectiveValidationInterval: TimeInterval?
    public let lastValidateResponseAt: Date?
}
```

`requestID` 只在实际 Server 请求存在时返回；Server 原始 interval 与 SDK 规范化后的有效 interval 分开保存，诊断时不能只留下转换后的值。`hasFeature()`、`isUsable` 等只读查询不属于网络操作，不需要使用操作包装器，也不得隐式发起请求。

`StateSource` 还需要包含 `local`。它用于尚未取得 Server 或缓存结论的本地结果，例如 Keychain/设备指纹/编码失败，或无 License 凭据时解绑形成的本地 `activationRequired(.unknown)` 快照；不能把这类结果伪装成 `server`、`cache` 或 `signedLocal`。

## 4. 统一授权状态模型

### 4.1 顶层状态

```swift
public enum EntitlementState: Sendable {
    case activationRequired(trial: TrialAvailability)
    case trial(TrialEntitlement)
    case license(LicenseEntitlement)
    case licenseNotValidForVersion(
        code: String,
        updatesUntil: Date,
        releaseVersion: String,
        releasePlatform: String,
        releaseArch: String,
        releasedAt: Date
    )
    case unknown
}
```

状态含义：

- `activationRequired`：当前没有可用 License 或可认证的 Trial；同时携带是否可以开始 Trial；
- `trial`：当前设备已经领取 Trial，并有可认证的 Trial 状态；
- `license`：当前设备存在 Activation，并有可认证的 License 状态；
- `licenseNotValidForVersion`：Server 已找到当前 App Release，但永久 License 的有限期更新权益不包含该 Release；两个比较时间点是必填事实，未登记 Release 按宽容策略放行；
- `unknown`：没有足够证据形成当前授权结论，通常只用于尚未检查或本地数据无法可信解释的场景。

### 4.2 Trial 可用性

```swift
public enum TrialAvailability: Sendable {
    case available(duration: TimeInterval, features: [String])
    case unavailable(reason: TrialUnavailableReason)
    case unknown
}
```

没有本地凭据时，SDK 不能自行断言“可以开始 Trial”。Server 必须使用当前 `instance_id + product_id + fingerprint` 检查 Product 配置和设备领取历史。Trial 不查询 Product Release。

当客户端没有 Trial Token 时，Server 只返回是否可以领取，不返回已有 Trial ID、撤销原因或其他 Trial 历史细节。

第一版 `TrialUnavailableReason` 只包含：

- `notEnabled`（网络值 `not_enabled`）：Product 没有启用设备 Trial；
- `alreadyClaimed`（网络值 `already_claimed`）：当前 Product 与设备已经领取过 Trial。

Product 不存在、已归档或 Trial 配置损坏属于请求或服务配置失败，不伪装成正常的 Trial 不可用状态。`TrialAvailability.unknown` 只表示 SDK 尚无可信 Server 结论，不是 Server 返回的 unavailable reason。

### 4.3 Trial 状态

```swift
public enum TrialEntitlement: Sendable {
    case active(expiresAt: Date, features: [String])
    case expired(expiresAt: Date)
    case revoked(reason: String?)
}
```

### 4.4 License 状态

```swift
public enum LicenseEntitlement: Sendable {
    case active(terms: LicenseTerms, expiresAt: Date?)
    case expired(expiresAt: Date?)
    case suspended(reason: String?)
    case revoked(reason: String?)
    case activationRevoked
    case activationDeactivated
}
```

不增加笼统的 `licenseInvalid`：暂停、吊销、Activation 吊销、Activation 已解绑和 License 到期的恢复方式不同，必须保留区别。

### 4.5 Release 资格

以下情况不伪装成 License 到期：

- 永久 License 存在 `updates_until`，Server 找到完全匹配的 Product Release，且其发布时间超过更新权益截止：`UPDATE_ENTITLEMENT_REQUIRED`。

它进入 `licenseNotValidForVersion`，并保留原始 code、Release 版本、平台、架构、`updates_until` 与 `released_at` 等可安全返回的数据。两个时间点缺失属于协议错误，不能构造残缺状态。未登记 Product Release 不阻断，因为缺失的是服务端可选元数据，不是用户输入错误。

### 4.6 可用性计算

只有以下业务状态具备使用资格：

```text
trial.active
license.active
```

业务状态为 active 后，最终 `isUsable` 还必须检查：

1. 已知 Trial 或 License 业务到期时间尚未到达；
2. Signed License Token 本地验证通过；
3. 当前 Product、设备和 Release 与凭据一致。

在线复核间隔与离线宽限期不参与 `isUsable`。宿主不调用 `validate()` 时，SDK 不会联网；超过离线宽限期后 `freshness()` 返回 `offlineGraceExceeded` 供宿主强提示，但 `hasFeature()` 和 `isUsable()` 仍按业务状态、业务期限与签名有效性判断。

### 4.7 统一状态快照

宿主 App 不直接组合状态、缓存时间和凭据模式，而是使用一个快照：

```swift
public struct EntitlementSnapshot: Sendable {
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

public enum StateSource: Sendable {
    case server
    case cache
    case signedLocal
    case local
}

public enum EntitlementFreshness: Sendable {
    case fresh(until: Date)
    case validationRequired(since: Date?)
    case unknown
}
```

`freshness` 与本地可用截止时间都是派生值，不再持久化另一份 `nextValidationAt`。`lastValidateResponseAt` 是请求门槛的持久化起点，不能由 `validatedAt` 推测；`signedCredentialValid` 保存本轮本地签名验证结论。`signedLocal` 只表示当前 Signed License Token 在周期校验窗口内通过了本地密码学检查，不表示永久离线授权。

`businessCode` 与 `details` 保存 Server 在成功状态响应中返回的原始业务 code 和按字段脱敏后的安全详情。状态枚举负责让宿主方便分支，诊断字段负责保留原始信息；两者不能互相替代。没有 Server 业务终态时，这两个字段可以为空。

`ActivationData` 必须包含激活标识、凭据模式和激活后快照；`DeactivationData` 必须包含解绑完成事实和解绑后的本地快照。这样显式操作成功后，宿主不需要追加一次 `validate()` 才能更新界面。

快照到达已知 Trial/License 到期时间时可以在本地保守地停止授权；这属于使用 Server 已确认绝对时间进行的 fail-closed 判断，不代表本地替代了下一次 Server 校验。若服务端已经续期，宿主下一次主动调用 `validate()` 后才能取得新期限。

## 5. `validate()` 调用流程

### 5.1 本地选择

SDK 按固定优先级选择校验对象：

```text
正式 License 凭据
  ↓ 不存在
Trial 凭据
  ↓ 不存在
无凭据状态与 Trial 可用性
```

正常 License 激活成功后继续清除同设备的 Trial 凭据，避免两个授权主体同时存在。即使异常情况下两者都存在，也固定以正式 License 为优先，不让宿主选择。

### 5.2 被动冷却判断

冷却期只在宿主主动调用 `validate()` 时参与判断：

```text
宿主调用 validate()
  ├─ Signed Token 本地有效，且建议间隔或 30 秒门槛尚未结束
  │    ├─ 不发起网络请求
  │    └─ 返回 notPerformed(.cooldown) 与当前缓存快照
  ├─ Signed Token 本地验证失败，但 30 秒门槛尚未结束
  │    ├─ 不发起网络请求
  │    └─ 返回 notPerformed(.cooldown) 与当前缓存快照
  └─ 所有适用门槛均已结束
       ├─ 发起一次统一在线校验
       ├─ 合法业务成功：保存状态、validated_at、interval、offline grace 和 lastValidateResponseAt
       ├─ 明确 HTTP 失败：只保存 lastValidateResponseAt，返回原始错误与 lastKnownValue
       └─ 无 HTTP 响应或 2xx 非法正文：不更新时间，返回原始错误与 lastKnownValue
```

“冷却期结束”只表示下一次 `validate()` 允许发起请求，不创建任务、不发事件、不调用 Server。

### 5.3 并发调用

仅检查时间不足以避免重复请求。两个并发调用可能同时看到冷却已经结束，然后各自请求 Server。

SDK 内部需要一个串行 Validation Coordinator：

- 同一 Product 与设备在途校验只允许一个；
- 后续调用等待并复用同一个结果；
- in-flight 合并不等于失败重试；
- 请求完成后，根据结果是否为合法业务响应、明确 HTTP 失败或无明确 Server 结果，分别更新业务快照与请求冷却信息。

Swift 实现可以使用内部 `actor`，不引入第三方依赖。

只合并 `validate()` 仍不足以保护本地状态。`activate()`、`startTrial()` 和 `deactivate()` 也会修改同一组凭据与快照；如果旧的 `validate()` 响应在这些操作之后到达，不能重新写回已解绑或已被新激活替换的凭据。因此 SDK 需要同时满足：

- 并发 `validate()` 继续复用同一个 in-flight 结果；
- `validate()` 的状态提交与 `activate()`、`startTrial()`、`deactivate()` 经过同一个串行状态写入边界；
- 后发生的显式操作不能被先发生、后返回的旧校验响应覆盖。

该串行边界只保护 SDK 本地状态，不增加自动重试，也不改变 Server 的并发状态检查。

### 5.4 激活和开始 Trial

`activate()` 与 `startTrial()` 本身已经从 Server 得到当前有效状态。成功后应写入同一种 `EntitlementSnapshot` 和 `validated_at`，但不能写 `lastValidateResponseAt` 或启动 `/validate` 冷却。若宿主紧接着主动调用 `validate()`，SDK 允许请求；是否需要这次确认由宿主流程决定。

为避免 SDK 使用客户端时间猜测，两个成功响应都必须在各自强类型业务字段之外返回与统一校验相同的 `state`、`validation` 和 `meta.request_id`。`deactivate()` 成功响应返回远端解绑事实与 `meta.request_id`；解绑后的 `activationRequired(.unknown)` 快照由 SDK 在成功清理本地 License 凭据后构造。

激活、开始 Trial 和解绑属于用户明确触发的业务操作，不受 `validate()` 冷却限制。

## 6. 时间合同

### 6.1 Server 响应

周期校验响应只返回：

```json
{
  "validation": {
    "validation_interval_seconds": 3600,
    "offline_grace_seconds": 2592000,
    "validated_at": "2026-09-23T10:00:00Z"
  }
}
```

解释规则：

```text
validation_interval_seconds 3600...86400 -> 使用 Server 返回值
缺失或超出范围                              -> 协议错误
offline_grace_seconds 为正整数              -> License 离线宽限期
offline_grace_seconds 为 null               -> Trial 或无 License 状态不适用
```

Server 自身必须保证输出满足合同，SDK 不为旧的 nullable interval 或越界值提供兼容。除此之外，SDK 对 `validate()` 使用硬编码 30 秒最小请求门槛；该值不是 Server 字段。

### 6.2 删除 `next_validation_at`

在当前设计中：

```text
configuredValidateAfter = lastValidateResponseAt + effectiveInterval
hardValidateAfter = lastValidateResponseAt + 30 seconds
```

不存在额外 Server 调度规则，因此网络响应同时返回 interval 与 next time 会产生两个事实来源。Server 不返回 `next_validation_at`。

SDK 可以在内存中临时计算两个门槛供诊断使用，但持久化的源字段仍然是：

```text
validatedAt
effectiveInterval
offlineGracePeriod
lastValidateResponseAt
```

`validatedAt` 是业务状态被 Server 确认的时间；`lastValidateResponseAt` 是最近一次取得明确 `/validate` Server 结果的客户端时间。两者职责不同，不能互相替代。

### 6.3 有效窗口

缓存 active 状态的可用性不由在线复核间隔或离线宽限期截止。`freshness()` 依次表达 `fresh`、`offlineGrace` 与 `offlineGraceExceeded`；`isUsable()` 只检查业务状态、Trial/License 业务到期和 Signed 凭据有效性。

Signed License Token 不包含 `exp`。本地验证失败时，下一次主动 `validate()` 绕过 Product 在线复核间隔，只保留 30 秒请求门槛；超过离线宽限期但验签仍有效时不绕过可用性判断，只要求宿主显示强提示。

Client API 中 License 的 `expires_at` 表示客户端实际可以使用授权的有效截止时间。对 `renewal_mode=billing` 的订阅，它等于数据库账期 `expires_at + payment_grace_seconds`；其他模式保持数据库原值或 `null`。在线状态、激活响应与 Signed License Token 的 `lexp` 必须使用同一有效截止时间，避免客户端在服务端认可的支付宽限期开始时提前停权。

### 6.4 时钟异常

`validated_at` 使用 Server 时间。`lastValidateResponseAt` 使用客户端收到明确 Server 结果的时间。若客户端时钟回拨到早于已保存的门槛基准，计算出的经过时间为负值，SDK 继续返回 `notPerformed(.cooldown)`，不允许通过回拨时钟绕过 30 秒硬门槛。

## 7. 统一 Server 校验接口

### 7.1 路径

继续使用现有路径，替换其请求与响应合同：

```text
POST /api/v1/client/validate
```

删除独立的：

```text
POST /api/v1/client/trials/validate
```

### 7.2 严格凭据联合类型

共同字段：

```json
{
  "instance_id": "3Jd9K_aP0qUwbL6F7sTn2Q",
  "product_id": "prd_01...",
  "fingerprint": "sha256:...",
  "release_version": "2.4.0",
  "release_platform": "macos",
  "release_arch": "universal",
  "credential": {}
}
```

License：

```json
{
  "credential": {
    "kind": "license",
    "activation_id": "act_01...",
    "machine_token": "mtk_..."
  }
}
```

Trial：

```json
{
  "credential": {
    "kind": "trial",
    "trial_id": "trl_01...",
    "trial_token": "ttk_..."
  }
}
```

无凭据：

```json
{
  "credential": {
    "kind": "none"
  }
}
```

Server 使用严格 discriminated union 校验请求，不允许混合 License 与 Trial 字段，也不通过字段是否存在进行模糊猜测。

只有 `kind=license` 且目标 License 为永久授权并存在 `updates_until` 时，Server 才查询 Product Release。未注册时继续放行；`kind=trial` 与 `kind=none` 不查询 Release，直接按各自凭据或 Trial 可用性规则处理。

### 7.3 成功响应

在线请求完成并成功查明当前业务状态时，响应使用 `success: true`。授权不可用不等于请求失败。

示例：Trial 已到期。

```json
{
  "success": true,
  "data": {
    "state": {
      "kind": "trial",
      "status": "expired",
      "code": "TRIAL_EXPIRED",
      "expires_at": "2026-09-23T09:00:00Z"
    },
    "validation": {
      "validation_interval_seconds": 3600,
      "offline_grace_seconds": null,
      "validated_at": "2026-09-23T10:00:00Z"
    },
    "meta": {
      "request_id": "req_01..."
    }
  }
}
```

示例：License 有效。

```json
{
  "success": true,
  "data": {
    "state": {
      "kind": "license",
      "status": "active",
      "expires_at": null,
      "terms": {
        "max_activations": 3,
        "features": ["pro_export"],
        "updates_until": "2027-09-19T10:00:00Z"
      }
    },
    "credential_update": {
      "credential_mode": "signed",
      "signed_license_token": "base64url.base64url.base64url",
      "signing_key_id": "key_01..."
    },
    "validation": {
      "validation_interval_seconds": 86400,
      "offline_grace_seconds": 2592000,
      "validated_at": "2026-09-23T10:00:00Z"
    },
    "meta": {
      "request_id": "req_01..."
    }
  }
}
```

`credential_update` 只供 SDK 更新 Keychain，不作为宿主 UI 状态。响应与日志继续按字段脱敏 Token，不隐藏整个错误或状态数据。

### 7.4 业务状态与失败边界

已认证并成功查明的业务状态进入成功响应：

| 当前服务端事实 | 统一状态 |
| --- | --- |
| Trial 有效 | `trial.active` |
| `TRIAL_EXPIRED` | `trial.expired` |
| `TRIAL_REVOKED` | `trial.revoked` |
| License 有效 | `license.active` |
| `LICENSE_EXPIRED` | `license.expired` |
| `LICENSE_SUSPENDED` | `license.suspended` |
| `LICENSE_REVOKED` | `license.revoked` |
| `ACTIVATION_REVOKED` | `license.activationRevoked` |
| `ACTIVATION_DEACTIVATED` | `license.activationDeactivated` |
| `UPDATE_ENTITLEMENT_REQUIRED` | `licenseNotValidForVersion` |

以下情况仍然是失败，不伪装成授权状态：

- 无效或不匹配的 Machine Token、Trial Token、设备指纹；
- 请求结构和协议错误；
- Keychain 读写或解码错误；
- DNS、TLS、网络和超时；
- HTTP 5xx、数据库错误和服务端配置错误；
- 无法安全认证目标 Activation 或 Trial Claim；
- 并发状态变化导致本次结果不能成立。

Server 只把明确列出的业务错误转换成状态，不能用通用 `catch` 把未知错误归一化。转换后的状态继续携带原始业务 code 和必要的非敏感 details，便于定位与回溯。

### 7.5 凭据校验顺序

Server 必须先验证调用方持有的 Machine Token 或 Trial Token 及设备指纹，再返回对应资源的详细状态。不能因为调用方只知道 Activation ID 或 Trial ID，就暴露吊销原因、到期时间或其他业务事实。

无凭据请求只返回最小 Trial 可用性，不返回历史 Claim 标识或管理信息。

同一隐私边界也适用于 `POST /api/v1/client/trials/claim`：相同 Product、设备指纹和 Trial Token 的重复或并发请求必须重复下发同一份 Trial 凭据；相同指纹但 Token 不匹配时返回 `TRIAL_CREDENTIALS_INVALID`，且不得返回既有 `trial_id`。数据库原始错误只能进入脱敏后的服务端诊断来源，不能放进公开 details。

## 8. SDK 持久化与状态更新

SDK 需要按 Product 与设备保存：

- License 或 Trial 凭据；
- 最近一次成功状态快照；
- Server `validated_at`；
- 规范化后的有效校验间隔；
- Server 原始间隔值，供诊断；
- 对应的业务到期时间、在线复核间隔和离线强提示宽限期；Signed Token 没有独立 `exp`。
- 最近一次取得明确 `/validate` Server 结果的 `lastValidateResponseAt`。

只有以下操作可以推进 `validated_at`：

- 统一在线 `validate()` 成功并得到可信状态；
- `activate()` 成功；
- `startTrial()` 成功。

只有以下 `/validate` 结果可以推进 `lastValidateResponseAt`：

- HTTP 2xx 且得到合法、完整的业务数据；
- 已收到明确 HTTP 状态的失败响应，包括 4xx 和 5xx。

以下情况不得推进 `lastValidateResponseAt`：

- DNS、TLS、网络中断、超时等没有 HTTP 响应的失败；
- HTTP 2xx 但 Envelope 或业务数据不符合合同；
- 请求未执行；
- 只完成本地签名检查；
- 只读取缓存状态。

`activate()`、`startTrial()` 和 `deactivate()` 即使收到明确 HTTP 响应，也不能推进 `lastValidateResponseAt`。只有 `validate()` 的明确 HTTP 失败可以推进请求冷却，但永远不能推进 `validated_at` 或替换最近成功业务快照。

在线失败时返回：

```swift
.failure(
    error: originalError,
    lastKnownValue: previousSnapshot,
    metadata: ...
)
```

`lastKnownValue` 只用于解释最近事实和界面诊断，不自动获得新的有效窗口。

## 9. 宿主 App 界面合同

SDK 仍然不包含 SwiftUI/AppKit 授权界面。宿主只需要根据统一状态映射界面：

| 授权状态 | 建议界面行为 |
| --- | --- |
| `activationRequired + trial.available` | 显示开始 Trial 与输入 License Key |
| `activationRequired + trial.unavailable` | 显示激活或购买入口 |
| `trial.active` | 进入产品，展示剩余 Trial 时间 |
| `trial.expired/revoked` | 停止 Trial 权益，显示激活或购买入口 |
| `license.active` | 进入产品并按 features 开放能力 |
| `license.expired/suspended/revoked` | 停止授权能力并显示准确原因 |
| `licenseNotValidForVersion` | 显示当前 License 不包含当前版本，并由宿主决定后续操作 |
| 操作 `notPerformed(.cooldown)` | 不显示网络加载，不改变现有界面 |
| 操作 `failure` | 显示可诊断的校验失败；不得伪装成到期或吊销 |

## 10. 不在本次范围内

- 永久离线授权或不再校验的 `localTrusted` 模式；
- 后台定时器、自动轮询和 App 生命周期自动校验；
- 自动重试、指数退避、Retry-After 调度或熔断器；
- SDK 内置激活、购买、Trial 到期界面；
- 因校验间隔新增 Product/License 数据库字段或管理端配置；
- 引入设备私钥证明、平台证明或其他硬件级设备绑定架构；
- 把客户端冷却当成服务端防滥用机制。修改后的客户端仍可绕过本地间隔，Server/WAF 继续承担独立流量保护。

激活与 Trial 领取都必须先把客户端生成的高熵 Token 写为“验证中凭据”，再发送网络请求。服务端以 Token Hash、资源范围和设备指纹识别同一次领取：相同 Token 的重复或并发请求重复下发同一份正式凭据，不创建第二份资源；不同 Token 不能取得既有凭据。SDK 仅在正式凭据和快照全部落盘后删除验证中凭据。响应丢失、进程退出或正式落盘失败后，宿主分别显式重试 `activate()` 或 `startTrial()`；`validate()` 不替用户执行这两个业务动作。Activation 验证中凭据只保存 Machine Token，不保存 Registration Key 明文或 Hash；重试使用用户本次输入的 Registration Key，由 Server 判断授权目标。

Machine Token 与 Trial Token 属于 bearer credential。V1 的安全边界是：另一设备只知道 Registration Key 或设备指纹时，不能取得既有凭据；客户端 Token 使用 256 位 CSPRNG，传输依赖 TLS，Apple SDK 使用 `ThisDeviceOnly` Keychain，Server 仅保存 Hash 并进行常量时间比较。设备指纹只用于资源范围绑定，不是密码学设备证明。如果攻击者已经从失陷客户端导出 Token 并能伪造设备指纹，V1 不能阻止重放；覆盖该威胁需要另行设计设备私钥签名或平台证明，不应以 Registration Key Hash 或更严格的本地分支伪装成已经解决。

## 11. 兼容性与受影响组件

### 11.1 Swift SDK

- 替换现有 `validate() async throws -> LicenseStatus`；
- 删除公开 `validateTrial()` 与 `checkLocalStatus()`，相应能力进入统一 `validate()` 内部；
- 删除公开 `clearLocalTrial()`；清除本地 Token 后不能重新取得服务端已经领取的 Trial，把它作为普通产品操作会让用户永久失去尚未结束的 Trial；
- 用统一泛型结果包装激活、Trial、校验和解绑；
- 以统一快照替代只表达最后写入值的 `cachedStatus`；
- `hasFeature()` 必须检查状态新鲜度，不能无限使用旧缓存；
- 增加并发校验合并和持久化冷却信息。

### 11.2 Server

- 替换现有 `/api/v1/client/validate` 请求与响应；
- 删除 `/api/v1/client/trials/validate`；
- 增加无凭据 Trial 可用性判断；
- 把明确的授权业务终态转换成成功状态响应；
- 成功响应增加 request ID、校验时间、Product 在线复核间隔与 License 离线宽限期；
- 保留现有错误 Envelope 和字段级脱敏边界。

### 11.3 CLI

CLI 已同步使用联合请求和状态响应。它不需要实现 Swift SDK 的内存协调器，但遵循相同的业务状态、错误保存、签名验证和 Activation 验证中凭据合同。

CLI 的 `validate` 退出语义固定为：

- `license.active`：退出码 `0`；
- Server 已成功确认但当前不可用的业务状态：退出码 `2`，并输出准确状态、业务 code 与 request ID；
- 网络、协议、凭据认证、Server 或本地存储失败：退出码 `1`。

业务终态虽然使用 HTTP 成功响应，CLI 也不能输出“License validated”并返回 `0`。CLI 本地验证超过 Product 在线复核间隔或 Plan 离线宽限期时只提示应联网，不因此返回不可用；业务到期或验签失败仍按不可用处理。

## 12. 验收矩阵

### 12.1 SDK

1. 无凭据、Trial 可用/禁用/已领取分别返回正确状态；
2. License 凭据优先于异常残留的 Trial 凭据；
3. Trial active/expired/revoked 映射正确；
4. License active/expired/suspended/revoked 与 Activation revoked/deactivated 映射正确；
5. Release unknown 与 update entitlement required 不映射成 License 到期；
6. Product interval 必填且限制在 3600 至 86400 秒，Plan offline grace 正确进入 License 快照；
7. Opaque、Trial、无凭据与有效 Signed 同时受建议间隔和 30 秒门槛；门槛内返回 `notPerformed(.cooldown)`，网络请求数为零；
8. Signed Token 本地验证失败时只绕过建议间隔，30 秒内仍不发请求；
9. 冷却结束但宿主没有调用时，网络请求数仍为零；
10. 冷却结束后的第一次 `validate()` 只发起一个请求；
11. 多个并发 `validate()` 只产生一个 Server 请求并共享结果；
12. 在途 `validate()` 与 `activate()`、`startTrial()` 或 `deactivate()` 交错时，旧响应不能覆盖后发生操作写入的凭据和快照；
13. 合法业务响应与明确 HTTP 失败推进 `lastValidateResponseAt`；无 HTTP 响应与 2xx 非法正文不推进；任何失败都不推进 `validated_at`；
14. 业务期限到达或 Signed 凭据无效时不继续报告可用；
15. `hasFeature()` 不发起网络请求，并在 `offlineGraceExceeded` 时仍按活动授权返回功能；
16. 激活成功清除 Trial 凭据并初始化新的快照，但不启动 `/validate` 冷却；
17. `activate()`、`startTrial()` 和 `deactivate()` 不受 `/validate` 冷却限制；
18. 永久 License 仍会在下一次宿主调用且所有适用门槛结束时在线校验。

### 12.2 Server

1. 三种 credential kind 使用严格且互斥的请求 Schema；
2. 凭据认证在详细状态返回之前完成；
3. 所有列出的业务终态使用 `success: true` 返回，并保留原始 code；
4. 未列出的异常继续通过错误 Envelope 返回；
5. 无凭据请求不泄露 Trial Claim 标识和历史详情；
6. 所有成功状态响应包含 Server `validated_at`、必填 Product interval 和适用的 License offline grace；
7. 成功响应不包含 `next_validation_at`；
8. Signed Token Payload 不包含 `exp`，响应也没有独立 Signed Token 到期字段；
9. Server/WAF 流量保护不依赖 SDK 冷却；
10. License、Trial 与 Release 状态在并发变化时不会返回已经失效的 active 快照；
11. 相同指纹和相同 Trial Token 的重复或并发领取返回既有 Trial ID；不同 Token 拒绝恢复；
12. Client API 返回的订阅有效截止时间、Signed Token `lexp` 与支付宽限期一致。

### 12.3 文档与集成

1. 更新 Swift SDK README、API Reference、Architecture 与 Changelog；
2. 更新 Server 中文 API Reference 和内部业务流程；
3. 更新 CLI 类型和 Validate 命令；
4. 宿主 App 只通过统一 `validate()` 驱动授权状态，不再组合多个旧接口；
5. 文档明确冷却是被动判断，不声称存在自动校验。

## 13. 实施顺序

本设计涉及公开协议，按以下顺序实施：

1. 先完成 Server 统一状态模型、严格请求 Schema、成功/失败边界和合同测试；
2. 同步更新 CLI，确保 Server 主仓内没有旧 `/validate` 消费者；
3. 实现 Swift SDK 统一包装器、状态模型、持久化快照与并发协调器；
4. 用 Server 合同样例完成 SDK 端到端契约测试；
5. 更新宿主 App 的状态与界面映射；
6. 最后更新长期用户文档，并分别验证本地实现、远端部署和真实 App 行为。

文档完成不代表 Server、SDK、CLI、宿主 App 或生产部署已经完成。实现状态、测试状态、远端部署状态与真实界面验收必须分别报告。

## 14. 宿主 App 标准调用规范

本节定义客户集成下一破坏性版本 Swift SDK 时的标准方式。示例描述目标 API，不代表当前已发布 SDK 已经具备这些接口。

### 14.1 集成结构

每个宿主 App 应建立一个应用级授权控制器，作为 SDK 调用与界面状态的唯一入口：

```text
SwiftUI/AppKit 界面
        ↓ 读取状态、发出用户动作
LicenseController（宿主 App 单一事实源）
        ↓
LicenKit SDK
        ↓ SDK 判断冷却、本地凭据和是否需要请求
LicenKit Server
```

要求：

1. App 启动时只配置一次 `LicenKit`；
2. 只有应用级控制器调用 `validate()`、`activate()`、`startTrial()` 和 `deactivate()`；
3. 普通 View、菜单项和业务模块只读取控制器发布的 `EntitlementSnapshot`；
4. 不允许多个页面分别维护一份授权布尔值或自行解释 SDK 错误；
5. 不把 `isPro`、`trialExpired` 等派生结果持久化为第二份事实；
6. App 重启后重新从 SDK 持久化凭据和快照恢复，不依赖上次 UI 状态。

SwiftUI 宿主可以使用一个 `@MainActor ObservableObject`；AppKit 宿主可以使用等价的应用级 Store。这个控制器属于宿主 App，不进入 SDK UI 层。

### 14.2 标准调用场景

| 用户或应用场景 | 宿主应调用 | 是否可能联网 | 标准处理 |
| --- | --- | --- | --- |
| App 完成 SDK 配置后的首次启动 | `validate()` 一次 | 是；冷却内也可能直接跳过 | 用结果建立首个界面快照 |
| App 再次进入前台 | 可以调用 `validate()` 一次 | 由 SDK 冷却判断 | 主动刷新意图，但不自行判断时间或启动轮询 |
| View 重绘、窗口切换、菜单展开 | 不调用网络操作 | 否 | 只读取当前快照 |
| 用户点击已授权功能，快照 fresh | 不调用 `validate()` | 否 | 使用 `isUsable/hasFeature` 直接判断 |
| 用户点击已授权功能，快照要求校验 | `validate()` | 是 | 等待结果后重新判断，不先放行 |
| 用户明确点击“开始试用” | `startTrial()` | 是 | 操作返回新快照，但不启动 validate 冷却；是否立即 validate 由宿主流程决定 |
| 用户输入 License Key 并点击激活 | `activate()` | 是 | 成功后直接使用激活结果中的快照 |
| Paddle 免费订阅试用获得 License Key | `activate()` | 是 | 作为普通 License 激活，不调用 `startTrial()` |
| 用户明确点击“解绑此设备” | `deactivate()` | 是 | 只有远端确认后切换到未激活状态 |
| 校验失败后用户点击“重试” | `validate()` | 是 | 发起一次新尝试，不由 SDK 自动重试 |
| 网络恢复 | 宿主可在明确的恢复流程中调用 `validate()` | 由冷却与状态判断 | SDK 自身不监听网络并自动请求 |
| App 保持运行但冷却时间结束 | 不自动调用 | 否 | 直到宿主下一次主动调用 validate |
| 后台定时器、周期轮询 | 不调用 | 否 | 本方案禁止 SDK/宿主用轮询模拟自动校验 |

“再次进入前台可以调用”表示客户代码可以把前台事件作为明确调用点；它不表示 SDK 注册 App 生命周期监听，也不要求每次前台都发生网络请求。

### 14.3 首次启动

标准流程：

```swift
LicenKit.configure(with: configuration)

Task {
    await licenseController.validateForLaunch()
}
```

控制器只调用一次统一 `validate()`：

- 本地有 License：SDK 校验 License；
- 本地没有 License 但有 Trial：SDK 校验 Trial；
- 两者都没有：Server 返回 Trial 可用性；
- 冷却期内：返回 `notPerformed(.cooldown)` 与缓存快照；
- 无法联网且没有可信当前快照：返回 failure，不猜测 Trial 可用或 License 状态。

启动界面可以在结果返回前显示一次授权检查状态，但不能把网络失败显示成“License 已过期”。

### 14.4 首次安装与 Trial

首次安装不能自动调用 `startTrial()`。Trial Claim 是同一 Product 与设备只能领取一次的不可逆业务动作，必须由用户明确点击。

正确流程：

```text
启动后 validate()
  ↓
activationRequired(trial: available)
  ↓
显示“开始试用”和“输入 License Key”
  ↓ 用户点击开始试用
startTrial()
```

错误做法：

- App 第一次启动就自动领取；
- 仅为了展示 Trial 天数就调用 `startTrial()`；
- `TRIAL_ALREADY_CLAIMED` 后清除本地记录并再次领取；
- 把 Paddle 免费订阅试用当成 Product/设备 Trial。

`startTrial()` 成功结果已经包含新的 active Trial 快照，不需要靠第二次请求证明领取成功；但它不会写 `lastValidateResponseAt` 或启动 `/validate` 冷却。若宿主流程明确需要立即取得统一校验结果，可以主动调用 `validate()`，SDK 不会因为刚完成 Trial 领取而跳过。

### 14.5 License 激活

只有用户提交 License Key 时调用：

```swift
let result = await LicenKit.shared.activate(
    licenseKey: userInput,
    machineName: machineName
)
```

标准处理：

- 按钮在请求期间进入 busy，避免重复提交；
- 成功后使用 `ActivationData` 中的快照更新控制器；
- SDK 保存 Activation/Machine Token，并清除同设备 Trial 凭据；
- 宿主不长期保存 License Key，也不写入日志或分析事件；
- 失败时保留原始错误 code、request ID 和安全 details；
- `UPDATE_ENTITLEMENT_REQUIRED`、激活数已满和无效注册码显示不同原因。

激活成功后不需要追加调用 `validate()`。

### 14.6 App 启动与进入前台

推荐调用策略：

- 冷启动：调用一次 `validate()`；
- 进入前台：客户可以调用一次 `validate()`；
- 同一次前台激活产生多个系统通知时，由宿主控制器合并为一次意图，SDK 同时保证 in-flight 请求合并；
- 不设置一小时 Timer；间隔由 SDK 在调用发生时判断。

进入前台时不建议立即显示全局加载遮罩。大多数调用会在冷却期内返回 `notPerformed(.cooldown)`；只有当前界面确实不能在未知状态下工作时，才显示阻断式检查界面。

### 14.7 功能权限判断

业务功能不应该每次点击都先调用 `validate()`。标准顺序是：

```text
读取当前 EntitlementSnapshot
  ├─ fresh 且 hasFeature == true
  │    → 直接执行功能
  ├─ validationRequired / unknown
  │    → 调用 validate()，得到结果后重新判断
  └─ 已确认无授权或没有该 feature
       → 显示激活、购买或权限说明
```

示例：

```swift
func performProExport() async {
    if licenseController.snapshot?.hasFeature("pro_export") == true {
        await export()
        return
    }

    if let snapshot = licenseController.snapshot,
       case .validationRequired = snapshot.freshness() {
        await licenseController.validateForProtectedAction()
    }

    guard licenseController.snapshot?.hasFeature("pro_export") == true else {
        presentLicenseUI()
        return
    }

    await export()
}
```

实际 Swift 枚举匹配应按最终 API 编译合同实现；示例强调的是调用顺序，不要求提供无关联值的 `==` 简写。

### 14.8 `validate()` 结果处理

应用级控制器使用统一分支：

```swift
switch await LicenKit.shared.validate() {
case .success(let snapshot, let metadata):
    self.snapshot = snapshot
    self.lastError = nil
    recordSuccessfulCheck(metadata)

case .notPerformed(.cooldown, let cached, let metadata):
    if let cached {
        self.snapshot = cached
    }
    self.lastError = nil
    recordSkippedCheck(metadata)

case .failure(let error, let lastKnown, let metadata):
    self.lastError = error
    self.lastKnownSnapshot = lastKnown
    recordFailedCheck(error, metadata)
}
```

目标行为：

- `success`：Server 或本地合同成功形成当前快照；授权可能有效，也可能已经到期/吊销；
- `notPerformed(.cooldown)`：正常流控结果，不显示错误，不再次请求；
- `failure`：本次无法形成新的可信 Server 结论，不改变成到期、吊销或有效；
- `lastKnownValue`：用于解释上一次状态和展示诊断，不自动获得新的使用期限。

宿主不能只判断“operation success”就放行功能，必须继续检查返回快照的 `state`、`freshness` 和 feature。

### 14.9 Trial 到期

Trial 在已知 `expiresAt` 到达后，本地立即停止 Trial 权益，不等待后台事件，因为不存在后台事件。

标准流程：

```text
状态/功能读取发现 Trial 已到期
  ↓
停止 Trial feature，显示激活或购买入口
  ↓
宿主下一次主动调用 validate()
  ↓
Server 返回 trial.expired 或更新后的可信状态
```

本地到期判断是 fail-closed，不会延长 Trial；网络失败也不能继续使用已经到期的 Trial。

### 14.10 License 到期、暂停、吊销与 Activation 失效

这些状态都是一次成功状态解析的结果，不使用通用失败界面：

| 状态 | 宿主处理 |
| --- | --- |
| `license.expired` | 停止权益，提供续费/重新购买入口 |
| `license.suspended` | 停止权益，展示可安全返回的原因与支持入口 |
| `license.revoked` | 停止权益，展示吊销状态，不自动清除诊断信息 |
| `license.activationRevoked` | 停止当前设备权益，提供重新激活或设备管理入口 |
| `license.activationDeactivated` | 清理不再有效的本地 Activation，进入激活界面 |
| `licenseNotValidForVersion` | 说明当前 App Release 不在 License 更新权益内，不说成 License 到期 |

永久 License 也按相同规则调用 `validate()`。它的 `expiresAt` 可以为空，但冷却窗口结束后，宿主下一次主动调用仍会进行在线校验。

### 14.11 网络与 Server 失败

遇到 DNS、TLS、超时、断网或 HTTP 失败时：

1. 不映射成 Trial/License 到期、吊销或无效；
2. 不自动重试；
3. 不推进 `validatedAt`；
4. 不扩大上一次快照的使用窗口；
5. 向用户提供明确重试入口，或在下一次宿主生命周期调用点重新调用；
6. 记录错误类别、服务端 code、request ID 和脱敏 details；
7. 不记录 License Key、Machine Token、Trial Token、Authorization 或完整设备指纹。

若旧快照仍在适用门槛内，正常 `validate()` 应在请求前就返回 `notPerformed(.cooldown)`，不会进入网络失败分支。实际发出请求后失败，SDK 仍不会取得新的业务快照或推进 `validatedAt`；宿主不得自行给旧状态增加宽限时间。

失败是否推进请求冷却取决于有没有明确 Server 结果：HTTP 4xx/5xx 会写 `lastValidateResponseAt`，下一次 `validate()` 重新遵守适用门槛；DNS、TLS、超时和断网没有 HTTP 响应，不写该时间；2xx 但正文不合法也不写。无论哪种失败，SDK 都不会自动重试。

### 14.12 解绑

解绑只能由用户明确触发：

```swift
let result = await LicenKit.shared.deactivate()
```

处理规则：

- 远端确认成功后，SDK 清理本地 License 凭据并返回完成结果；
- 网络或 Server 失败时保留本地 Machine Token，便于用户重试释放远端席位；
- 宿主不能在失败时自行清除 Keychain 并显示“解绑成功”；
- 解绑成功后直接使用 `DeactivationData` 表达的新本地状态，不紧接着自动调用 `validate()`。

### 14.13 禁止的调用模式

客户集成不得：

- 每次 View render、按钮 hover、菜单展开都调用 `validate()`；
- 用 Timer 每隔固定时间调用 SDK；
- 首次启动自动领取 Trial；
- 在 `notPerformed(.cooldown)` 后立即强制再次请求；
- 在 `activate()` 或 `startTrial()` 成功后追加一次 `validate()`；
- 捕获所有错误并统一显示“License 无效”；
- 因断网而清除本地凭据；
- 根据 UI 缓存的布尔值绕过快照新鲜度检查；
- 绕过 SDK 直接调用 Server Client API 或读取 SDK Keychain 数据；
- 把客户端冷却当成防攻击措施；修改后的客户端仍可能直接请求 Server。

### 14.14 最小集成示例

目标宿主控制器示例：

```swift
import SwiftUI

@MainActor
final class LicenseController: ObservableObject {
    @Published private(set) var snapshot: EntitlementSnapshot?
    @Published private(set) var lastError: LicenKitError?
    @Published private(set) var isPerformingUserAction = false

    func validateForLaunch() async {
        apply(await LicenKit.shared.validate())
    }

    func validateForForeground() async {
        apply(await LicenKit.shared.validate())
    }

    func startTrial() async {
        isPerformingUserAction = true
        defer { isPerformingUserAction = false }
        apply(await LicenKit.shared.startTrial())
    }

    func activate(licenseKey: String) async {
        isPerformingUserAction = true
        defer { isPerformingUserAction = false }

        switch await LicenKit.shared.activate(licenseKey: licenseKey) {
        case .success(let activation, _):
            snapshot = activation.snapshot
            lastError = nil
        case .notPerformed:
            assertionFailure("Explicit activation must not be skipped by validation cooldown")
        case .failure(let error, _, _):
            lastError = error
        }
    }

    private func apply(_ result: LicenKitResult<EntitlementSnapshot>) {
        switch result {
        case .success(let value, _):
            snapshot = value
            lastError = nil
        case .notPerformed(_, let cachedValue, _):
            if let cachedValue { snapshot = cachedValue }
            lastError = nil
        case .failure(let error, _, _):
            lastError = error
        }
    }
}
```

示例只展示调用所有权和结果处理。对外开发指南已使用实现后的准确类型名与关联值，并对完整控制器示例做了 Swift 类型检查。

## 15. 实现与验证记录

本设计已在两个仓库实现：

- `licenkit`：Server 统一 Client Validate 合同、Product 在线复核间隔、Plan/License 离线宽限期、激活与 Trial 的客户端凭据绑定和安全重复下发，以及不含 `exp` 的 Signed Token 合同；通过增量 D1 migration 更新既有数据库；
- `licenkit-sdk-swift`：统一公开结果类型、授权快照、仅针对 `validate()` 的双门槛被动冷却、并发请求合并、状态写入串行化、Signed Token 与 Server 状态一致性校验，以及请求前持久化的激活/Trial 验证中凭据；不兼容旧凭据合同。

当前本地证据：

- Server、CLI 和 Admin 全仓类型检查通过；
- Server 235 项、CLI 18 项、Admin 46 项自动化测试通过；
- 全仓构建与 Wrangler `deploy --dry-run` 通过；
- 新建 SQLite/D1 Schema 的加载、外键检查和完整性检查通过；既有数据库需要按顺序执行增量迁移 `0004_client_validation_policy.sql`，当前未对远端执行；
- Swift SDK 39 项合同测试通过；
- 离线 Signed License Token 的签名、硬件绑定、篡改检测和旧 Account 范围 Claim 拒绝检查通过。

这些证据只证明当前工作树中的源码、模拟 HTTP 合同、构建和全新 Schema 加载成立，不等于生产已完成。后续发布必须把 Server 与破坏性升级的 Swift SDK 同步交付，并分别完成：

1. Worker/Server 部署和真实 Client API 端到端验证；
2. Swift SDK 破坏性版本发布与宿主依赖升级；
3. 真实 macOS 宿主 App 中的 Keychain、前后台生命周期、授权界面和失败恢复验收。
