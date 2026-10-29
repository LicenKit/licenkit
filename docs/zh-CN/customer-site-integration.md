# Site 定制与 API 接入

## 1. 内置站点与接入边界

Site（前台站点）是面向访客和购买用户的页面，包含产品介绍、购买入口、邮箱登录及“我的授权”。LicenKit 将 Site 与 Worker API、Scheduled Worker 和 `/admin/` 管理控制台一起部署，根路径 `/` 展示站点首页。

内置模板位于 `apps/site/builtin/`，使用方自己的文件放在 `apps/site/custom/`。custom 初始没有模板文件，空目录也能使用全部内置页面。产品列表默认为空，不展示虚构商品或有效购买按钮；没有配置商品时，客户仍可使用邮箱登录和授权管理。登录本身仍需要完成实例初始化、Turnstile 和邮件服务配置。

Setup 将 `adminApiUrl` 和 `customerSiteUrl` 默认填入当前 Worker Origin（协议、主机名和端口）。`adminApiUrl` 是管理后台与 API 的公开地址，`customerSiteUrl` 是邮件登录链接指向的前台站点基础地址。API 字段 `customer_site_url` 和 Customer API 名称沿用现有合同，模块名称统一为 Site。

内置 Site 当前挂在域名根路径。也可以继续自行实现并托管站点，包含基础路径的既有外部站点合同保持可用。页面和 API 可以同站但跨 Origin，例如页面位于 `https://example.com`，API 位于 `https://license.example.com`；两者必须使用相同协议和可注册站点，以便浏览器在 `credentials: "include"` 请求中发送 API Host 的 `SameSite=Lax` Cookie。Setup 在写入前按包含私有后缀的 Public Suffix List 校验。仅显式非正式环境的相同 hostname `localhost` 或 `127.0.0.1` 允许 HTTP 和不同端口；其他普通 HTTP 域名及 IPv6 loopback 不支持。

LicenKit 根据服务端保存的站点地址生成邮件登录链接：

```text
{customerSiteUrl}/customer/auth#token={oneTimeToken}
```

