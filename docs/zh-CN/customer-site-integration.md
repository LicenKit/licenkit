# Customer Site API 与页面清单

## 1. 边界

LicenKit 只部署 API、Scheduled Worker 和 `/admin` 管理控制台，不提供以下前端页面，也不在仓库中保存可运行示例：

- 产品官网与价格页；
- Paddle Checkout 入口和购买结果页；
- Magic Link 请求页与落地页；
- Customer Portal。

这些页面由使用方在自己的站点项目中实现。当前版本不支持跨站 Customer Session：Setup 中填写的 `siteUrl` 必须与 LicenKit `appUrl` 具有相同 Origin，浏览器固定通过相对路径 `/api/v1` 调用 Customer API。

同一 Origin 不表示两个项目必须放在同一个仓库或使用同一次部署。使用方需要在自己的入口层完成路由，例如把产品与 Customer 页面交给站点部署，把 `/api/v1/*` 和 `/admin/*` 交给 LicenKit。只部署 LicenKit 不会得到这些站点页面。

LicenKit 根据 `siteUrl` 生成以下 Magic Link：

```text
{siteUrl}/customer/{accountSlug}/auth#token={oneTimeToken}
```

因此使用方必须让这个路径落到自己的 Magic Link 消费页面。LicenKit 部署本身不会处理该页面路由。

## 2. 使用方需要实现的页面

| 页面 | 必要行为 |
| --- | --- |
| 产品与价格页 | 静态维护产品、方案、展示价格和 Paddle Price ID；直接使用 Paddle.js 打开 Checkout，不查询 LicenKit 产品或方案列表。 |
| 购买结果页 | 只展示 Paddle Checkout 结果和后续提示；不能把浏览器回调当作付款或发证成功。 |
| Magic Link 请求页 | 获取 Turnstile Sitekey，完成 Widget 后提交 Account slug、邮箱和 Turnstile Token；无论邮箱是否存在都展示相同结果。 |
| Magic Link 落地页 | 匹配 `/customer/:accountSlug/auth`；从 URL Fragment 读取一次性 Token，立即清理地址栏，并在用户明确操作后提交消费请求。 |
| Customer Portal 首页 | 读取当前 Customer 和 License 列表；未认证时引导到 Magic Link 请求页。 |
| License 详情页 | 展示 License 条款、Activation 和 Subscription；只显示服务端允许的动作。 |
| 最近认证页面或状态 | 服务端返回 `CUSTOMER_RECENT_AUTH_REQUIRED` 时重新请求 Magic Link，不能用普通确认弹窗替代认证。 |
| 敏感结果展示 | 注册码找回或安全重置成功后一次性展示新注册码，同时说明通知 Delivery 的当前状态；不得写入日志或浏览器持久存储。 |

支付方式、取消订阅和账单资料不在站点内编辑。页面只能请求 LicenKit 创建支付平台 Portal Session，然后跳转返回的短期 URL。

## 3. Customer API 清单

所有路径都以 `/api/v1` 为前缀。

### 3.1 建立与结束 Customer Session

| 方法与路径 | 请求/用途 | 鉴权要求 |
| --- | --- | --- |
| `GET /customer/auth/config` | 返回公开的 `turnstileSiteKey`。 | 无 Session；`Cache-Control: no-store`。 |
| `POST /customer/auth/magic-link` | `{ accountSlug, email, turnstileToken }`；请求发送 Magic Link。 | 精确同源 Origin；服务端验证 Turnstile。公开响应固定为 `accepted=true`，不能据此判断邮箱是否存在。 |
| `POST /customer/auth/magic-link/consume` | `{ accountSlug, token }`；消费一次性 Token并建立 Customer Session。 | 精确同源 Origin；成功后由服务端设置 Session、Account 和 CSRF Cookie。 |
| `POST /customer/auth/logout` | 吊销当前 Customer Session 并清除 Cookie。 | Customer Session、精确同源 Origin、CSRF。 |

### 3.2 读取 Customer 资源

| 方法与路径 | 用途 |
| --- | --- |
| `GET /customer/me` | 当前 Customer 基本信息。 |
| `GET /customer/licenses` | 当前 Customer 的 License 列表。 |
| `GET /customer/licenses/:licenseId` | 单个 License 详情。 |
| `GET /customer/licenses/:licenseId/activations` | License 的设备 Activation 列表。 |
| `GET /customer/licenses/:licenseId/subscription` | License 与支付订阅摘要。 |

这些接口都要求有效 Customer Session。服务端从 Session 确定 Account 和 Customer，前端不能传入或覆盖资源归属。

### 3.3 Customer 写操作

| 方法与路径 | 用途 |
| --- | --- |
| `POST /customer/licenses/:licenseId/activations/:activationId/deactivate` | 释放一个仍为 active 的设备席位。 |
| `POST /customer/licenses/:licenseId/recover-key` | 轮换注册码但保留现有 Activation；响应一次性返回新注册码并创建通知 Delivery。 |
| `POST /customer/licenses/:licenseId/security-reset` | 轮换注册码并执行安全重置。 |
| `POST /customer/licenses/:licenseId/subscription/portal-session` | 为支付平台管理的订阅创建短期 Portal URL。 |

这些写操作全部要求：有效 Customer Session、精确同源 Origin、CSRF，以及最近 15 分钟内完成的 Magic Link 认证。具体时间以服务端配置为准。

## 4. Cookie、CSRF 与请求方式

浏览器请求必须使用同源相对路径并携带 Cookie，例如：

```ts
await fetch("/api/v1/customer/licenses", {
  credentials: "include",
});
```

Customer Session 使用以下 host-only、Secure、SameSite=Lax Cookie：

- `__Host-licenkit-customer-session`：HttpOnly；
- `__Host-licenkit-customer-account`：HttpOnly；
- `__Host-licenkit-customer-csrf`：允许同源页面读取。

Cookie 鉴权写操作必须把 CSRF Cookie 原值放入 `X-CSRF-Token` Header，并保留 `credentials: "include"`。不能从响应或浏览器存储中自行构造 Session、Account 或 CSRF Token。

## 5. Magic Link 页面约束

1. Token 只放在 URL Fragment，不进入 Query、首个 HTTP 请求或 Referer；
2. 页面启动后立即读取 Fragment，并使用 `history.replaceState` 清理地址栏；
3. Token 存在期间不加载分析、广告或其他第三方资源；
4. 页面 GET 和邮件扫描器预取不能消费 Token，只有用户明确操作后的 POST 才消费；
5. Token、新注册码和完整 Portal URL 不写入日志、分析事件、localStorage 或 sessionStorage；
6. 无效、过期、已消费和已吊销 Token 都按服务端原始错误处理，不在前端归一化成无法诊断的通用错误。

## 6. 产品页与 Checkout

LicenKit 不提供 Public Checkout API 或 Web Checkout SDK。产品页静态维护 Paddle Client-side Token、环境和 Price ID，直接调用 Paddle.js。Client-side Token 和 Price ID 可以公开；Paddle API Key、Webhook Secret、Notification Gateway Secret 和验证令牌不能进入前端。

浏览器 Checkout 完成事件只用于页面反馈。只有 Paddle 已验签并持久化的 Webhook 可以创建或更新 Customer、License、Subscription 和通知 Delivery。详细规则见[静态产品页与 Paddle Checkout](./static-product-page.md)。
