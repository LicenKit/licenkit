# 部署、初始化与升级

## 1. 部署内容

LicenKit 的生产部署包含：

- Cloudflare Worker API；
- D1 数据库与 Scheduled Trigger；
- `/admin/` 管理控制台；
- `/` 的 Site（前台站点），包含产品展示、购买入口、邮箱登录和“我的授权”。

Site 的内置文件位于 `apps/site/builtin/`，使用方只需把需要替换的文件放进 `apps/site/custom/`。每次请求先读取 custom，只有文件不存在才使用 builtin；页面与它引用的资源分别选择。custom 初始为空，商品默认未配置；配置商品与 Paddle 价格前仍可使用客户登录和授权管理。页面、公开配置和按文件定制说明见 [Site 定制与 API 接入](./customer-site-integration.md)。

## 2. 准备环境

需要 Node.js、pnpm、Cloudflare 账户和一个 D1 数据库。安装依赖后先执行本地验证：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

测试和正式环境使用相同模块和接口，只替换 D1、域名、Secret、支付平台环境等配置。

## 3. Wrangler 配置

根目录 `wrangler.jsonc` 是当前实例唯一的 Worker 配置来源。Wrangler 安装在根包，因为它管理整个实例的开发、迁移、构建和部署，而不是 `apps/server` 内部的代码工具。创建 D1 数据库：

```bash
pnpm exec wrangler d1 create licenkit-db
```

把命令返回的数据库 ID 写入 `wrangler.jsonc`，并检查：

- Worker 名称和兼容日期；
- D1 `database_name` 与 `database_id`；
- Scheduled Trigger；
- `observability.enabled=true`；
- `ENVIRONMENT`、`APP_VERSION` 和公开的 `TURNSTILE_SITE_KEY`；
- 静态资产目录为 `./dist`，其中 `admin/` 保存后台，`__site/builtin/` 和 `__site/custom/` 分别保存两套 Site 文件；
- 静态资源先经过 Worker 执行文件选择，`html_handling` 与 `not_found_handling` 均为 `none`，页面路径显式映射，避免缺失文件自动变成其他页面。

Admin/API 与 Site 地址属于 Instance 数据，不写入 Wrangler。Setup 保存 `admin_api_url` 与 `customer_site_url`：前者必须是当前访问 Setup 的 Worker Origin，后者是前台站点基础地址，用于生成客户邮件登录链接。新实例默认填写当前 Worker Origin，使用内置 Site 时保留该地址；自行托管站点可继续填写自己的地址，已有实例不会自动改写。服务端按请求 Origin 找到 Instance，再从该 Instance 的 `customer_site_url` 得到唯一允许携带 Customer Cookie 的页面 Origin。两个地址可以跨 Origin，但必须保持同协议、同可注册站点。正式环境及普通域名必须使用 HTTPS；仅当 `ENVIRONMENT` 明确不是 `production`，且 hostname 精确为 `localhost` 或 `127.0.0.1` 时，才允许 HTTP 本地开发。

`wrangler.jsonc` 不保存 Secret。测试和正式环境需要独立的 D1 与 Secret，但不应使用不同业务流程。

## 4. Worker Secrets

至少配置：

| Secret | 用途 |
| --- | --- |
| `INITIAL_SETUP_TOKEN` | 首次 Setup 使用的一次性高熵令牌。初始化完成后移除。 |
| `STORAGE_ENCRYPTION_KEY` | 加密支付/邮件 Provider 凭证、签名私钥和 Email Delivery 敏感变量。 |
| `TURNSTILE_SECRET_KEY` | 服务端验证客户邮箱登录和后台找回密码请求。 |
| `IDENTITY_EMAIL_API_KEY` | 可选：后台账号邮件使用的独立 Resend API Key，不读取实例邮件配置。 |
| `IDENTITY_EMAIL_FROM` | 可选：账号邮件发件地址，例如 `LicenKit <accounts@example.com>`。 |
| `IDENTITY_PASSWORD_RESET_TEMPLATE` | 可选：已发布的 Resend 密码重置模板 ID 或别名。 |

在仓库根目录写入 Secret，例如：

