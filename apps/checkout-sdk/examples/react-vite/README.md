# React/Vite 参考产品页

这是 `@licenkit/checkout` 的最小 React/Vite 产品页，不包含另一套支付逻辑。页面只用公开 `load()`、`previewPrices()`、`open({ offerId })` 和 `destroy()` 接口；浏览器完成事件只显示“付款已提交”，不会发放授权。

## 配置与运行

复制 `.env.example` 为 `.env.local`，只配置：

- `VITE_LICENKIT_BASE_URL`
- `VITE_LICENKIT_ACCOUNT_SLUG`
- `VITE_LICENKIT_PRODUCT_SLUG`

从 workspace 根目录先安装依赖，再运行 `pnpm --filter @licenkit/checkout build`。构建结果位于 `apps/checkout-sdk/dist/examples/react-vite`。

## Paddle 上线前提

Sandbox 和 Live 都要在 Paddle 中设置 Default Payment Link；Live 还必须让实际产品页 Origin 通过 Website Approval，并在该 Origin 完成一次不付款的 Checkout 打开验证。参考：Paddle 的 [Default Payment Link](https://developer.paddle.com/build/transactions/default-payment-link)、[上线检查清单](https://developer.paddle.com/build/go-live-checklist/) 和 [Paddle.js 引入说明](https://developer.paddle.com/paddle-js/about/include-paddlejs/)。

`_headers` 是可部署的最小策略示例。部署前必须把 `https://license.example.com` 替换为真实 LicenKit API Origin，并在浏览器的 CSP Report-Only 与 Network 记录中重新验证 Paddle 当前实际来源；新增来源应逐项解释，不能改成通配符、加入 `unsafe-eval` 或关闭 CSP。若托管平台不支持 `_headers`，请把同名值配置为 HTTP 响应头。

页面不记录 Client-side Token、Price ID、Checkout callback、支付表单、注册码或完整 Provider 错误。产品与 Offer 文本只通过 React 默认转义渲染。
