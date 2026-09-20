# Customer Site 参考实现

这是 LicenKit 保存的可运行参考页面，不是 LicenKit 的生产官网或部署组件。它包括：

- 静态产品列表与 Paddle.js 购买入口；
- 邮箱 Magic Link 请求与消费；
- 客户 License、设备和订阅管理。

LicenKit 的默认 `dev`、`build`、`test` 和 `deploy` 不会启动、构建或发布本目录。使用方可以把它复制到自己的站点仓库后独立修改，也可以完全使用自己的实现。

## 当前部署合同

Setup 时必须把实际部署的产品站与 Customer Portal 基础地址填写为 `siteUrl`，LicenKit 用它生成邮件中的 Magic Link。当前 `siteUrl` 与 LicenKit `appUrl` 必须同源。浏览器通过相对路径 `/api/v1` 调用 Customer API；LicenKit Admin 位于同一 Origin 的 `/admin/`。当前不支持通过 `VITE_API_BASE_URL` 指向另一个 Origin。

本地开发由 Vite 把 `/api` 代理到 `http://localhost:8787`，因此仍使用同一套相对 API 路径。

## 配置

复制 `.env.example` 为 `.env`，配置 Account slug、Paddle 环境和可公开的 Client-side Token。产品、方案、展示价格和 Paddle Price ID 在 `src/product-catalog.ts` 中静态维护；同一个 Price ID 还必须在 LicenKit Admin 中映射到对应 Product 与 License Plan。

产品页运行时只连接 Paddle，不请求 LicenKit Checkout API。Paddle Price ID 和 Client-side Token 都是前端公开配置；Webhook Secret 与 API Key 仍只能保存在 LicenKit 服务端。

## 独立验证

从 LicenKit 仓库根目录运行：

```bash
pnpm example:site:dev
pnpm example:site:typecheck
pnpm example:site:test
pnpm example:site:build
```

构建产物写入本目录的 `dist`，不会进入 LicenKit Worker 的生产 `dist`。
