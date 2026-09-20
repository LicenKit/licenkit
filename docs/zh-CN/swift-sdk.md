# Swift SDK 集成

## 1. 目标

Swift SDK 为 macOS App 提供统一的在线激活和在线校验接口，同时准确表达不透明凭证与签名凭证的能力差异。

SDK 不决定商业权益，不自行延长 License，也不把网络失败转换成服务端确认有效。

本文只定义安装到被授权 App 内的 License SDK。产品网站直接使用 Paddle.js，不提供 LicenKit Web Checkout SDK；静态产品页边界见[静态产品页与 Paddle Checkout](./static-product-page.md)。浏览器 Checkout 回调不能替代 License API 或支付 Webhook。

## 2. 配置

公钥不再是初始化的必填参数。建议目标配置：

```swift
public struct LicenKitConfiguration: Sendable {
    public let serverURL: URL
    public let accountID: String
    public let productID: String
    public let releaseVersion: String
    public let releasePlatform: String
    public let trustedSigningKeys: [String: String]
    public let timeoutInterval: TimeInterval
    public let accessGroup: String?
}
```

- `opaque` 模式可以使用空 `trustedSigningKeys`；
- `signed` 模式必须能按服务端返回的 `signing_key_id` 找到受信公钥；
- 收到 `signed` 响应但缺少对应公钥时，激活失败并返回配置错误；
- 公钥应内置在 App 或通过受信发布链更新；运行时从同一个授权服务临时下载的公钥不能自动成为信任根；
- `releaseVersion` 和 `releasePlatform` 是构建常量，由应用发布流程注入；服务端用两者查找 Product Release，不接受客户端传入发布时间；
- 生产构建应把这两个值固化在只读构建配置中，普通运行时设置不得覆盖。

使用 key ID 到公钥的映射，是为了支持签名密钥轮换期间同时验证新旧未过期 Token。

## 3. 本地凭据

Keychain 保存：

- `activationID`；
- `machineToken`；
- `credentialMode`；
- 可选 `signedLicenseToken`；
- 最近一次在线验证时间；
- 最近一次服务端返回的非敏感授权摘要。

如果用户使用无需支付方式的 Product/设备试用，SDK 另存一组互斥的 `trialID`、`trialToken` 和 `trialExpiresAt`。Trial Token 与 Machine Token 一样只放入 Keychain，不写入日志、偏好设置或分析事件。正常 License 激活成功并持久化后，SDK 清除本地 Trial Claim 凭证。Paddle 免费订阅试用得到的是普通 License Key，不保存这组 Trial Claim 凭证。

默认不在激活完成后长期保存注册码，也不自动把注册码同步到 iCloud Keychain。换机或丢失时走注册码找回流程，生成新注册码。

## 4. 激活

```swift
let result = try await LicenKit.shared.activate(
    licenseKey: "LK-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX"
)
```

SDK 按服务端 `credential_mode` 分支。该字段不决定是否发起在线请求；两种模式都通过同一个在线激活接口。

SDK 自动在激活和在线校验请求中携带配置中的版本标识与平台。服务端返回 `PRODUCT_RELEASE_UNKNOWN` 或 `UPDATE_ENTITLEMENT_REQUIRED` 时，SDK 必须保留为独立状态，不能显示成 License 已过期。

### 4.1 `opaque`

1. 要求 `activation_id` 和 `machine_token`；
2. 不要求 `signed_license_token`；
3. 不执行 Ed25519 验签；
4. 将在线凭据写入 Keychain；
5. 返回服务端校验成功状态。

### 4.2 `signed`

1. 要求 `activation_id`、`machine_token`、`signed_license_token` 和 `signing_key_id`；
2. 使用内置受信公钥立即验证 Token；
3. 验证账户、产品、License、Activation、设备指纹、签发时间和到期时间；
4. 验证 Token 中的 Release 版本和平台与当前构建完全一致，并使用签名保护的 `released_at` 判定更新权益；
5. 只有验证成功后才保存凭据并返回成功。

`signed` 不替代 Machine Token，而是在与 `opaque` 相同的在线凭证之外增加 Signed License Token。这解决当前 SDK 无条件要求签名授权令牌和公钥、从而无法使用纯机器令牌凭证的问题。

