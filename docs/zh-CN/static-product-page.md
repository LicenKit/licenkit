# 静态产品页与 Paddle Checkout

## 1. 目标与边界

V1 不提供 Public Checkout API，也不提供 LicenKit Web Checkout SDK。产品页静态维护产品、授权方案、展示价格和 Paddle Price ID，并直接调用 Paddle.js。

运行时链路是：

```text
静态产品页 -> Paddle Checkout
Paddle -> 已验签 Webhook -> LicenKit Offer -> Product + License Plan -> License
```

产品页不创建 Customer、License、Subscription 或 Delivery。浏览器中的 Checkout 完成事件、成功 URL 和页面展示内容都不是支付事实；只有已验签并持久化的 Paddle Webhook 可以推进履约。

## 2. 静态产品页配置

LicenKit 不提供产品页示例源码。使用方在自己的站点项目中静态维护：

- 产品 ID、名称和说明；
- 页面内方案 ID、名称和说明；
- 静态展示价格；
- Paddle Price ID；
- 一次性购买或订阅的展示类型。

`.env` 只保存前端公开配置：

```dotenv
VITE_PADDLE_ENVIRONMENT=live
VITE_PADDLE_CLIENT_SIDE_TOKEN=live_...
```

Customer Portal 不需要配置 Instance 选择字段；服务端由请求的 `adminApiUrl` Origin 唯一确定 Instance。Setup 中的 `customerSiteUrl` 是用户自己的官网地址，用于生成邮件 Magic Link；`adminApiUrl` 是 LicenKit 管理后台和 API 的 Origin，Setup 页面默认读取当前 Worker Origin。两者可以跨 Origin，但必须保持同协议、同可注册站点。站点通过 `adminApiUrl` 下的绝对 API 地址调用 Customer API。Paddle Client-side Token 和 Price ID 按 Paddle 的前端合同可以公开；Paddle API Key、Webhook Secret、Email Provider API Key、Template 诊断和 Delivery 敏感负载不能进入源码、静态构建产物、日志或分析事件。

同一个 Paddle Price ID 必须在 LicenKit Admin 中创建 Billing Offer，关联唯一 Billing Provider、Product、License Plan 和购买类型。前端不需要 LicenKit Offer ID、Product ID 或 License Plan ID；后端从已验签 Webhook 中取得 Price ID 后执行关联。

## 3. 打开 Checkout

产品页直接加载 Paddle 官方脚本并初始化：

```ts
Paddle.Environment.set("sandbox"); // 仅 Sandbox
Paddle.Initialize({ token: "test_..." });

Paddle.Checkout.open({
  items: [{ priceId: "pri_01...", quantity: 1 }],
  settings: {
    successUrl: `${location.origin}/purchase-success.html`,
  },
});
```

使用方页面每次只应打开一个 Price、数量 1，并把成功 URL 限制为当前页面同源 HTTPS；Sandbox 本地开发可以使用 localhost。页面可选择直接展示静态价格，也可以直接调用 Paddle PricePreview 获取本地化展示，但 PricePreview 不是 LicenKit Readiness 或履约证据。

Sandbox 与 Live 必须分别设置 Paddle Default Payment Link。Live 产品页的真实 Origin 必须完成 Website Approval，并在上线前执行一次不付款的 Checkout 打开测试。页面 CSP 只放行 Paddle 官方脚本、连接和 Checkout Frame 所需来源。

## 4. 服务端可信边界

浏览器代码可以被修改，因此“一个 Price、数量 1”不能只靠页面保证。LicenKit 对每个已验签购买事件重新检查：

1. 恰好一个行项目；
2. 数量恰好为 1；
3. `billing_provider_id + external_price_id` 命中当前 active Offer；
4. Offer、Product、License Plan 和购买类型一致；
5. Offer 关联的 Billing Provider 环境决定该次购买签发的 License 环境；
6. 外部 Transaction 尚未履约。

任一条件不满足时，Inbound Event 保留外部 Event、Transaction、Price、数量和原始错误，进入 `needs_attention`，不猜测授权方案，也不发 License。

