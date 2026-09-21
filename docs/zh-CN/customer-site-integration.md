# Customer Site API 与页面清单

## 1. 边界

LicenKit 只部署 API、Scheduled Worker 和 `/admin` 管理控制台，不提供以下前端页面，也不在仓库中保存可运行示例：

- 产品官网与价格页；
- Paddle Checkout 入口和购买结果页；
- Magic Link 请求页与落地页；
- Customer Portal。

这些页面由使用方在自己的站点项目中实现。当前版本支持“同站、跨 Origin”的 Customer Session，例如页面位于 `https://tidest.app`，API 位于 `https://license.tidest.app`。部署变量 `CUSTOMER_SITE_ORIGIN` 必须精确配置为页面 Origin；Setup 中填写的 `siteUrl` 可以包含站点基础路径，但其 Origin 必须与该变量一致。

该合同要求页面和 API 属于同一协议、同一可注册站点，以便浏览器在 `credentials: "include"` 请求中发送 API Host 的 `SameSite=Lax` Cookie。Setup 使用包含私有后缀的 Public Suffix List 验证该关系，并在任何数据库写入前拒绝跨站组合。仅本地非正式环境允许同 hostname 的 `http://localhost` 或 `http://127.0.0.1` 使用不同端口；普通 HTTP 域名、其他 `127/8` 地址和 IPv6 loopback 都会被拒绝。只部署 LicenKit 不会得到这些站点页面。

LicenKit 根据 `siteUrl` 生成以下 Magic Link：

```text
{siteUrl}/customer/{instance_slug}/auth#token={oneTimeToken}
```

因此使用方必须让这个路径落到自己的 Magic Link 消费页面。LicenKit 部署本身不会处理该页面路由。

## 2. 使用方需要实现的页面

| 页面 | 必要行为 |
| --- | --- |
| 产品与价格页 | 静态维护产品、方案、展示价格和 Paddle Price ID；直接使用 Paddle.js 打开 Checkout，不查询 LicenKit 产品或方案列表。 |
| 购买结果页 | 只展示 Paddle Checkout 结果和后续提示；不能把浏览器回调当作付款或发证成功。 |
| Magic Link 请求页 | 获取 Turnstile Sitekey，完成 Widget 后提交 Instance slug、邮箱和 Turnstile Token；无论邮箱是否存在都展示相同结果。 |
| Magic Link 落地页 | 匹配 `/customer/:instance_slug/auth`；从 URL Fragment 读取一次性 Token，立即清理地址栏，并在用户明确操作后提交消费请求。 |
| Customer Portal 首页 | 读取当前 Customer 和 License 列表；未认证时引导到 Magic Link 请求页。 |
| License 详情页 | 展示 License 条款、Activation 和 Subscription；只显示服务端允许的动作。 |
| 最近认证页面或状态 | 服务端返回 `CUSTOMER_RECENT_AUTH_REQUIRED` 时重新请求 Magic Link，不能用普通确认弹窗替代认证。 |
| 敏感结果展示 | 注册码找回或安全重置成功后一次性展示新注册码，同时说明 Email Delivery 的当前状态；`accepted` 只能表述为“邮件 Provider 已接收”，不能表述为“已送达”。不得写入日志或浏览器持久存储。 |

支付方式、取消订阅和账单资料不在站点内编辑。页面只能请求 LicenKit 创建支付平台 Portal Session，然后跳转返回的短期 URL。

## 3. Customer API 清单

所有路径都以 `/api/v1` 为前缀。

### 3.1 建立与结束 Customer Session

| 方法与路径 | 请求/用途 | 鉴权要求 |
| --- | --- | --- |
| `GET /customer/auth/config` | 返回公开的 `turnstile_site_key`。 | 跨 Origin 时精确匹配 `CUSTOMER_SITE_ORIGIN`；同 Origin 时请求 URL Origin 必须与配置相同；无 Session；`Cache-Control: no-store`。 |
| `POST /customer/auth/magic-link` | `{ instance_slug, email, turnstile_token }`；请求发送 Magic Link。 | 精确匹配 `CUSTOMER_SITE_ORIGIN`；服务端验证 Turnstile。公开响应固定为 `accepted=true`，不能据此判断邮箱是否存在。 |
| `POST /customer/auth/magic-link/consume` | `{ instance_slug, token }`；消费一次性 Token 并建立 Customer Session。 | 精确匹配 `CUSTOMER_SITE_ORIGIN`；成功后设置 Session、Instance、CSRF Cookie，并在响应中返回 `csrf_token`。 |
| `GET /customer/auth/csrf-token` | 页面刷新后取回当前 Session 已绑定的 CSRF Token。 | 跨 Origin 时精确匹配 `CUSTOMER_SITE_ORIGIN`，同 Origin 时校验请求 URL Origin；有效 Customer Session、CSRF Cookie 与 Session Hash 一致；`Cache-Control: no-store`。 |
| `POST /customer/auth/logout` | 吊销当前 Customer Session 并清除 Cookie。 | Customer Session、精确匹配 `CUSTOMER_SITE_ORIGIN`、CSRF。 |

### 3.2 读取 Customer 资源

| 方法与路径 | 用途 |
| --- | --- |
| `GET /customer/me` | 当前 Customer 基本信息。 |
| `GET /customer/licenses` | 当前 Customer 的 License 列表。 |
| `GET /customer/licenses/:licenseId` | 单个 License 详情。 |
| `GET /customer/licenses/:licenseId/activations` | License 的设备 Activation 列表。 |
| `GET /customer/licenses/:licenseId/subscription` | License 与支付订阅摘要。 |