## 5. 无需支付方式的 Product/设备试用

V1 无需支付方式的试用使用独立在线接口：

```swift
let status = try await LicenKit.shared.startTrial()
let refreshed = try await LicenKit.shared.validateTrial()
```

`startTrial()` 自动提交配置中的 Account、Product、Release 版本与平台，以及当前设备指纹。首次成功后把 `trialID` 和只返回一次的 `trialToken` 写入 Keychain。`TRIAL_ALREADY_CLAIMED` 不能自动改为重新领取，也不能仅凭本地指纹恢复丢失的 Token。

`validateTrial()` 每次都向服务端提交 Trial ID、Token、同一设备指纹和当前 Release。V1 不为试用签发 Signed License Token，因此试用没有 `.validLocally`：无网络时返回传输错误或 `.onlineValidationRequired`，不能把缓存的未到期时间当作服务端确认有效。

要求支付方式的 Paddle 免费订阅试用不调用 `startTrial()` 或 `validateTrial()`。客户从 Paddle Checkout 获得正常 License Key 后调用 `activate()`；SDK 只看到 `license_expires_at` 和普通 License Terms，不自行判断 Paddle 的 `trialing` 状态。试用转为付费周期时继续使用同一 Activation 和 License，下一次在线校验获得更新后的到期时间。

## 6. 本地检查

建议统一接口：

```swift
public func checkLocalStatus() async throws -> LicenseStatus
```

### 6.1 `signed` 凭证模式

SDK 可以在无网络时验证：

- Ed25519 签名；
- key ID 是否受信；
- Token 账户和产品；
- Activation 与设备指纹；
- Token 有效期；
- License 到期时间；
- `updates_until` 与 Token 中签名保护的 Product Release `released_at`；
- Token 中的 Release 版本、平台与当前构建是否一致；
- 功能列表。

通过后可以返回 `.validLocally`。

### 6.2 `opaque` 凭证模式

机器令牌不携带签名权益，因此 SDK 不能返回“已离线验签”。本地只能返回：

- 最近一次在线确认仍在宿主应用允许的短缓存窗口内；或
- `.onlineValidationRequired`；或
- `.temporarilyUnverified(lastValidatedAt:)`。

是否允许短时间继续使用属于宿主 App 的可用性选择，不是密码学授权事实。SDK 必须在状态名称中保留这个差异。

## 7. 在线验证

```swift
public func validate() async throws -> LicenseStatus
```

请求携带：

- account ID；
- product ID；
- activation ID；
- machine token；
- 当前设备指纹；
- App 发布版本与发布工件平台；
- 独立的设备平台诊断值。

服务端明确拒绝时，SDK返回对应业务状态或原始 API 错误。网络、DNS、TLS 和服务端 5xx 属于传输失败，不得转换为 `revoked` 或 `expired`。

`signed` 模式在线校验成功时可以刷新 Signed License Token；`opaque` 模式只刷新服务端状态和最后校验时间。

## 8. 状态模型

目标状态至少包含：

```swift
public enum LicenseStatus: Sendable, Equatable {
    case unactivated
    case validOnline(terms: LicenseTerms)
    case trialValidOnline(expiresAt: Date, features: [String])
    case validLocally(claims: LicenseClaims)
    case temporarilyUnverified(lastValidatedAt: Date, cachedTerms: LicenseTerms?)
    case onlineValidationRequired
    case suspended(reason: String?)
    case expired(expiresAt: Date?)
    case productReleaseUnknown(version: String, platform: String)
    case updateEntitlementRequired(updatesUntil: Date, releaseVersion: String, releasedAt: Date)
    case revoked(reason: String?)
    case activationRevoked
    case trialExpired(expiresAt: Date)
    case trialRevoked(reason: String?)
    case untrusted(reason: String)
}
```

宿主应用可以自行决定 `temporarilyUnverified` 时的界面和功能，但 SDK 的 `isUsable` 不应在没有明确配置的情况下默认把它等同于有效授权。

## 9. 解绑

客户端解绑包含两个结果：

- 远端 Activation 已进入 `deactivated`；
- 本地凭据已清理。

