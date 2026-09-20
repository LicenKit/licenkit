# Web Checkout SDK 与产品页合同

## 1. 目标与边界

V1 提供 `@licenkit/checkout` JavaScript/TypeScript SDK 和一个可修改的完整 Site 模板。SDK 是无界面的支付启动器，用户拥有页面结构、样式、文案、分析和路由；模板中的产品页只是同一公开合同的调用方，不是特殊收款通道。Site 同时承载 Magic Link 与 Customer Portal，但不包含 Admin。

这个 SDK 解决三个问题：

1. 产品页不需要硬编码 Paddle 环境、Client-side Token 或 Price ID；
2. 用户只能从 LicenKit 当前公开的 active Offer 中选择商品，正常调用固定数量为 1；
3. Notification Gateway、Webhook 或调度链路未就绪时，页面不能通过官方 SDK 打开 Checkout。

SDK 不创建 Product、Customer、License、Subscription 或 Delivery，不持有注册码，也不提供支付结果查询。支付和发码的唯一事实来源仍是已验签并持久化的 Paddle Webhook。

## 2. 用户产品页需要配置什么

产品页只需要三个公开值：

| 配置 | 示例 | 作用 |
| --- | --- | --- |
| `licenkitBaseUrl` | `https://license.example.com` | 请求 LicenKit 公开 Checkout 配置 |
| `accountSlug` | `example-studio` | 选择所属账户 |
| `productSlug` | `example-app` | 绑定具体 Product |

页面不配置 API Key、Webhook Secret、Notification Gateway Secret、内部 Product ID 或 Price ID。Price 与授权方案的关系由管理端 Offer Mapping 决定，SDK 从公开 API 获取当前允许的 Offer。

`licenkitBaseUrl` 虽然由站点开发者配置，SDK 仍必须把它当作不可信输入并在首次请求前校验：只接受不含用户名、密码、查询参数或 Fragment 的绝对 HTTPS Origin；只有明确的 Sandbox 本地开发模式允许 `http://localhost`。校验失败立即返回配置错误，不请求网络、不加载 Paddle.js。`accountSlug` 和 `productSlug` 只能作为经过 URL 编码的独立路径段使用，不能参与字符串拼接形成新路径或查询参数。

页面部署还必须满足 Paddle 自身的站点前提：Sandbox 与 Live 分别设置 Default Payment Link；Live 产品页所在域名通过 Paddle Website Approval；页面使用 HTTPS，Sandbox 本地开发才使用 localhost。SDK 可以封装 Paddle.js 加载和初始化，但不能代替商户在 Paddle 后台完成域名审批。一个 Account 可以从多个自定义页面调用同一公开合同，但每个 Live Origin 都必须被 Paddle 接受。

若站点使用 Content Security Policy，页面所有者必须按当前 Paddle 官方文档放行 Paddle.js、Checkout frame 和所需连接来源。LicenKit 不在模板中长期硬编码一份可能随 Paddle 更新而漂移的域名清单；参考模板应在 README 中链接官方要求并提供可验证的示例策略。

Paddle 的 Client-side Token 会出现在公开 API 响应中，这是它的设计用途：初始化 Paddle.js、预览价格和打开 Checkout。它权限受限，可以进入浏览器。Paddle API Key 是服务器端 Bearer 凭证，可能读取或修改商户数据，绝不能进入页面、SDK 配置、静态构建产物、日志或分析事件。Webhook Secret 只用于 LicenKit 服务端验证 Paddle 原始请求，同样不能进入前端。

## 3. 公开 Checkout 配置合同

SDK 调用：

```text
GET /api/v1/public/accounts/:accountSlug/products/:productSlug/checkout
```

完整响应见 [`05-api-contract.md`](./05-api-contract.md)。公开合同只包含：

- Product 的 `slug`、名称和可选说明；
- `checkout.available`；
- 可购买时 Product 所选唯一收款环境对应的 provider、sandbox/live 环境和 Client-side Token；
- 同一环境 active Offer 的公开 ID、显示名、购买类型、Price ID 和固定 `quantity=1`；
- 不可购买时的安全原因码。

接口无 Cookie、允许跨域只读访问、禁止 credentials，并使用 `Cache-Control: no-store`。SDK 必须以 `credentials: "omit"` 请求，并拒绝跨 Origin 重定向；最终响应 Origin 必须等于配置的 `licenkitBaseUrl` Origin。不可购买时不返回 Client-side Token 或 Price ID。管理端看到完整检查结果，公网只看到不会泄露通知地址、Secret、事件内容或内部拓扑的原因码。

