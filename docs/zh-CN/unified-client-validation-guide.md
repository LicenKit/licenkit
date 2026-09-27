# 统一授权校验开发指南

本文面向把 LicenKit 接入 macOS App 的开发者，也供维护 Server 与 CLI 的开发者核对调用边界。目标是让宿主 App 只回答一个问题：用户此刻能否使用当前产品和功能；至于本地保存的是正式 License、设备 Trial，还是还没有凭据，由 SDK 处理。

## 1. 先理解一次校验返回的内容

`validate()` 的结果包含两个互不替代的层次：

1. **本次操作结果**：这次调用成功取得了可信结论、因为冷却期而没有发请求，还是执行失败。
2. **当前授权快照**：用户处于未激活、Trial、正式 License、当前版本不受支持等哪一种状态。

这一区分会直接影响界面行为：

- `success` 只表示校验过程成功完成；其中的授权状态仍可能是到期、暂停、吊销或当前版本不受支持。
- `notPerformed(.cooldown)` 是正常的客户端流控结果，不是错误。SDK 返回当前缓存快照；它是否还能放行功能，仍以 `isUsable()` 为准。
- `failure` 表示本次没有形成新的可信结论。断网、DNS、TLS、超时、服务端故障或凭据认证失败都不能改写成“License 已到期”。

授权快照还会给出证据来源和新鲜度。只有 Trial 或 License 为 active，并且快照仍然 fresh，`isUsable()` 才会返回 `true`。功能开关还要继续通过 `hasFeature()` 检查。

## 2. Server、SDK 与宿主 App 的职责

### LicenKit Server

Server 是授权业务事实的来源，负责：

- 认证 Machine Token 或 Trial Token，并核对设备、Instance、Product 与 Release；
- 返回 Trial、License 与 Release 资格的准确业务状态；
- 把已认证且已查明的到期、暂停、吊销等终态作为成功响应返回；
- 返回服务端校验时间和校验间隔；
- 保留原始业务错误码、`request_id` 与经过必要脱敏的 `details`。

Client API 返回的 License `expires_at` 是已经计入订阅 payment grace 的有效授权截止时间。宿主 App 不需要、也不应该再次计算宽限期。

### LicenKit Swift SDK

SDK 是客户端授权事实的唯一入口，负责：

- 按“正式 License、Trial、无凭据”的顺序选择校验对象；
- 将 Server 响应转换为 `EntitlementSnapshot`；
- 把 Machine Token、Trial Token 与签名凭据保存在 Keychain；
- 使用 Server 校验间隔和固定 30 秒请求冷却，共同判断本次 `validate()` 是否联网；
- 合并同一 Product 和设备上的并发校验请求；
- 校验 Signed License Token，并把业务期限、签名期限和在线校验窗口中的最早边界作为本地可用截止；
- 在错误中保留诊断信息，不把传输失败转换成业务状态。

SDK 不包含 SwiftUI/AppKit 授权界面，不启动后台定时器，不在冷却结束时自动联网，也不自动重试失败请求。

### 宿主 App

宿主 App 负责：

- 在启动时配置一次 SDK；
- 通过一个应用级授权控制器调用 SDK；
- 在明确的生命周期或用户动作发生时主动调用；
- 把授权快照映射成界面和功能开关；
- 为失败提供可理解的提示与明确重试入口；
- 记录可诊断字段，同时保护注册码和 Token。

普通 View、菜单和业务模块只读取授权控制器持有的快照，不应直接调用 Client API、读取 SDK Keychain，或各自保存一份 `isPro`。

## 3. 接入前准备

先在 Xcode 的 **File > Add Package Dependencies** 中添加：

```text
https://github.com/LicenKit/licenkit-sdk-swift.git
```

把 `LicenKit` library 加入 App target，并确认 `Package.resolved` 实际解析到包含本文统一授权 API 的发行版本。不能只看 `Package.swift` 中声明了依赖；还要在一次干净构建中确认宿主代码实际编译了本文使用的类型和方法。

在写宿主代码前，先确认 Server 已存在以下数据：

- App 对应的 Product ID；
- 若使用 `signed` 凭据，Admin 产品页交付的 Ed25519 公钥；
- 若提供设备 Trial，Product 已启用 Trial 并配置时长与功能列表。