只有远端成功后才能把操作报告为完整成功。网络失败时不能静默吞掉并清理全部本地凭据，否则服务端仍占用席位而用户无法再次提交有效解绑请求。

推荐接口返回明确结果：

```swift
public enum DeactivationResult {
    case completed
    case remoteFailed(localCredentialsPreserved: Bool, underlying: LicenKitError)
}
```

## 10. 错误合同

错误类型应保留原始信息：

```swift
case apiError(code: String, message: String, requestID: String?, details: [String: String])
case transportError(kind: TransportErrorKind, underlyingDescription: String)
case missingTrustedSigningKey(keyID: String)
case invalidSignedLicenseToken(reason: String)
case credentialStorageError(operation: String, status: OSStatus)
```

不得把所有非 2xx 响应都归一化为 `invalidLicense`，也不得在需要脱敏时丢弃 request ID、错误码和状态链路。服务端返回 `LICENSE_CHECKOUT_VERIFICATION_ONLY` 时，SDK 必须作为独立 API 错误透传；它表示收到的是管理员闭环测试注册码，不是已过期、已吊销或格式错误的客户 License。

## 11. Token Claims

Signed License Token 不嵌入注册码。建议 Claims：

```json
{
  "lic": "lic_01...",
  "act": "act_01...",
  "acc": "acc_01...",
  "prd": "prd_01...",
  "rel": "rel_01...",
  "ver": "2.4.0",
  "plt": "macos-arm64",
  "rat": 1789783200,
  "fp": "sha256:...",
  "iat": 1789783200,
  "exp": 1792375200,
  "lexp": null,
  "upd": 1821319200,
  "fea": ["pro_export"]
}
```

- `exp`：Signed License Token 自身到期时间；
- `lexp`：License 到期时间，可为空表示买断；
- `upd`：永久 License 可使用版本的最晚发布时间，可为空表示不限制未来版本；
- `rel`、`ver`、`plt`、`rat`：服务端受信 Product Release 的 ID、版本、平台和发布时间；SDK 要求版本与平台匹配当前构建，并比较 `rat <= upd`；
- `lexp` 非空时，`exp` 不得晚于 `lexp`；
- `act` 将 Token 绑定到具体 Activation；
- `kid` 放在 Token Header，由 SDK 选择公钥。

Token 使用紧凑 JWS，Header 必须同时满足 `alg=EdDSA`、专用 `typ=licenkit-license+jwt` 和已知 `kid`。SDK 不从 Token 自己声明的算法选择验证器，不接受 `none`、其他算法、未知关键 Header 或重复 Claim；Payload 解析和签名验证成功后才解释授权字段。

密钥标记为 revoked 只能阻止服务端继续签发和在线刷新。已完全离线的客户端无法即时获知撤销，仍可能在旧 Token 的 `exp` 前接受旧签名；缩短该风险窗口依赖合理 Token TTL，或随可信 App 更新发布撤销后的信任根。文档和 UI 不能宣称服务端撤销会瞬间影响离线设备。

## 12. 集成验收

SDK 对齐完成需要同时证明：

- 无公钥配置可以完成 `opaque` 模式激活和校验；
- `signed` 响应缺少受信公钥时明确失败；
- 两种模式共享同一激活 API，但本地状态语义不同；
- 受限更新的永久 License 可以继续使用截止时间前发布的版本，并拒绝截止时间后的构建；
- 客户端伪造 `released_at` 不会改变资格；未知版本或平台由服务端拒绝；
- `opaque` 模式断网时不宣称完成离线验签；
- 解绑网络失败不会静默遗留远端席位；
- 服务端原始错误码和 request ID 能到达宿主 App；
- 管理员 Checkout Verification 注册码被服务端以 `LICENSE_CHECKOUT_VERIFICATION_ONLY` 拒绝，SDK 不把它缓存成有效凭证；
- Swift 单元测试覆盖两种模式、密钥轮换和错误分支。
- 无需支付方式的 Product/设备试用只能领取一次，Trial Token 只进 Keychain；在线校验覆盖成功、重复领取、错误 Token、设备不匹配、到期、吊销和未知 Release，断网时不宣称试用有效；Paddle 免费订阅试用使用普通 License 激活与校验，不创建 Trial Token。