网络响应不是受信对象。SDK 在使用任何字段前执行运行时 Schema 校验：响应必须是已知 V1 结构，`provider` 必须为 `paddle`，environment 与 Client-side Token 前缀必须匹配，每个 Offer 必须具备唯一 ID、合法购买类型、合法 Price ID 和固定 `quantity=1`，且不能混合环境。缺字段、未知枚举、重复 Offer、错误数量或超出合理长度的展示字段统一 fail-fast，不加载 Paddle.js，也不尝试“修复”响应。Product/Offer 名称和说明只能通过 JSX 默认转义或 `textContent` 渲染，禁止进入 `innerHTML`、`dangerouslySetInnerHTML`、脚本、样式或 URL 上下文。

## 4. SDK API

建议的 V1 TypeScript 合同：

```ts
export interface LicenKitCheckoutOptions {
  licenkitBaseUrl: string;
  accountSlug: string;
  productSlug: string;
  onEvent?: (event: LicenKitCheckoutEvent) => void;
}

export interface PublicOffer {
  id: string;
  name: string;
  purchaseType: "one_time" | "subscription";
}

export interface LocalizedPrice {
  offerId: string;
  currencyCode: string;
  subtotal: string;
  tax: string;
  total: string;
  formattedSubtotal: string;
  formattedTax: string;
  formattedTotal: string;
}

export interface CheckoutState {
  product: {
    slug: string;
    name: string;
    description?: string;
  };
  available: boolean;
  reasonCodes: string[];
  offers: PublicOffer[];
}

export interface OpenCheckoutOptions {
  offerId: string;
  successUrl?: string;
}

export interface LicenKitCheckout {
  load(): Promise<CheckoutState>;
  previewPrices(offerIds?: string[]): Promise<LocalizedPrice[]>;
  open(options: OpenCheckoutOptions): Promise<void>;
  destroy(): void;
}

export function createLicenKitCheckout(
  options: LicenKitCheckoutOptions,
): LicenKitCheckout;
```

高层 API 刻意不接受 `priceId`、`quantity`、Paddle Client-side Token 或 environment。`open()` 必须重新确认所选 `offerId` 来自当前 `load()` 响应，再在内部调用 Paddle.js：

```ts
Paddle.Checkout.open({
  items: [{ priceId: resolvedOffer.priceId, quantity: 1 }],
});
```

`previewPrices()` 使用本次 `load()` 返回的同一份公开配置调用 Paddle.js PricePreview，返回本地化金额、币种、税费展示字段和 Offer ID；页面负责渲染，不自行拼接金额。SDK 只在当前配置的 Preview 成功后才允许页面启用购买，`open()` 也必须校验这份配置已有成功的 Preview；配置刷新或 Offer 变化后必须重新 Preview。Preview 失败时保留 Paddle 原始错误并阻断当前页面 Checkout，不能退回硬编码价格或沿用旧结果。`successUrl` 只能是当前页面同源 HTTPS URL；sandbox 本地开发允许显式的 localhost。SDK 把 `sandbox` 映射到 Paddle.js sandbox 环境，把 `live` 映射到生产环境，调用方不能覆盖。

SDK 只在通过公开响应校验后，使用 Paddle 官方加载方式初始化 Paddle.js。推荐参考模板依赖官方 `@paddle/paddle-js` 包并锁定 npm lockfile；若页面直接引入脚本，只能使用 Paddle 文档给出的官方 CDN 地址，不能复制或自托管脚本。Paddle CDN 是明确的第三方供应链边界：依赖升级必须经过 Checkout 回归，模板不得为了“让它能跑”而关闭 CSP 或加入宽泛的通配来源。

### 4.1 管理端验证入口

同一个 SDK 包内部复用 Checkout 核心，但管理控制台使用独立的受限入口。它先以 owner/admin Session 调用：

```text
POST /api/v1/admin/billing/offers/:offerId/verification-config
```

响应包含 draft Sandbox Offer 配置、`verificationMode=true`、短期一次性 `verificationToken` 和 `expiresAt`。SDK 使用 Paddle.js 的 `customData` 参数把该令牌写入 Transaction 的 `custom_data.licenkit_checkout_verification`，仍固定一个 Price、数量 1；它不能接受调用方补充或覆盖其他 custom data。令牌只保存在当前内存，在 Checkout 打开后或 `destroy()` 时清除，不写日志、URL、localStorage、sessionStorage 或分析事件。