只有产品采用“永久可用、有限期免费更新”，且已签发 License 存在 `updates_until` 时，才建议登记对应 Product Release 的发布时间。未登记不会阻断用户；登记后，Server 才能在查到完全匹配的版本、操作系统和架构时执行发布时间比对。

Release 版本、操作系统和架构是构建身份，不是用户偏好设置。SDK 从宿主 App Bundle 的 `CFBundleShortVersionString` 读取版本，将平台标识为 `macos`，并从主可执行文件推导独立的 `arm64 | x86_64 | universal` 架构。

配置示例：

```swift
import Foundation
import LicenKit

let configuration = LicenKitConfiguration(
    serverURL: URL(string: "https://license.example.com")!,
    productID: "prd_01...",
    signingPublicKey: "<Ed25519 public key>"
)

LicenKit.configure(with: configuration)
```

`opaque` 产品可以省略 `signingPublicKey`。`signed` 产品必须内置 Admin 交付的公钥；SDK 仍检查 Server 返回的 `signing_key_id` 与 Token Header 的 `kid` 一致。运行时从同一个授权服务下载的公钥不能自动成为信任根。

### `signed_token_ttl_seconds` 如何变成 Token 到期时间

`signed_token_ttl_seconds` 是 Server 签发 Signed License Token 时使用的配置输入，不会以原值写入 Token。Server 先用签发时间加上该秒数得到候选截止时间；如果 License 的有效授权截止更早，则取更早的时间，最后把这个绝对时间写入受 Ed25519 签名保护的 `exp` Claim。

Server 响应中的 `signed_license_token_expires_at` 是便于解析的明文字段。SDK 不单独信任它，而是验签后要求它与 Token 内受签名保护的 `exp` 完全一致；不一致属于协议错误。宿主 App 不应读取 `signed_token_ttl_seconds` 自行推算 Token 期限，也不应只根据明文 expires 字段放行授权。

## 4. 标准调用时机

| 场景 | 宿主调用 | 处理方式 |
| --- | --- | --- |
| SDK 配置后的冷启动 | `validate()` 一次 | 用结果建立首个界面快照 |
| App 再次进入前台 | 可以调用 `validate()` 一次 | SDK 决定返回缓存还是联网 |
| View 重绘、菜单展开、窗口切换 | 不调用网络操作 | 只读取当前快照 |
| 用户使用受保护功能 | 先读 `freshness()` 与 `hasFeature()` | 只有需要新证据时才调用 `validate()` |
| 用户点击“开始试用” | `startTrial()` | 成功结果已经包含新快照 |
| 用户提交注册码 | `activate()` | 成功结果已经包含新快照 |
| 用户点击“解绑此设备” | `deactivate()` | 只有远端确认后才视为成功 |
| 用户在失败界面点击重试 | `validate()` | SDK 按两个冷却判断是否发起新请求 |

冷却结束只表示下一次 `validate()` 可以联网。若宿主没有调用，SDK 不会创建任务、发事件或自动请求。不要用每小时 Timer、View 生命周期或按钮 hover 模拟自动校验。

### `validate()` 的两个冷却

冷却只约束 `validate()`。`activate()`、`startTrial()` 和 `deactivate()` 是用户明确触发的操作，既不受这两个门槛限制，也不写入 `lastValidateResponseAt`。

`activate()` 和 `startTrial()` 的成功快照仍可携带 Server `validatedAt`，因为 Server 确实在该操作中确认了授权业务状态；这个时间不是 `validate()` 请求冷却的起算点。

SDK 在 `validate()` 中同时使用：

- Server 返回的 `validation_interval_seconds`：控制常规在线复核频率；
- 固定 30 秒请求冷却：防止失败界面、生命周期通知或重复点击在短时间内持续请求 Server。

两者都从最近一次 `validate()` 得到明确 Server 结果的时间 `lastValidateResponseAt` 开始计算。对 opaque License、Trial、无凭据查询和仍然有效的 signed License，两个窗口都结束后才允许再次联网。若 Signed License Token 已过期或本地验证失败，SDK 会绕过 `validation_interval_seconds` 窗口，以便尽快向 Server 重新取得可信凭据；固定 30 秒冷却仍然生效。