产品页与 LicenKit 没有运行期连接，因此 LicenKit 暂时不可用、Offer 已归档或通知链路故障时，静态页面仍可能成功收款。这是解耦后的明确边界：

- Webhook 接收端先验签并持久化事件，再返回 2xx；
- 暂时依赖失败保持 `pending` 并由 Scheduled Worker 重试；
- 合同不满足进入 `needs_attention`，保留完整诊断；
- License 已创建但 Email Integration/Binding 未就绪时创建 `waiting_configuration` Email Delivery；
- 管理端必须提供告警、诊断和显式恢复动作。

Offer 激活时，服务端实时检查 Product、Plan、Provider、Client-side Token、Webhook Secret、active Email Integration 与凭证、`customer.license_issued@1` 当前 Binding、处理积压，以及 `signed` 模式所需的签名密钥。模拟事件覆盖率和真实购买测试都在上线后验证，不作为 Sandbox 或 Live Offer 的激活门槛。邮件配置测试和 System Issue 不形成持久化门禁；找回、安全重置和 Magic Link Binding 也不参与 Offer 激活。Scheduler 最近成功时间不持久化，远程调度是否运行须在 Cloudflare Cron Events 与 Workers Logs 中验收。Offer 已激活不代表静态页面能够感知之后的运行期退化。

## 5. Admin Sandbox 测试购买

Owner 或 Admin 可以针对已激活的 Sandbox Offer 获取普通测试购买配置：

```text
GET /api/v1/admin/billing/offers/:offerId/test-checkout-config
```

接口只读、响应不缓存，返回当前 Sandbox 的公开 Client-side Token、Price ID 和数量 1。管理端使用官方 Paddle.js 打开 Checkout：

```ts
Paddle.Checkout.open({
  items: [{ priceId: config.checkout.price_id, quantity: 1 }],
});
```

这条流程不生成特殊验证令牌，也不附加用于特殊核验的 `customData`。付款按普通 Sandbox 履约处理，会生成可用于测试环境的 License 并发送邮件，管理员应使用测试客户资料。它不开放给未登录页面，也不接受 draft 或 Live Offer；静态产品页仍直接使用自己的 Paddle 配置，不调用管理端接口。

## 6. 验收

至少验证：

1. 产品页加载和渲染不请求 LicenKit Checkout API；
2. 产品与方案来自静态源码，点击购买使用对应 Paddle Price ID；
3. Sandbox 与 Live Token/环境不匹配时 fail-fast；
4. 每次 Checkout 只包含一个 Price、数量 1；
5. Paddle API Key、Webhook Secret 和 Email Provider API Key 不进入产品页构建产物；
6. Admin 测试购买仅允许已激活的 Sandbox Offer，使用服务端返回的单个 Price 和数量 1，不附加特殊核验数据；
7. Webhook 对多行、多数量、未知 Price、draft Offer、环境不一致和重复 Transaction 均拒绝发正式 License；
8. 静态页面在 LicenKit 暂时不可用时产生的付款能够通过 Paddle 重试、事件持久化或管理员重放进入同一恢复链路；
9. 实际 Live Origin 通过 Paddle Website Approval，CSP 下可以打开 Checkout；
10. Checkout 完成回调和成功页不会直接创建授权记录。

## 7. Paddle 官方依据

- [Client-side Token 用于浏览器中的 Paddle.js](https://developer.paddle.com/paddle-js/about/client-side-tokens)，API Key 仍只用于服务端；
- [Paddle.Checkout.open()](https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/)定义 `items[].priceId` 和 `quantity`；
- [Paddle.js 引入方式](https://developer.paddle.com/paddle-js/about/include-paddlejs/)说明从 Paddle 官方 CDN 或官方包加载；
- [Paddle Webhook 投递](https://developer.paddle.com/webhooks/about/respond-to-webhooks/)说明响应和重试边界；
- [Webhook 签名验证](https://developer.paddle.com/webhooks/signature-verification)定义原始请求验签要求。