这不是第二套 Checkout：初始化 Paddle.js、PricePreview、Checkout UI 与公开入口共用同一实现；区别只有配置来源经过管理员鉴权，以及服务端把结果固化为不可激活的验证 License。公开 `createLicenKitCheckout()` 不接受验证配置或验证令牌。

## 5. 最小集成示例

```ts
import { createLicenKitCheckout } from "@licenkit/checkout";

const checkout = createLicenKitCheckout({
  licenkitBaseUrl: "https://license.example.com",
  accountSlug: "example-studio",
  productSlug: "example-app",
  onEvent(event) {
    if (event.type === "checkout.completed") {
      showWaitingForLicenseMessage();
    }
  },
});

const state = await checkout.load();

if (!state.available) {
  renderUnavailable(state.reasonCodes);
} else {
  renderOffers(state.offers, async (offerId) => {
    await checkout.open({
      offerId,
      successUrl: `${location.origin}/purchase/success`,
    });
  });
}
```

`checkout.completed` 只允许显示“付款已提交，正在等待授权邮件”或跳转成功页。它不能显示注册码、调用发码 API、创建本地 License，也不能把用户标记为已获得权益。用户可能关闭页面，浏览器事件也可能被伪造或丢失；Webhook 才有签名、重试和服务端持久化保证。

## 6. 参考产品页

仓库中的完整模板位于 `custom_template/site`。使用者需要定制时复制到 `custom/site`；只要后者存在 `package.json`，构建命令就完整选用它，不与模板逐文件合并。`packages/checkout-sdk` 仍是独立包，Site 通过包接口调用，不能把 SDK 的职责复制进页面。

参考模板必须：

- 把 `licenkitBaseUrl`、`accountSlug` 和 `productSlug` 放在一个清晰的配置文件或环境变量入口；
- 说明如何在 Paddle Sandbox/Live 分别设置 Default Payment Link，并在 Live 为实际产品页 Origin 完成 Website Approval；
- 只调用 SDK，不直接硬编码 Paddle Price ID；
- 根据 `available` 禁用购买按钮并展示可理解的通用提示；
- 使用 `previewPrices()` 显示本地化价格，不自行假定币种或税；
- 展示一次购买只包含一个 Offer、数量 1；
- 成功页说明授权通过邮件发送，并允许用户稍后进入 Customer Portal；
- 不记录 Client-side Token 之外的任何支付凭证，不记录 Checkout 表单内容、注册码或完整 Paddle 事件；
- 把所有 API、Paddle callback 和错误字段视为不可信数据，仅用文本节点或框架默认转义渲染；不得把 Provider 原始错误直接插入 HTML；
- 公共配置请求显式使用 `credentials: "omit"`，不在 localStorage、sessionStorage、Cookie 或分析事件中保存 Client-side Token、Price ID 或 Checkout callback；
- 通过 HTTP 响应头设置 CSP，并按 Paddle 当前官方要求最小化放行 `script-src`、`frame-src`、`connect-src` 等来源；`frame-src` 用于允许 Checkout frame，`frame-ancestors` 单独限制谁可以嵌入产品页，不能混为一项；
- 同时设置 `X-Content-Type-Options: nosniff`、适当的 `Referrer-Policy` 和最小 `Permissions-Policy`；不得仅为兼容示例全局加入 `unsafe-eval`、宽泛通配或关闭 CSP；
- 提供 React/Vite 示例和无框架示例，但二者调用同一 SDK 接口。

用户可以删除任意视觉组件、接入自己的设计系统或在现有营销网站绑定按钮。只要保留公开配置查询和 `open({ offerId })` 契约，就不需要复制 LicenKit 的后台逻辑。

## 7. 服务端安全兜底

SDK 限制不是安全边界。攻击者可以绕过页面直接调用 Paddle.js，所以 Payment Webhook 处理器必须从已验签 Transaction 再次检查：

1. 恰好一个行项目；
2. 数量恰好为 1；
3. Price 命中当前 active Offer；
4. Offer、Product、License Plan 和购买类型一致；
5. Offer Provider 环境等于 Product 的 `billing_environment`；
6. 外部 Transaction 尚未产生过 License。

任一条件不满足时，Inbound Event 进入 `needs_attention` 并保留原始 Price、数量、Transaction 和事件 ID，不发 License。浏览器传入的 Offer ID、邮箱、`custom_data`、成功 URL 和 Checkout callback 都不能修正或覆盖这些服务端事实。