| 当前情况 | `validation_interval_seconds` 窗口 | 固定 30 秒窗口 | 本次 `validate()` |
| --- | --- | --- | --- |
| opaque、Trial、无凭据或有效 signed | 尚未结束 | 任意 | 返回 `notPerformed(.cooldown)` |
| opaque、Trial、无凭据或有效 signed | 已结束 | 尚未结束 | 返回 `notPerformed(.cooldown)` |
| opaque、Trial、无凭据或有效 signed | 已结束 | 已结束 | 发起一次 Server 请求 |
| signed Token 无效或过期 | 直接绕过 | 尚未结束 | 返回 `notPerformed(.cooldown)` |
| signed Token 无效或过期 | 直接绕过 | 已结束 | 发起一次 Server 请求 |
| 从未得到过明确的 validate Server 结果 | 没有起算点 | 没有起算点 | 发起一次 Server 请求 |

冷却只决定“现在是否再次发请求”，不会延长授权证据。特别是 Signed Token 已失效但固定 30 秒尚未结束时，`notPerformed(.cooldown)` 不会把旧快照恢复成可用，宿主仍应以 `isUsable()` 的结果阻止受保护功能。

`lastValidateResponseAt` 是请求节流事实，`validatedAt` 是 Server 成功确认业务状态的时间，二者不能混用：

| `validate()` 结果 | 更新 `lastValidateResponseAt` | 推进 `validatedAt` |
| --- | --- | --- |
| 合法 2xx 业务结果，包括到期、暂停、吊销等不可用状态 | 是 | 是，使用 Server 返回值 |
| 明确收到 HTTP 失败，例如 401、403、429、500 | 是 | 否 |
| 连接超时、DNS、TLS 或其他未收到 HTTP 响应的失败 | 否 | 否 |
| HTTP 2xx 但响应缺少合法业务数据或不能通过合同校验 | 否 | 否 |
| `notPerformed(.cooldown)`，没有发请求 | 否 | 否 |

因此，“失败不推进 `validatedAt`”仍然成立，但不等于“失败不产生请求冷却”。明确 HTTP 失败会启动两个请求冷却，避免持续打向已经明确拒绝或故障的 Server；没有收到 HTTP 响应，或收到无法形成合法业务结果的 2xx，则不会改写这个起算点。

## 5. 建立应用级授权控制器

SwiftUI App 可以使用一个 `@MainActor ObservableObject` 作为 SDK 和界面之间的唯一入口。下面的代码展示当前 API 的标准使用方式：

```swift
import Combine
import LicenKit

@MainActor
final class LicenseController: ObservableObject {
    @Published private(set) var snapshot: EntitlementSnapshot?
    @Published private(set) var lastKnownSnapshot: EntitlementSnapshot?
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
        case let .success(activation, _):
            snapshot = activation.snapshot
            lastKnownSnapshot = nil
            lastError = nil

        case .notPerformed:
            assertionFailure("Activation is not controlled by validation cooldown")

        case let .failure(error, lastKnownValue, _):
            lastKnownSnapshot = lastKnownValue?.snapshot
            lastError = error
        }
    }

    func deactivate() async {
        isPerformingUserAction = true
        defer { isPerformingUserAction = false }

        switch await LicenKit.shared.deactivate() {
        case let .success(deactivation, _):
            snapshot = deactivation.snapshot
            lastKnownSnapshot = nil
            lastError = nil

        case .notPerformed:
            assertionFailure("Deactivation is not controlled by validation cooldown")

        case let .failure(error, lastKnownValue, _):
            lastKnownSnapshot = lastKnownValue?.snapshot
            lastError = error
        }
    }

    private func apply(_ result: LicenKitResult<EntitlementSnapshot>) {
        switch result {
        case let .success(value, _):
            snapshot = value
            lastKnownSnapshot = nil
            lastError = nil

        case let .notPerformed(.cooldown, cachedValue, _):
            if let cachedValue {
                snapshot = cachedValue
            }
            lastError = nil

        case let .failure(error, lastKnownValue, _):
            lastKnownSnapshot = lastKnownValue
            lastError = error
        }
    }
}
```

