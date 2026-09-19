# 无框架参考产品页

这是与 React 示例调用同一 `@licenkit/checkout` 接口的原生 JavaScript 页面，不直接调用 Paddle、不硬编码 Price ID，也不包含独立履约逻辑。修改 `checkout-config.js` 中的三个公开选择器后即可接入：

- `licenkitBaseUrl`
- `accountSlug`
- `productSlug`

从 workspace 根目录先安装依赖，再运行 `pnpm --filter @licenkit/checkout build`。构建结果位于 `apps/checkout-sdk/dist/examples/vanilla`。

Sandbox 和 Live 都要在 Paddle 中设置 Default Payment Link；Live 还必须让实际产品页 Origin 通过 Website Approval，并在该 Origin 完成一次不付款的 Checkout 打开验证。参考：Paddle 的 [Default Payment Link](https://developer.paddle.com/build/transactions/default-payment-link)、[上线检查清单](https://developer.paddle.com/build/go-live-checklist/) 和 [Paddle.js 引入说明](https://developer.paddle.com/paddle-js/about/include-paddlejs/)。

`_headers` 是可部署的最小策略示例。部署前必须把 `https://license.example.com` 替换为真实 LicenKit API Origin，并在浏览器的 CSP Report-Only 与 Network 记录中重新验证 Paddle 当前实际来源；新增来源应逐项解释，不能改成通配符、加入 `unsafe-eval` 或关闭 CSP。若托管平台不支持 `_headers`，请把同名值配置为 HTTP 响应头。

所有 API 文本均通过 `textContent` 写入页面。页面不保存 Client-side Token、Price ID、Checkout callback、支付表单、注册码或完整 Provider 错误；浏览器完成事件只显示等待邮件，不发放授权。