使用内置 Site 时，该路径已有对应页面。自行托管的站点需要实现同一路径及第 7 节的凭证处理规则。已有实例不会自动修改站点地址；切换到内置 Site 不能只修改 `site.json`，还需明确更新该实例保存的 `instances.site_url`（API 中称为 `customer_site_url`），并重新验证邮件登录链接。迁移步骤见[部署、初始化与升级](./deployment.md#8-site-路由与站点切换)。

## 2. 内置页面与客户操作

| 页面 | 公开路径 | 对应模板 | 行为 |
| --- | --- | --- | --- |
| 站点首页 | `/` | `index.html` | 产品简介、价格入口及“我的授权”入口 |
| 产品与价格 | `/pricing` | `pricing.html` | 从公开配置展示产品与方案，直接通过 Paddle.js 打开结账窗口 |
| 购买结果 | `/purchase-success` | `purchase-success.html` | 提供后续提示；不能把浏览器回调当作付款或发证成功 |
| 邮箱登录 | `/customer/login` | `customer/login.html` | 获取 Turnstile Sitekey，验证后提交购买邮箱；接受申请后的结果不暴露邮箱是否存在 |
| 登录确认 | `/customer/auth` | `customer/auth.html` | 立即读取并清理 URL Fragment，点击“确认登录”后才消费凭证 |
| 我的授权 | `/customer/` | `customer/index.html` | 读取当前客户及授权列表，未登录时引导邮箱登录，提供退出入口 |
| 授权详情 | `/customer/licenses/:licenseId` | `customer/license.html` | 展示授权、设备和订阅，提供当前可用的管理操作 |
| 页面不存在 | 未匹配的页面地址 | `404.html` | 返回 HTTP 404，提供返回首页及授权列表入口 |

授权详情中的 `licenseId` 只用于查询接口，不参与拼接模板文件路径。客户数据和操作权限始终由服务端校验，前端展示不代替权限判断。

授权详情提供以下操作：

- 释放设备占用：停用一个仍在使用中的设备激活。
- 重新获取注册码：生成新注册码，旧码失效，保留现有设备激活。
- 安全重置：生成新注册码，旧码失效，并撤销现有设备激活。
- 管理订阅：支付平台管理的订阅可创建短期管理入口并跳转；支付方式、取消订阅和账单资料在支付平台处理。

新注册码只在成功后的当前页面展示和复制，不写入日志、统计或浏览器持久存储。操作已成功而邮件通知异常时，仍展示新注册码，并单独说明邮件状态。`accepted` 只能表述为“邮件服务商已接收”，不能表述为“已送达”。

核心授权查询失败时展示重试入口；设备或订阅等独立区域失败只影响对应区域。服务端返回 `CUSTOMER_RECENT_AUTH_REQUIRED` 时，重新通过邮件验证身份；完成后由用户重新发起操作，不自动重做写请求，也不能用普通确认弹窗代替认证。

## 3. 按文件定制

### 3.1 覆盖规则

每个页面和资源请求先映射为相对文件路径，再读取 custom。同名文件不存在（静态资源返回 HTTP 404）时才读取 builtin；异常、HTTP 500 或文件内容错误都不能触发替换。空文件也算存在。页面与它引用的样式、脚本和图片分别选择，文件名区分大小写。

例如，只需添加以下文件就能替换登录页与品牌样式，其他文件继续使用内置版本：

```text
apps/site/custom/
├── customer/
│   └── login.html
└── assets/
    ├── theme.css
    └── logo.svg
```

页面统一引用 `/assets/...` 等公开地址，不引用包含 builtin/custom 的内部地址。`site.css` 提供基础布局和默认颜色，随后加载的 `theme.css` 用于定制外观。例如 `custom/assets/theme.css` 可以覆盖内置 CSS 中使用的品牌变量；具体变量名以当前 `builtin/assets/site.css` 为准。

```css
:root {
  --site-primary: #6d28d9;
  --site-primary-hover: #5b21b6;
  --site-tint: #f3efff;
  --site-radius: 10px;
}
```

`custom/about.html` 对应 `/about`，`custom/help/index.html` 对应 `/help/`。新增普通页面的无扩展名路径对应同名 `.html`，以 `/` 结尾的目录路径对应 `index.html`，带扩展名的资源路径按文件读取。删除 custom 文件并更新部署后，该位置恢复内置文件。

`/admin`、`/api` 和 `/__site` 属于保留路径。自定义文件不能覆盖后台、API、发布控制文件或越过模板目录。构建只发布公开资源，不发布隐藏文件、占位文件和服务端凭据；内部打包路径不是公开访问入口。未知页面按文件规则选择 `404.html` 并返回 404，缺失的脚本或图片直接返回资源不存在，不替换成 HTML 首页。

### 3.2 构建与发布

构建时两套文件分别保留在 `dist/__site/builtin/` 和 `dist/__site/custom/`，由 Worker 在请求时选择。构建不会合并两套源码，也不会修改或清理用户的 custom 源文件。

```bash
pnpm build:site
pnpm dev:site
```

`build:site` 仅构建 Site 资源；`dev:site` 持续检查模板文件的增删改并同步发布目录。`pnpm dev` 会准备 Site 和缺少的 Admin 构建产物，并启动本地服务与 Site 文件检查。完整构建与发布继续使用 `pnpm build` 和 `pnpm deploy`。

生产文件随部署版本发布，修改源码后需要重新构建、部署才生效。用户应自行备份或用版本管理保存 custom 文件。构建失败会明确指出配置格式、保留路径冲突或不允许发布的文件，不悄悄改用内置内容。

HTML 和公开配置重新验证缓存，登录页面及客户数据禁止缓存。固定文件名的脚本和样式同样需要校验缓存，发布后应验证页面与资源版本一致。

## 4. 公开配置 site.json

`site.json` 供浏览器读取，只保存公开内容。先复制 `builtin/site.json` 为 `custom/site.json` 再修改；存在 custom 版本时完整使用该文件，不逐字段合并。所有字段按配置合同提供，额外的服务端凭据字段会被拒绝。

默认配置为：

```json
{
  "name": "LicenKit",
  "description": "",
  "supportUrl": null,
  "apiBaseUrl": "/api/v1",
  "paddle": null,
  "products": []
}
```

| 字段 | 含义 |
| --- | --- |
| `name`、`description` | 站点品牌名称及简介 |
| `supportUrl` | 帮助链接，可为站内路径、HTTPS 链接或 mailto 地址；没有时为 null |
| `apiBaseUrl` | API 基础地址，默认本站 `/api/v1`；绝对地址仍受现有同站和请求来源校验 |
| `paddle` | 有购买商品时提供环境及前端公开 Token；没有商品时可为 null |
| `products` | 页面中展示的产品及购买方案，默认空数组 |

以下是 Sandbox 结构示例，Token 和 Price ID 是占位内容，启用前替换为自己的实际公开配置，并在管理后台建立对应 Offer：

```json
{
  "name": "示例软件",
  "description": "了解产品并管理已购授权",
  "supportUrl": "https://example.com/help/",
  "apiBaseUrl": "/api/v1",
  "paddle": {
    "environment": "sandbox",
    "clientSideToken": "test_REPLACE"
  },
  "products": [
    {
      "id": "desktop-app",
      "name": "桌面应用",
      "description": "产品说明",
      "plans": [
        {
          "name": "标准版",
          "description": "一次购买，具体权益见购买说明",
          "price": "¥199",
          "priceId": "pri_REPLACE"
        }
      ]
    }
  ]
}
```

`products[].id` 是页面内唯一标识，不是服务端 Product ID。支付履约按 `priceId` 与管理后台的 Offer 关联。`price` 是静态展示文字，不决定实际收费；实际金额以 Paddle 结账窗口为准。Sandbox 使用 `test_` 前端 Token，Live 使用 `live_` 前端 Token，环境和 Token 需匹配。

Paddle API Key、Webhook Secret、邮件 API Key、登录凭证和注册码不能放入公开配置、模板源码、构建产物、日志或统计事件。关于购买入口的完整合同见[静态产品页与 Paddle Checkout](./static-product-page.md)。

## 5. Customer API 清单

所有路径都以 `/api/v1` 为前缀。

### 5.1 建立与结束 Customer Session

| 方法与路径 | 请求/用途 | 鉴权要求 |
| --- | --- | --- |
| `GET /customer/auth/config` | 返回公开的 `turnstile_site_key`。 | 请求 Host 必须匹配 Instance 的 `admin_api_url`；跨 Origin 时精确匹配该 Instance 的 `customer_site_url` Origin；无 Session；`Cache-Control: no-store`。 |
| `POST /customer/auth/magic-link` | `{ email, turnstile_token }`；请求发送 Magic Link。 | 由 Admin/API Origin 唯一确定 Instance，并匹配 Site Origin；服务端验证 Turnstile。公开响应固定为 `accepted=true`，不能据此判断邮箱是否存在。 |
| `POST /customer/auth/magic-link/consume` | `{ token }`；消费一次性 Token 并建立 Customer Session。 | 由 Admin/API Origin 唯一确定 Instance，并匹配 Site Origin；成功后设置 Session、Instance、CSRF Cookie，并在响应中返回 `csrf_token`。 |
| `GET /customer/auth/csrf-token` | 页面刷新后取回当前 Session 已绑定的 CSRF Token。 | 跨 Origin 时精确匹配 Instance 的 Site Origin，同 Origin 时校验请求 URL Origin；有效 Customer Session、CSRF Cookie 与 Session Hash 一致；`Cache-Control: no-store`。 |
| `POST /customer/auth/logout` | 吊销当前 Customer Session 并清除 Cookie。 | Customer Session、精确匹配 Instance 的 Site Origin、CSRF。 |

### 5.2 读取 Customer 资源

| 方法与路径 | 用途 |
| --- | --- |
| `GET /customer/me` | 当前 Customer 基本信息。 |
| `GET /customer/licenses` | 当前 Customer 的 License 列表。 |
| `GET /customer/licenses/:licenseId` | 单个 License 详情。 |
| `GET /customer/licenses/:licenseId/activations` | License 的设备 Activation 列表。 |
| `GET /customer/licenses/:licenseId/subscription` | License 与支付订阅摘要。 |

这些接口先按请求 URL Origin 匹配 Instance 的 `admin_api_url`，再在跨 Origin 时要求请求 Origin 精确匹配该 Instance 的 `customer_site_url` Origin；浏览器普通同 Origin GET 不会携带 Origin，服务端改为比较请求 URL Origin。两种方式都要求有效 Customer Session，而且 Session 的 Instance 必须与当前 Host 映射的 Instance 一致。服务端从 Session 确定 Customer，前端不能传入或覆盖资源归属。只有最终 2xx 响应会 best-effort 更新 Session 的 `last_seen_at`；该遥测写入失败会记录 `CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED` 与请求、Instance、Session 和受控底层错误信息，但不会把已完成的 2xx 业务响应覆盖为 500。3xx 和 4xx 不更新。

### 5.3 Customer 写操作

| 方法与路径 | 用途 |
| --- | --- |
| `POST /customer/licenses/:licenseId/activations/:activationId/deactivate` | 释放一个仍为 active 的设备席位。 |
| `POST /customer/licenses/:licenseId/recover-key` | 轮换注册码但保留现有 Activation；响应一次性返回新注册码并创建 Email Delivery。 |
| `POST /customer/licenses/:licenseId/security-reset` | 轮换注册码并执行安全重置。 |
| `POST /customer/licenses/:licenseId/subscription/portal-session` | 为支付平台管理的订阅创建短期 Portal URL。 |

这些写操作全部要求：请求 Host 与 Instance 的 `admin_api_url` 匹配、请求 Origin 与该 Instance 的 Site Origin 精确匹配、有效 Customer Session、CSRF Header/Cookie/Session Hash 三者绑定，以及最近 15 分钟内完成的 Magic Link 认证。具体时间以服务端配置为准。

## 6. Cookie、CSRF 与请求方式

浏览器请求必须指向正确的 LicenKit API 并显式携带 Cookie。同源 Site 可使用 `/api/v1`，跨 Origin 时使用绝对 API 地址，例如：

```ts
await fetch("https://license.tidest.app/api/v1/customer/licenses", {
  credentials: "include",
});
```

服务端只在 Customer API 路径返回精确 CORS 授权：先由请求 URL Origin 解析 Instance，再令 `Access-Control-Allow-Origin` 等于该 Instance 的 `customer_site_url` Origin，并返回 `Access-Control-Allow-Credentials: true`；允许 `GET/POST/OPTIONS` 和 `Content-Type/X-CSRF-Token/X-Request-Id`。Admin、Client 与 Webhook API 不继承这组跨 Origin 权限。预检不要求 Session，但 Setup 必须已完成，且 Host、Origin、方法与 Header 必须符合该合同。

Customer Session 使用以下属于 LicenKit API Host 的 host-only、Secure、SameSite=Lax Cookie：

- `__Host-licenkit-customer-session`：HttpOnly；
- `__Host-licenkit-customer-instance`：HttpOnly；
- `__Host-licenkit-customer-csrf`：HttpOnly。

这些 Cookie 不设置 `Domain`，不能由 `tidest.app` 页面直接读取。Magic Link 消费响应会同时返回 `csrf_token`；页面刷新后，通过 `GET /customer/auth/csrf-token` 读取同一个、未旋转的 Token。前端只把它保存在当前页面内存，写操作将其放入 `X-CSRF-Token` Header，并继续使用 `credentials: "include"`。不能从浏览器存储中自行构造或持久化 Session、Instance 或 CSRF Token，也不能在 CSRF 失败后自动重试写操作。

## 7. Magic Link 页面约束

1. Token 只放在 URL Fragment，不进入 Query、首个 HTTP 请求或 Referer；
2. 页面启动后立即读取 Fragment，并使用 `history.replaceState` 清理地址栏；
3. Token 存在期间不加载分析、广告或其他第三方资源；
4. 页面 GET 和邮件扫描器预取不能消费 Token，只有用户明确操作后的 POST 才消费；
5. Token、新注册码和完整 Portal URL 不写入日志、分析事件、localStorage 或 sessionStorage；
6. 无效、过期、已消费和已吊销 Token 都按服务端原始错误处理，不在前端归一化成无法诊断的通用错误。

Magic Link 请求的 anti-enumeration 边界也在服务端：Turnstile Siteverify 通过后、查询 Customer 前，服务端先解密并校验当前 active Email Integration 的 Provider 凭证。Customer 不存在、命中冷却、真实 Customer 产生 `waiting_configuration` Delivery 或成功创建新链接时，前端都只能收到相同的 `accepted=true` 公开语义，不能根据 Delivery 细节推断邮箱是否存在。

消费的一次性约束必须在同一个 D1 原子批次中生效：Challenge 的终态更新由数据库约束或 Trigger 在并发争用时直接中止批次，成功方创建唯一 Customer Session；失败方不能留下 Session、审计、Delivery 更新或其他副作用。不能先提交一组语句，再在批次外以条件更新的 `0` 行结果判断失败。

## 8. 产品页与 Checkout

LicenKit 不提供 Public Checkout API 或 Web Checkout SDK。产品页静态维护 Paddle Client-side Token、环境和 Price ID，直接调用 Paddle.js。Client-side Token 和 Price ID 可以公开；Paddle API Key、Webhook Secret、Email Provider API Key、Template 诊断、Delivery 敏感负载和验证令牌不能进入前端。

浏览器 Checkout 完成事件只用于页面反馈。只有 Paddle 已验签并持久化的 Webhook 可以创建或更新 Customer、License、Subscription 和 Email Delivery。详细规则见[静态产品页与 Paddle Checkout](./static-product-page.md)。