`lastKnownValue` 只用于解释上一次状态和辅助诊断。它不会因为本次失败而自动获得新的有效时间，也不能用来绕过 `isUsable()`。

## 6. 如何解释授权快照

宿主界面应该根据 `snapshot.state` 显示准确原因，而不是把所有不可用状态归为“注册码无效”。

| 快照状态 | 用户看到的含义 | 推荐操作 |
| --- | --- | --- |
| `activationRequired + trial.available` | 尚未激活，可以领取设备 Trial | 显示“开始试用”和“输入注册码” |
| `activationRequired + trial.unavailable` | 尚未激活，当前设备不能领取 Trial | 显示激活或购买入口 |
| `trial.active` | Trial 有效 | 进入产品，显示剩余时间 |
| `trial.expired` / `trial.revoked` | Trial 已结束或被撤销 | 停止 Trial 权益，显示激活入口 |
| `license.active` | 正式授权有效 | 按 features 开放能力 |
| `license.expired` | 有效授权期限已结束 | 停止权益，显示续费或购买入口 |
| `license.suspended` | License 被暂停 | 显示安全可返回的原因与支持入口 |
| `license.revoked` | License 被吊销 | 停止权益，保留诊断信息 |
| `activationRevoked` | 当前设备席位被吊销 | 显示重新激活或设备管理入口 |
| `activationDeactivated` | 当前设备已解绑 | 进入激活界面 |
| `releaseNotEligible.updateRequired` | 当前版本超出更新权益 | 显示升级权益或下载可用旧版本入口 |
| `unknown` | 还没有足够证据 | 发起一次明确校验或显示重试入口 |

无凭据 `validate()` 只查询当前设备的 Trial 可用性，不会领取 Trial，也不查询 Product Release。

永久 License 只表示业务上没有 License 到期时间，不表示永久离线。它仍受到在线校验窗口和 Signed License Token 有效期约束。

## 7. 受保护功能的正确判断顺序

业务代码先读取快照，不要每次点击都发请求：

```swift
@MainActor
func performProExport(using controller: LicenseController) async {
    if controller.snapshot?.hasFeature("pro_export") == true {
        await exportDocument()
        return
    }

    if let snapshot = controller.snapshot,
       case .fresh = snapshot.freshness() {
        presentLicenseUI()
        return
    }

    await controller.validateForForeground()

    guard controller.snapshot?.hasFeature("pro_export") == true else {
        presentLicenseUI()
        return
    }

    await exportDocument()
}
```

`hasFeature()` 是纯本地读取，不会隐式联网。快照的在线窗口、业务到期时间或签名 Token 期限任一结束后，它会返回 `false`。此时由宿主选择一个明确调用点执行 `validate()`。

## 8. 激活、Trial 与解绑

### 激活

只有用户提交注册码时调用 `activate()`：

- 请求期间禁用重复提交；
- 成功后直接使用 `ActivationData.snapshot`；
- 不追加一次 `validate()`；
- 不长期保存注册码，也不写入日志或分析事件；
- 正常 License 激活成功后，SDK 会清除同设备残留的 Trial 凭据。

### 开始 Trial

Trial Claim 对同一 Product 和设备只能领取一次，因此必须由用户明确点击“开始试用”后调用 `startTrial()`。首次安装不能自动领取，也不能为了展示 Trial 天数而领取。

`startTrial()` 成功结果已经包含 active Trial 快照。它不写入 `lastValidateResponseAt`，因此不会替下一次 `validate()` 启动请求冷却。Paddle 免费订阅试用产生的是普通 License Key，应调用 `activate()`，不调用设备 Trial API。

### 解绑

`deactivate()` 是远端释放设备席位与本地清理凭据的组合操作。只有 Server 明确确认远端 Activation 已解绑后，SDK 才清除本地凭据并返回成功。

若网络或 Server 失败，SDK 保留 Machine Token，让用户可以重试。宿主不能自行删除 Keychain 并显示“解绑成功”，否则远端席位仍被占用，同时客户端失去再次提交解绑所需的凭据。

## 9. 错误与日志

错误至少分为四类：

