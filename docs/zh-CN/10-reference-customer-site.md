# 参考 Customer Site 与独立部署

## 1. 边界

LicenKit 的生产部署只包含 API、Scheduled Worker 和 `/admin` 管理控制台。产品官网、Magic Link 页面与 Customer Portal 由使用方维护和部署，不进入 LicenKit Worker 的静态资产。

`examples/customer-site` 只是可运行、可测试的参考实现，展示以下合同：

- 静态产品和方案直接使用 Paddle.js；
- Magic Link 请求与消费使用 LicenKit Customer API；
- Customer Portal 读取 License、Activation 与 Subscription，并执行允许的自助动作；
- 浏览器完成 Checkout 不能替代已验签支付 Webhook。

使用方可以复制、修改或完全替换该实现。LicenKit 不会从 `custom/**` 选择或合并站点源码，也不会发布使用方官网。

## 2. 当前同源合同

当前版本不支持跨站 Customer Session。Setup 时必须由部署者显式填写 `siteUrl`；服务端不会从请求邮箱、Account 或页面内容中猜测站点地址。`siteUrl` 与 LicenKit `appUrl` 必须具有相同 Origin，即协议、主机和端口都相同，但可以包含站点路径前缀。

一个典型的公开路由是：

```text
/                         使用方产品官网
/customer/:accountSlug    使用方 Customer Portal
/customer-magic-link.html 使用方 Magic Link 请求页
/api/v1/*                 转发到 LicenKit Worker
/admin/*                  LicenKit Admin
```

这些路径可以由同一个边缘入口分发到不同部署产物，但浏览器看到的 Origin 必须相同。参考 Site 使用相对路径 `/api/v1`，不会读取或接受任意 API Origin。

同源要求保留了现有安全合同：

- Admin 与 Customer Session 使用 Secure、HttpOnly、SameSite=Lax 的 host-only Cookie；
- 可读 CSRF Cookie 与 `X-CSRF-Token` Header 执行双提交校验；
- 服务端对写请求执行精确 Origin 校验；
- 邮件中的 Magic Link 以 `system_settings.site_url` 为基础地址；
- Turnstile hostname 使用 `system_settings.site_url` 的 Host；
- Admin 与 API 地址分别由 `system_settings.app_url` 的 `/admin/` 和 `/api/v1` 路径派生，不需要 `adminAppUrl` 或 `customerPortalUrl`。

## 3. 复制参考实现

把参考目录复制到使用方自己的站点仓库，而不是复制到 LicenKit 的 `custom` 目录：

```bash
cp -R examples/customer-site /path/to/your-site/customer-site-reference
```

复制后由使用方决定目录结构、框架和部署流程。需要保留的不是具体 React 组件，而是 API、Cookie、CSRF、Magic Link、Paddle Price ID 和 Webhook 可信边界。

参考实现本身可以在 LicenKit 仓库中独立验证：

```bash
pnpm example:site:typecheck
pnpm example:site:test
pnpm example:site:build
```

这些命令不会改变 LicenKit 的生产 `dist`，也不会被 `pnpm build` 或 `pnpm deploy` 自动调用。

## 4. 配置

参考 Site 的 `.env` 只包含前端公开配置：

```dotenv
VITE_LICENKIT_ACCOUNT_SLUG=example-studio
VITE_PADDLE_ENVIRONMENT=live
VITE_PADDLE_CLIENT_SIDE_TOKEN=live_...
```

产品、方案、展示价格和 Paddle Price ID 在 `src/product-catalog.ts` 中静态维护。同一个 Price ID 必须在 LicenKit Admin 中映射到唯一 Billing Provider、Product、License Plan 和购买类型。

当前不提供 `VITE_API_BASE_URL`。Customer API 固定使用同源 `/api/v1`；如果部署拓扑无法提供该路由，就不满足当前版本的同源合同。

## 5. 更新参考代码

参考 Site 不作为使用方站点的上游仓库。LicenKit 更新参考实现后，使用方按需比较和移植变化，不应把整个 LicenKit 仓库作为官网的运行依赖。

升级时至少核对：

1. Customer API 请求与错误合同；
2. Session Cookie 和 CSRF Header 名称；
3. Magic Link Fragment、地址清理和显式消费动作；
4. Turnstile action 与 CSP；
5. Paddle.js CSP、Price ID 和成功页边界；
6. Customer 敏感动作的最近认证要求。