唯一窄例外是首次验证 Transaction 的 `custom_data.licenkit_checkout_verification` 通过哈希等值查询命中未过期、未消费、绑定当前 draft Sandbox Offer 的管理员验证尝试。它只能触发同一履约模块创建 `is_checkout_verification=1`、`suspended + checkout_verification` 的 License；不能生成可激活权益。其他 custom data 仍全部不受信。

Paddle 会把该 custom data 复制到验证 Subscription 和后续 Transaction。令牌一经首次交易消费即失去授权作用；后续事件必须先按外部 Subscription ID 命中既有验证 Subscription，只更新支付镜像并保持 License suspended，不能再次解释 token、再次发码或新建 License。

## 8. 收款就绪与运行期退化

Offer 默认 `draft`。激活时需要同时通过：

- Product、License Plan 与 Billing Provider 均可用；
- Billing Provider 环境等于 Product 选择的 `billing_environment`；
- Client-side Token 与 sandbox/live 环境匹配；
- Webhook Secret 可用，并且当前 Provider 配置更新时间之后已逐项收到最小 Paddle 事件合同的对应事件且验签成功；这些证据通常由管理员通过官方模拟器触发；
- active Notification Gateway 已通过 Endpoint Test；
- Scheduled Worker 健康且没有超过阈值的积压；
- `signed` 凭证模式存在 active signing key；
- 真实 Sandbox Checkout 已完成 Transaction -> License -> Delivery accepted 的端到端验收。

首个 Sandbox Offer 尚未 active 时，owner/admin 从管理控制台 POST draft `verification-config`，取得短期一次性令牌后由同一个 SDK 内部入口打开真实 Sandbox Checkout；此后 Checkout、Webhook、履约、发码和 Notification Gateway 均使用正式模块。验证 License 永久不可激活；只有 Delivery accepted 后 Checkout Verification 才 completed。Live Offer 不执行真实扣款验证，可以复用同一 Account/Product/Plan/购买类型已有的成功 Sandbox 闭环证据。这样验证入口只改变“谁能发现 draft Sandbox Offer”和“签发的测试 License 永远不可用”，不产生第二套支付或发码流程。

PricePreview 是浏览器运行期检查，不是上述服务端激活证据。SDK 必须使用本次 `load()` 返回的 Live Client-side Token 和当前 Live Price 实时 Preview；只有成功后才启用购买并允许 `open()`。Preview 失败只阻断当前页面，不改变 active Offer，也不把一次成功结果持久化为 `ready=true`。服务端最终是否履约仍由已验签 Webhook 和 Offer、Price、数量、环境、Customer 合同决定。

管理端在 Provider 和 Offer 页面显示每一项的 `ready|not_ready|stale`、最近成功时间和修复入口。公开 API 只合并为 `available` 与安全原因码。Offer 激活后如果 Provider、Gateway、事件合同、密钥或调度健康失效，公开 API 立即返回 unavailable，SDK 不打开新的 Checkout。

这个门禁无法阻止 Paddle 后台手工交易、旧页面、已打开 Checkout 或绕过 SDK 的调用。已经发生、通过验签并满足 Offer/数量/环境/Customer 合同的付款仍必须履约；通知缺失时创建 `blocked_configuration` Delivery 并告警。合同不满足的付款保留完整事实并进入 `needs_attention`，不能猜测发码，也不能以配置错误为由吞掉事件。

`checkout.available=true` 表示 LicenKit 服务端与支付配置的共享依赖已就绪，不证明当前任意第三方页面 Origin 已获 Paddle 批准。SDK 在当前页面初始化或打开 Checkout 失败时必须 fail-fast 并保留 Paddle 原始错误；产品页上线前必须在实际 Live Origin 完成一次不付款的 Checkout 打开测试。

## 9. 错误与版本兼容

SDK 错误至少区分：

- `CHECKOUT_CONFIG_UNAVAILABLE`：公开配置不可用，保留 HTTP 状态和 request ID；
- `CHECKOUT_CONFIG_INVALID`：Base URL、重定向、响应 Schema、环境/Token 或 Offer 字段不满足本合同，保留可诊断字段但不继续初始化；
- `CHECKOUT_NOT_AVAILABLE`：服务端明确禁止当前购买，携带公开原因码；
- `CHECKOUT_OFFER_NOT_FOUND`：页面使用了已失效或不属于当前 Product 的 Offer ID；
- `PADDLE_INITIALIZATION_FAILED`：保留 Paddle 安全可公开的原始错误码；
- `PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE`：当前页面 Origin、Default Payment Link 或 Website Approval 不满足 Paddle 要求，保留 Paddle 原始错误和 request ID；
- `PADDLE_CHECKOUT_FAILED`：打开或支付界面失败，不代表服务端付款失败；
- `CHECKOUT_DESTROYED`：页面销毁后继续调用。