- 业务拒绝：例如凭据错误、激活数已满；
- 传输失败：DNS、TLS、超时、断网；
- Server 故障：HTTP 5xx、数据库或配置错误；
- 客户端本地错误：Keychain、签名、协议解码或构建配置错误。

日志应记录：

- 稳定错误 `code`；
- `request_id`；
- HTTP/传输错误类别；
- 经过字段级脱敏的 `details`；
- 当前 Release 版本和平台；
- 操作类型与发生时间。

日志不得记录：

- License Key；
- Machine Token、Trial Token、Signed License Token；
- Authorization Header；
- 完整设备指纹；
- 未脱敏的完整错误包体。

网络失败时保留当前界面与诊断，不要把它改成到期、吊销或有效。向用户提供明确的“重试”操作；SDK 不会自动重试。

## 10. CLI 的定位

CLI 使用与 SDK 相同的 Client API 业务状态和错误合同，适合开发与运维诊断：

```bash
licenkit activate LK-... \
  --server https://license.example.com \
  --product prd_01... \
  --release 2.4.0 \
  --release-platform macos \
  --release-arch universal

licenkit validate
licenkit verify-token
licenkit deactivate
```

CLI 不是宿主 App 的授权运行时。App 不应通过启动子进程调用 CLI，也不应复用 CLI 的本地文件代替 SDK Keychain。

当前 `licenkit validate` 只校验 CLI 已保存的正式 License Activation；CLI 没有新增 Trial 或无凭据查询命令。`verify-token` 验证签名、版本/平台/架构身份、设备绑定和 Token/License 自身期限，也会检查最近一次 Server 校验时间与生效 interval；在线窗口结束时会要求先运行 `licenkit validate`，并以退出码 `2` 结束。Product Release 的发布时间与 `updates_until` 只由 Server 在线比对，不在本地 Token 中重复实现。

自动化脚本调用 `licenkit validate` 时，应使用退出码而不是解析终端文案：

- `0`：当前状态已确认可用；
- `2`：校验操作成功完成，但授权已确认不可用，例如到期、吊销或当前 Release 不具备资格；
- `1`：操作失败，例如网络、Server、凭据认证或响应合同错误。

退出码 `2` 与 `1` 必须分开处理：前者是可信业务结论，后者表示本次没有形成新的可信结论。

## 11. 从旧校验接口迁移

迁移时逐项确认：

- [ ] 删除宿主对 `validateTrial()`、`checkLocalStatus()`、`clearLocalTrial()` 和 `cachedStatus` 的直接调用；
- [ ] 所有当前授权判断改为一个 `validate()`；
- [ ] 不再把 `validate()` 视为“正式 License 专用”；
- [ ] 删除宿主自己的固定间隔 Timer、自动重试和宽限期计算；
- [ ] 用 `EntitlementSnapshot` 代替持久化的 `isPro`、`trialExpired` 等第二份事实；
- [ ] 对 `success` 继续检查 `state`、`freshness()` 与 feature；
- [ ] 把 `notPerformed(.cooldown)` 作为正常分支；
- [ ] `failure` 保留原始错误，不转换成授权终态；
- [ ] 分开保存业务事实时间 `validatedAt` 与请求冷却时间 `lastValidateResponseAt`；
- [ ] 明确 HTTP 失败只更新请求冷却，不推进 `validatedAt`；无 HTTP 响应和非法 2xx 两者都不更新；
- [ ] Trial 只在用户明确操作时领取；
- [ ] 激活或开始 Trial 成功后不追加 `validate()`；
- [ ] 解绑失败时不清除本地凭据；
- [ ] 删除客户端配置、请求和 CLI 中的 `instanceID/instance_id/--instance`；确认只使用全局唯一 Product ID；
- [ ] 测试 Release 未登记仍放行、已登记且更新权益不足、永久 License 周期校验等分支；
- [ ] 从依赖解析结果确认使用的是包含统一合同的 SDK 版本。

Server 的旧 `POST /api/v1/client/trials/validate` 已由统一 `POST /api/v1/client/validate` 取代。直接接入 Client API 的调用方必须使用严格的 `credential.kind = license | trial | none` 联合类型，不能混合两类凭据字段，也不能根据字段是否存在猜测类型。