```bash
pnpm exec wrangler secret put INITIAL_SETUP_TOKEN
pnpm exec wrangler secret put STORAGE_ENCRYPTION_KEY
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
```

Secret 不进入仓库、普通环境变量文件、日志、审计详情或 API 响应。

### 4.1 后台账号找回密码

启用邮件找回前，在部署的 Secret 中配置上述三个 `IDENTITY_*` 项，并在 Resend 中创建、发布密码重置模板。模板仅接收两个变量：`reset_url`（设置新密码的完整链接，敏感）和 `expires_at`（链接的 UTC 到期时间）。可使用以下模板正文：

```html
<h1>重置 LicenKit 密码</h1>
<p>你申请了密码重置。请在 15 分钟内使用下面的链接设置新密码。</p>
<p><a href="{{{reset_url}}}">设置新密码</a></p>
<p>链接有效至 {{{expires_at}}}。如果不是你发起的申请，请忽略此邮件。</p>
```

账号邮件与实例的客户邮件、成员邀请分开配置，不会出现在实例的邮件中心，也不要求创建实例模板绑定。现有 Turnstile Widget 需要允许管理后台域名；服务端为后台找回校验 `admin_password_reset` action 和唯一可信的后台 hostname，客户登录的验证规则保持独立。

登录页提供「忘记密码」。系统对已注册、未注册、冷却期内的邮箱统一回复「请求已受理」，该回复不表示邮件已送达。同一邮箱每分钟最多生成一封重置邮件；同一 IP 每十分钟最多受理十次。链接有效期为 15 分钟，重新申请后旧链接失效。用户设置新密码后须重新登录，原有登录和未使用的重置链接全部失效；正常修改密码也会作废未使用的重置链接。

缺少账号邮件配置时，找回页面显示「暂时无法通过邮件找回密码，请联系部署管理员」，正常登录和已登录修改密码仍可使用。用户还可以选择「使用恢复凭据找回」，该入口不要求邮件或 Turnstile 配置。

发送任务与密码重置申请一起存入 `password_reset_requests`。Worker 尝试即时发送，现有每分钟 Cron 补发或重试，最多尝试四次；发送前校验凭据，永久失败停止重试，临时失败按 1、2、4 分钟退避。成功、取消、过期和永久失败均清理加密链接。发送失败写入该申请的 `last_error_code` 和 Worker 结构化日志 `identity.password_reset.email_failed`，不写入实例业务告警，也不记录邮箱或链接明文。排查时按申请 ID 查询 `send_status`、`attempt_count`、`last_error_code`，不要输出 `link_ciphertext` 或密码 Hash。Resend 接收不等于最终送达，需要在邮件服务侧确认实际投递。

升级现有部署时，先应用 `0009_password_reset.sql` 和 `0010_recovery_credentials.sql` 数据库迁移，再发布代码。

### 4.2 恢复凭据

每个后台账号各自拥有一份有效的恢复凭据，系统只保存其 Hash。首次 Setup、受邀者创建账号并登录、已有账号升级后的首次密码登录，会生成凭据并自动发起 `LicenKit-恢复凭据.txt` 下载，同时提示用户确认文件已保存。浏览器可能阻止自动下载，当前窗口提供「再次下载」。关闭窗口或刷新页面后，凭据明文不再提供；用户可以在「个人资料 → 恢复凭据」验证当前密码后重新生成，旧凭据立即失效。恢复凭据不写入 Cookie、Local Storage、Session Storage、日志或审计详情。

TXT 文件包含后台登录地址、登录邮箱、恢复凭据和使用说明，不包含登录密码。文件应保存在密码管理器或其他安全位置，持有文件的人可以重置该账号密码。恢复凭据没有邮件链接的 15 分钟有效期；只在使用或重新生成时失效。

忘记密码且邮件不可用时，用户打开「忘记密码 → 使用恢复凭据找回」，选择 TXT 文件自动填入邮箱和凭据，也可以手动填写。成功设置新密码后，旧凭据在同一数据库事务中作废，全部旧登录和密码重置链接失效；系统立即提供新的 TXT 文件，用户仍需使用新密码登录。每个 IP 十分钟最多尝试十次，不因错误尝试锁定账号。