SDK 不把所有错误归一化成“支付失败”，也不把 Paddle 原始错误全文直接展示给最终用户。`onEvent` 只发出 SDK 定义且通过运行时校验的字段，不透传任意 Provider 对象。内部诊断保留 request ID、SDK 版本、环境和安全可记录的 provider 错误字段；支付资料和 Secret 按字段脱敏。

公开 API 使用 V1 路径和向后兼容字段策略：V1 内可以新增可选显示字段和原因码，不能改变 `available`、`offers[].id`、`purchaseType` 和固定数量语义。破坏性修改使用新的 API/SDK major 版本。

## 10. 验收

至少验证：

1. React/Vite 与无框架模板都只配置三个公开选择器即可加载；
2. Sandbox/Live 都设置 Default Payment Link，实际 Live 产品页 Origin 已批准并完成一次不付款的 Checkout 打开测试；
3. sandbox/live Token 和环境错误时 fail-fast，不打开 Checkout；
4. Product 未选择收款环境，或 Product、Offer、Gateway、事件合同、调度器、Provider 环境或签名密钥任一不就绪时按钮不可购买；
5. 一个页面可展示多个 Offer，但每次 `open()` 只提交一个 Price、数量 1；
6. 调用方传入未知 Offer、跨 Product Offer、任意 Price 或数量均失败；
7. PricePreview 与 Checkout 使用同一次 `load()` 的同一 Offer 配置；未 Preview、Preview 失败、配置刷新或 Offer 变化后未重新 Preview 时，`open()` 必须失败；
8. Checkout 完成回调不产生数据库授权记录；
9. 只有已验签 Webhook 创建 License 和 Delivery；
10. 绕过 SDK 的多行、多数量、环境不一致和 draft Price 交易进入 `needs_attention`；
11. 管理员验证令牌短期、一次性且只匹配一个 draft Sandbox Offer；验证 License 的激活、恢复和迁移都被拒绝，验证订阅的后续更新也不能把它改为 active；
12. Notification Gateway 在 Checkout 后失效时仍创建 License 和 `blocked_configuration` Delivery，并可在负载有效期内由管理员显式恢复发送。
13. 非 HTTPS Base URL、跨 Origin 重定向、畸形 JSON、未知 Provider/环境、错误 Token 前缀、重复 Offer、非 1 数量或超长展示字段均 fail-fast，且请求不携带 Cookie；
14. Product/Offer 名称、说明、原因码和 Provider 错误包含 HTML/脚本载荷时只能作为文本呈现，React/Vite 与无框架模板都不执行载荷；
15. 参考模板在启用生产安全响应头后仍能加载 PricePreview 和 Checkout；CSP 只包含按当前 Paddle 官方文档验证过的最小来源，页面自身不能被未授权站点嵌入。

## 11. Paddle 官方依据

- [Client-side Token 用于浏览器中的 Paddle.js](https://developer.paddle.com/paddle-js/about/client-side-tokens)，API Key 仍只用于服务端；
- [Paddle API 认证](https://developer.paddle.com/api-reference/about/authentication)说明 API Key 使用 Bearer 认证；
- [Paddle Checkout custom data](https://developer.paddle.com/build/transactions/custom-data/)说明 `Paddle.Checkout.open({ customData })` 会把数据保存到 Transaction，并可在 Transaction Webhook 中取得；订阅购买还会复制到 Subscription 和后续 Transaction；
- [Paddle.Checkout.open()](https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/)定义 `items[].priceId`、`quantity` 和 `customData` 参数；
- [Paddle.js 引入方式](https://developer.paddle.com/paddle-js/about/include-paddlejs/)说明从 Paddle 官方 CDN 引入或使用官方 npm 包加载 Paddle.js；
- [Paddle Default Payment Link](https://developer.paddle.com/build/transactions/default-payment-link/)说明 Sandbox/Live 分别配置，Live 使用已批准域名，Sandbox 可使用 localhost；
- [Paddle 的授权开通 Webhook 指南](https://developer.paddle.com/build/subscriptions/provision-access-webhooks)是本项目把已验签 Webhook 作为履约事实来源的外部依据。LicenKit 的七类最小事件清单和 Notification Gateway 门禁是本项目更严格的内部合同，不宣称为 Paddle 的统一强制清单。