## 12. 常见问题排查

### 启动后总是要求激活

先检查配置中的 `productID`，再确认宿主 App 的 `CFBundleShortVersionString` 和可执行文件架构能够被 SDK 正确读取，并查看是否发生 Keychain 读取错误。未登记 Product Release 本身不会导致要求激活。不要先清空 Keychain；清空可能破坏后续解绑或 Trial 恢复所需的凭据。

### `validate()` 没有产生网络请求

若结果是 `notPerformed(.cooldown)`，这是预期行为。先区分 `validatedAt` 与 `lastValidateResponseAt`：前者是最近一次成功业务校验，后者是两个请求冷却的起算点。明确 HTTP 失败会更新后者但不会推进前者；连接超时、DNS、TLS、未收到 HTTP 响应，以及 2xx 无合法业务数据都不会更新后者。`activate()`、`startTrial()` 和 `deactivate()` 也不写这个时间。

### App 一直不重新校验

SDK 不会在冷却结束时自动调用 Server。检查宿主是否在冷启动、进入前台或受保护功能发现 `validationRequired` 时主动调用了 `validate()`。

### 明明是永久 License，仍要求联网

永久 License 没有业务到期时间，但不是永久离线凭据。在线校验窗口或 Signed License Token 到期后，下一次宿主主动调用仍需联网。

### 用户断网后界面显示“License 已到期”

这是宿主映射错误。传输失败必须走 `failure`，已到期只能来自成功取得的业务状态，或根据 Server 已确认的绝对到期时间在本地执行保守停止。

### 当前版本被拒绝

当前只存在 `updateRequired`：License 是带 `updates_until` 的永久授权，Server 查到了完全匹配的 Release，并确认其发布时间晚于更新权益截止。这不是 License 到期。对照版本、操作系统、架构、Server Release 记录和日志中的 `request_id` 排查；没有匹配记录时按宽容策略放行。

### 解绑失败后席位仍被占用

保留 SDK 凭据并让用户重试。若需要服务端支持，通过 Customer Portal 或管理端释放 Activation；不要让客户端自行清空凭据来伪装成功。

### `startTrial()` 已在 Server 领取成功，但 Keychain 写入失败

Trial Claim 是 Server 上一次性的业务事实。若 Server 已创建 Claim，而客户端随后写 Keychain 失败，当前设备再次调用 `startTrial()` 会得到 `TRIAL_ALREADY_CLAIMED`；SDK 和宿主都不能自动重领、清除本地状态后重试，或把重复领取伪装成恢复成功。

记录本次请求的错误码、`request_id` 和安全诊断信息，引导用户联系支持。恢复能力必须由独立、经过明确设计的服务端凭据恢复流程提供，不能通过放宽 Trial 唯一性实现。

## 13. 验收边界

完成接入后至少验证：

- 无凭据、Trial 可用、Trial 不可用和已领取；
- Trial active、expired、revoked；
- License active、expired、suspended、revoked；
- Activation revoked、deactivated；
- Release unknown、update entitlement required；
- 常规状态在 Server interval 或固定 30 秒任一窗口内时零网络请求；
- Signed Token 无效或过期时绕过 Server interval，但仍遵守固定 30 秒；
- 明确 HTTP 失败更新 `lastValidateResponseAt`，但不推进 `validatedAt`；
- 连接超时、DNS、TLS、无 HTTP 响应及 2xx 非法业务数据不更新两个时间；
- 冷却结束但宿主未调用时零网络请求；
- 并发 `validate()` 只产生一次 Server 请求；
- 传输失败不推进 `validatedAt`，也不改变成业务终态；请求冷却是否更新按是否收到明确 HTTP 结果判断；
- 业务期限或 Signed Token 期限早于冷却截止时停止授权；
- 激活清除 Trial 凭据，解绑失败保留 License 凭据；
- 错误日志保留 code、request ID 和安全 details，且没有敏感 Token。

本地代码、单元测试和文档对齐只证明当前源码合同。它们不等于 Server 已远端部署、D1 migration 已执行，也不等于真实 App 的 Keychain、网络、生命周期和界面已经验收；这些状态应分别验证和报告。