这些接口在跨 Origin 时要求精确匹配 `CUSTOMER_SITE_ORIGIN`；浏览器普通同 Origin GET 不会携带 Origin，服务端改为验证请求 URL Origin 与配置完全相同。两种方式都要求有效 Customer Session。服务端从 Session 确定 Instance 和 Customer，前端不能传入或覆盖资源归属。只有最终 2xx 响应会 best-effort 更新 Session 的 `last_seen_at`；该遥测写入失败会记录 `CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED` 与请求、Instance、Session 和受控底层错误信息，但不会把已完成的 2xx 业务响应覆盖为 500。3xx 和 4xx 不更新。

### 3.3 Customer 写操作

| 方法与路径 | 用途 |
| --- | --- |
| `POST /customer/licenses/:licenseId/activations/:activationId/deactivate` | 释放一个仍为 active 的设备席位。 |
| `POST /customer/licenses/:licenseId/recover-key` | 轮换注册码但保留现有 Activation；响应一次性返回新注册码并创建 Email Delivery。 |
| `POST /customer/licenses/:licenseId/security-reset` | 轮换注册码并执行安全重置。 |
| `POST /customer/licenses/:licenseId/subscription/portal-session` | 为支付平台管理的订阅创建短期 Portal URL。 |

这些写操作全部要求：精确匹配 `CUSTOMER_SITE_ORIGIN`、有效 Customer Session、CSRF Header/Cookie/Session Hash 三者绑定，以及最近 15 分钟内完成的 Magic Link 认证。具体时间以服务端配置为准。

## 4. Cookie、CSRF 与请求方式

浏览器必须使用 LicenKit 的绝对 API 地址，并显式携带 Cookie，例如：

```ts
await fetch("https://license.tidest.app/api/v1/customer/licenses", {
  credentials: "include",
});
```

服务端只在 Customer API 路径返回精确 CORS 授权：`Access-Control-Allow-Origin` 等于 `CUSTOMER_SITE_ORIGIN`、`Access-Control-Allow-Credentials: true`，允许 `GET/POST/OPTIONS` 和 `Content-Type/X-CSRF-Token/X-Request-Id`。Admin、Client 与 Webhook API 不继承这组跨 Origin 权限。预检不要求 Session，但 Origin、方法与 Header 必须符合该合同。

Customer Session 使用以下属于 LicenKit API Host 的 host-only、Secure、SameSite=Lax Cookie：

- `__Host-licenkit-customer-session`：HttpOnly；
- `__Host-licenkit-customer-instance`：HttpOnly；
- `__Host-licenkit-customer-csrf`：HttpOnly。

这些 Cookie 不设置 `Domain`，不能由 `tidest.app` 页面直接读取。Magic Link 消费响应会同时返回 `csrf_token`；页面刷新后，通过 `GET /customer/auth/csrf-token` 读取同一个、未旋转的 Token。前端只把它保存在当前页面内存，写操作将其放入 `X-CSRF-Token` Header，并继续使用 `credentials: "include"`。不能从浏览器存储中自行构造或持久化 Session、Instance 或 CSRF Token，也不能在 CSRF 失败后自动重试写操作。

## 5. Magic Link 页面约束

1. Token 只放在 URL Fragment，不进入 Query、首个 HTTP 请求或 Referer；
2. 页面启动后立即读取 Fragment，并使用 `history.replaceState` 清理地址栏；
3. Token 存在期间不加载分析、广告或其他第三方资源；
4. 页面 GET 和邮件扫描器预取不能消费 Token，只有用户明确操作后的 POST 才消费；
5. Token、新注册码和完整 Portal URL 不写入日志、分析事件、localStorage 或 sessionStorage；
6. 无效、过期、已消费和已吊销 Token 都按服务端原始错误处理，不在前端归一化成无法诊断的通用错误。

Magic Link 请求的 anti-enumeration 边界也在服务端：Turnstile Siteverify 通过后、查询 Customer 前，服务端先解密并校验当前 active Email Integration 的 Provider 凭证。Customer 不存在、命中冷却、真实 Customer 产生 `waiting_configuration` Delivery 或成功创建新链接时，前端都只能收到相同的 `accepted=true` 公开语义，不能根据 Delivery 细节推断邮箱是否存在。

消费的一次性约束必须在同一个 D1 原子批次中生效：Challenge 的终态更新由数据库约束或 Trigger 在并发争用时直接中止批次，成功方创建唯一 Customer Session；失败方不能留下 Session、审计、Delivery 更新或其他副作用。不能先提交一组语句，再在批次外以条件更新的 `0` 行结果判断失败。

## 6. 产品页与 Checkout

LicenKit 不提供 Public Checkout API 或 Web Checkout SDK。产品页静态维护 Paddle Client-side Token、环境和 Price ID，直接调用 Paddle.js。Client-side Token 和 Price ID 可以公开；Paddle API Key、Webhook Secret、Email Provider API Key、Template 诊断、Delivery 敏感负载和验证令牌不能进入前端。

浏览器 Checkout 完成事件只用于页面反馈。只有 Paddle 已验签并持久化的 Webhook 可以创建或更新 Customer、License、Subscription 和 Email Delivery。详细规则见[静态产品页与 Paddle Checkout](./static-product-page.md)。