普通的已登录修改密码和通过邮件找回密码都保留现有恢复凭据，不要求重新下载文件。只有使用恢复凭据或手动重新生成，旧凭据才会立即失效。恢复凭据的生成、替换和使用写入全局身份审计，不属于实例业务操作，也不改变成员角色或访问权限。

## 5. 数据库迁移

本地开发数据库：

```bash
pnpm db:migrate:local
```

远程实例：

```bash
pnpm db:migrate:remote
```

首次部署使用空数据库，按编号执行 `apps/server/drizzle/` 中全部迁移。迁移只创建空 Schema；不会创建 User、Instance、Membership 或 `deployment_bootstrap` 完成记录。当前项目不提供旧 `accounts`、`system_settings`、`account_*` 字段或旧 migration 历史的数据迁移/兼容层。需要重新初始化测试部署时，应明确重建可丢弃数据库，不能删除单表或完成记录来绕过 Setup。

在目标库执行前先查询：

```bash
pnpm exec wrangler d1 migrations list DB --remote
pnpm exec wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

仅在确认绑定的 `DB` 就是目标库、migration 历史与备份已记录后，才执行 `pnpm db:migrate:remote`。应用后重新列出 migration，确认 `users`、`instances`、`instance_memberships`、`instance_invitations`、`deployment_bootstrap` 及 Instance 业务表存在，确认不存在 `accounts`、`system_settings` 和 `users.status`，并执行 `PRAGMA foreign_key_check` 与 `PRAGMA integrity_check`。本地迁移成功不能代替可丢弃或 staging 远程 D1 验证。

## 6. 部署与首次 Setup

完成配置和迁移后部署：

```bash
pnpm deploy
```

部署完成后访问：

```text
https://你的域名/admin/
```

首次 Setup 分为三个独立页面：

1. 只提交 `INITIAL_SETUP_TOKEN` 到 `POST /api/v1/setup/verify-token`；验证不写数据库，Token 只保存在当前页面内存，刷新后必须重新输入；
2. 收集首位 User 的显示名称、邮箱和密码，不单独持久化；
3. 收集首个 Instance 的名称、LicenKit Admin/API 地址和 Site 地址，最后一次性提交完整数据到 `POST /api/v1/setup`；Instance ID 由服务端自动生成。

最终提交使用 `setup_token`、`user` 与 `instance` 三段 JSON。服务端重新验证 Token 和初始化状态，并在同一个 D1 原子批次中创建 User、Instance、Owner Membership、Admin Session、Setup 审计和固定 `deployment_bootstrap(singleton_key='deployment')` 完成记录；任一步失败全部回滚，并发提交只有一个成功。其中：

- Setup 页面把当前 `window.location.origin` 默认填入 `adminApiUrl` 和 `customerSiteUrl`；服务端要求 `adminApiUrl` 与实际 Setup Worker Origin 完全一致；
- Admin 固定为 `adminApiUrl + /admin/`，API 固定为 `adminApiUrl + /api/v1`；
- `customerSiteUrl` 是前台站点地址，用于“我的授权”、Magic Link 和 Turnstile hostname；使用内置 Site 时填写当前 Worker Origin。自行托管站点的地址可以包含基础路径，但仍必须与 `adminApiUrl` 同协议、同可注册站点。

Setup 成功后会永久关闭初始化入口。管理员之后只用全局邮箱和密码登录，不提交 Instance 标识。确认 Owner 可以登录后，从部署环境移除 `INITIAL_SETUP_TOKEN`。

管理端的 Instance 页面只读展示服务端生成的 Instance ID、名称、LicenKit Admin/API 地址、Site 地址和状态；当前自部署只要求把 Admin/API 域名绑定到对应 Worker，不显示 CNAME 或托管证书配置，也不提供状态修改、第二个 Instance 创建或切换入口。Profile 中邮箱只读；修改密码必须验证当前密码，并撤销该 User 除当前请求外的其他 Admin Session。Members 页面由 active Owner 管理 Invitation 与 Membership：邀请、改角色、暂停、恢复、软移除均不允许修改其他 User 的身份资料，最后一个 active Owner 不能被降级、暂停或移除。

## 7. 外部服务配置

在 Admin 中继续配置：

1. Email Integration：V1 选择 Resend，配置 API Key、From/Reply-To 和重试预算；API Key 只在写入时提交，之后不返回明文；
2. 在邮件配置页使用临时 Resend Full access Key 执行一次“安装默认模板”；管理端进度表逐项显示五个模板的等待、安装、完成、跳过或失败状态，相邻模板任务之间等待 5 秒。LicenKit 自动将 Template ID 绑定到四个 Customer 合同和 `instance.member_invited@1` Invitation 合同；临时 Key 不保存，日常发送继续使用 Integration 中的 Sending access Key；
3. 分别创建 Sandbox/Live Paddle Billing Provider，配置公开 Client-side Token、Platform Webhook Secret 和独立的 Simulator Webhook Secret；
4. Product、License Plan 和 Offer Mapping；只有“永久可用、有限期免费更新”的产品需要登记 Product Release；
5. 需要本地签名凭据时，从 Product 页面复制 LicenKit 自动生成的公钥并内置到客户端；私钥只由 Server 托管，不提供上传或下载入口；
6. 只有启用 Paddle Customer 读穿、对账或支付平台门户时，才配置具备对应最小权限的 Paddle API Key；

每个 Template Binding 的测试成功只证明 Resend Send API 返回 Message ID（Provider 已接收），不证明最终送达。没有真实 API Key、已发布 Template ID/Alias 和测试收件地址时，不得将 Resend E2E 写成已完成。

一次性安装只补齐缺失 Binding，不覆盖已有配置。安装完成后 LicenKit 不读取、更新、删除或同步 Resend 中的模板；后续模板文案和样式由管理员直接在 Resend 管理。

五种邮件合同分别测试并展示状态；Offer 激活只要求购买闭环直接依赖的 `customer.license_issued@1` Binding 已启用且邮件服务凭证可读取。邮件的真实投递结果在上线后的普通 Sandbox 购买中验证。找回、安全重置、Customer Magic Link 和 Instance Invitation 未就绪不会阻止 Offer 激活，但会使对应服务能力保持未就绪。

产品页直接使用 Paddle.js，不调用 LicenKit Checkout API。Paddle Price ID 必须在 LicenKit Offer 中映射到明确的 Product 和 License Plan。

每个 Paddle 环境建立一条 URL Notification Destination：使用 Admin 显示的环境回调 URL，将 `traffic_source` 设为 `all`（Platform, Simulation），保存该目标生成的 Secret。迁移旧配置时停用旧 Simulation-only 目标。仅有一次性 Offer 时订阅 `customer.created`、`customer.updated`、`transaction.completed`、`adjustment.created`、`adjustment.updated`；存在订阅 Offer 时再加入 `subscription.created`、`subscription.updated`。可在 Paddle Simulator 中逐类发送 Single event 检查模拟投递；这不是上线门禁，也不能替代真实购买。Sandbox 上线后通过管理后台发起普通购买测试，Live 上线后由管理员自行验证真实购买。

## 8. Site 路由与站点切换

### 8.1 内置 Site

使用当前 Worker Origin 作为前台站点地址时：

```text
https://license.example.com/                      Site 首页
https://license.example.com/pricing               产品与价格
https://license.example.com/customer/login        邮箱登录
https://license.example.com/customer/auth         邮件登录确认
https://license.example.com/customer/             我的授权
https://license.example.com/api/v1/customer/*     Customer API
https://license.example.com/admin/                管理后台
```

内置 Site 当前挂在域名根路径，不需要额外托管前台项目。邮件登录仍需要有效的 Turnstile Sitekey、服务端 Secret、允许该 hostname 的 Widget，以及实例邮件配置和对应模板绑定。

公开配置使用 `apps/site/custom/site.json` 整文件覆盖。它与服务端保存的站点地址用途不同：`site.json` 决定品牌、产品、Paddle 公开信息和页面调用的 API 地址；`customer_site_url` 决定邮件登录链接和允许访问 Customer API 的页面来源。前端配置不能覆盖服务端的请求来源校验。

### 8.2 自行托管的站点

Site 与 API 仍可使用同站但不同 Origin，例如：

```text
https://example.com/customer/*                 自行托管的客户页面
https://license.example.com/api/v1/customer/*  LicenKit Customer API
https://license.example.com/admin/             LicenKit Admin
```

站点调用 Customer API 时使用正确 API 地址、`credentials: "include"` 和服务端返回的 CSRF Token。跨 Origin 时使用绝对 API 地址；默认同源 Site 可以使用 `/api/v1`。如果站点与 API 属于不同协议或不同可注册站点，Setup 会以 `SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED` 拒绝，不能只修改 CORS。Magic Link 的固定落地路径和页面合同见 [Site 定制与 API 接入](./customer-site-integration.md)。

### 8.3 已有实例切换到内置 Site

已有实例的站点地址不会因升级自动改写，管理端的实例信息目前仍为只读。切换按明确的配置迁移执行：

1. 备份 D1，记录目标 Instance ID、`admin_api_url` 和当前 `site_url`。
2. 确认新地址为对应 Worker 的根地址，且符合现有 HTTPS、同协议及同可注册站点规则。
3. 构建并部署 Site，验证首页、登录确认页及 `/admin/` 能访问。
4. 由部署管理员按目标 Instance ID 定点更新 `instances.site_url`，并保留旧值条件，防止改错实例或覆盖同时发生的变更。对外 API 中该字段仍称为 `customer_site_url`，不新增字段或表结构迁移。
5. 读回该实例，确认 `site_url`、`admin_api_url` 和部署地址一致，再重新申请邮件登录链接。
6. 验证邮箱登录、授权查询和写操作；切换前发往旧站点地址的链接不作为新地址验收依据。

只修改 `custom/site.json` 不会更新邮件地址或 Customer CORS 边界。配置迁移与页面部署是两个独立动作，应分别验证。

### 8.4 自定义文件发布

`pnpm dev` 会准备 Site 和首次缺少的后台构建产物，并持续检查两套 Site 文件的增删改。只检查 Site 时使用 `pnpm dev:site`，只构建 Site 时使用 `pnpm build:site`。

生产修改 custom 后执行完整构建和部署，才能更新线上文件。构建只处理 `dist` 发布产物，不清理 custom 源文件；升级前仍需自行备份或用版本管理保存定制内容。部署后验证 HTML、配置、脚本和样式未被旧缓存混用。

## 9. 升级

升级前备份 D1，并分别记录源码 revision、当前 migration 和部署目标。升级步骤：

1. 阅读目标版本的迁移与配置变化；
2. 执行类型检查、测试和构建；
3. 对目标 D1 执行远程迁移；
4. 部署 Worker、Admin 与 Site；
5. 在 Cloudflare 远程界面检查 Cron Trigger，并通过 Cron Events 与 Workers Logs 验证 Scheduled Worker 实际触发；同时检查待处理 Inbound Event、Delivery 和当前 Instance 的 System Issue；
6. 重新查询目标 D1 migration 历史和关键表/列，确认当前初始 Schema 已在正确数据库生效；
7. 用独立请求验证 Admin、API、支付 Webhook 和 Email Provider 的实际环境；支付侧分别核对 Sandbox/Live 的 Platform 与 Simulator 地址、`traffic_source`、独立 Secret 和当前事件清单；
8. 在每个启用的 Paddle 环境逐项完成当前必需事件的 Simulator 测试，并对 Sandbox 执行真实 Checkout；Simulator 证据不能替代 Platform 真实事件；
9. 逐个检查五个 Template Binding 的当前 revision 测试，确认返回 Provider Message ID；最终送达状态仍以 Provider 管理界面/事件为准。

本地命令成功不等于线上升级完成；必须对部署目标执行独立 readback。

`system_issues` 只保存能够归属具体 Instance 的 Billing、Webhook、Email 和业务任务错误，不保存部署级问题，也不作为产品操作门禁。资源绑定失败、Cron 顶层异常、数据库整体不可用等 Deployment 级故障只在 Cloudflare 平台与 Workers Logs 中观察；管理端不持久化 Scheduler 最近成功时间。
