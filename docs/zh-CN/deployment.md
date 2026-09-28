# 部署、初始化与升级

## 1. 部署内容

LicenKit 的生产部署包含：

- Cloudflare Worker API；
- D1 数据库与 Scheduled Trigger；
- `/admin` 管理控制台。

产品官网、购买结果页、Magic Link 页面和 Customer Portal 不由 LicenKit 部署。需要这些页面时，请按 [Customer Site API 与页面清单](./customer-site-integration.md)在使用方站点中实现。

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
- Admin 静态资产目录仍为 `./dist`。

Admin/API 与 Customer Site 地址属于 Instance 数据，不写入 Wrangler。Setup 保存 `admin_api_url` 与 `customer_site_url`：前者必须是当前访问 Setup 的 Worker Origin，后者是用户自己的官网或 Customer Portal 基础地址。服务端按请求 Origin 找到 Instance，再从该 Instance 的 `customer_site_url` 得到唯一允许携带 Customer Cookie 的页面 Origin。两个地址可以跨 Origin，但必须保持同协议、同可注册站点。正式环境及普通域名必须使用 HTTPS；仅当 `ENVIRONMENT` 明确不是 `production`，且 hostname 精确为 `localhost` 或 `127.0.0.1` 时，才允许 HTTP 本地开发。

`wrangler.jsonc` 不保存 Secret。测试和正式环境需要独立的 D1 与 Secret，但不应使用不同业务流程。

## 4. Worker Secrets

至少配置：

| Secret | 用途 |
| --- | --- |
| `INITIAL_SETUP_TOKEN` | 首次 Setup 使用的一次性高熵令牌。初始化完成后移除。 |
| `STORAGE_ENCRYPTION_KEY` | 加密支付/邮件 Provider 凭证、签名私钥和 Email Delivery 敏感变量。 |
| `TURNSTILE_SECRET_KEY` | 服务端验证 Customer Magic Link 请求。 |

在仓库根目录写入 Secret，例如：

```bash
pnpm exec wrangler secret put INITIAL_SETUP_TOKEN
pnpm exec wrangler secret put STORAGE_ENCRYPTION_KEY
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
```

Secret 不进入仓库、普通环境变量文件、日志、审计详情或 API 响应。

## 5. 数据库迁移

本地开发数据库：

```bash
pnpm db:migrate:local
```

远程实例：

```bash
pnpm db:migrate:remote
```

首次部署使用空数据库执行当前完整的初始迁移。迁移只创建空 Schema；不会创建 User、Instance、Membership 或 `deployment_bootstrap` 完成记录。当前项目不提供旧 `accounts`、`system_settings`、`account_*` 字段或旧 migration 历史的数据迁移/兼容层。需要重新初始化测试部署时，应明确重建可丢弃数据库，不能删除单表或完成记录来绕过 Setup。

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
3. 收集首个 Instance 的名称、LicenKit Admin/API 地址和 Customer Site 地址，最后一次性提交完整数据到 `POST /api/v1/setup`；Instance ID 由服务端自动生成。

最终提交使用 `setup_token`、`user` 与 `instance` 三段 JSON。服务端重新验证 Token 和初始化状态，并在同一个 D1 原子批次中创建 User、Instance、Owner Membership、Admin Session、Setup 审计和固定 `deployment_bootstrap(singleton_key='deployment')` 完成记录；任一步失败全部回滚，并发提交只有一个成功。其中：

- Setup 页面把当前 `window.location.origin` 默认填入 `adminApiUrl`；服务端要求它与实际 Setup Worker Origin 完全一致；
- Admin 固定为 `adminApiUrl + /admin/`，API 固定为 `adminApiUrl + /api/v1`；
- `customerSiteUrl` 是用户自己的官网地址，用于 Customer Portal、Magic Link 和 Turnstile hostname；它可以包含基础路径，但必须与 `adminApiUrl` 同协议、同可注册站点。

Setup 成功后会永久关闭初始化入口。管理员之后只用全局邮箱和密码登录，不提交 Instance 标识。确认 Owner 可以登录后，从部署环境移除 `INITIAL_SETUP_TOKEN`。

管理端的 Instance 页面只读展示服务端生成的 Instance ID、名称、LicenKit Admin/API 地址、Customer Site 地址和状态；当前自部署只要求把 Admin/API 域名绑定到对应 Worker，不显示 CNAME 或托管证书配置，也不提供状态修改、第二个 Instance 创建或切换入口。Profile 中邮箱只读；修改密码必须验证当前密码，并撤销该 User 除当前请求外的其他 Admin Session。Members 页面由 active Owner 管理 Invitation 与 Membership：邀请、改角色、暂停、恢复、软移除均不允许修改其他 User 的身份资料，最后一个 active Owner 不能被降级、暂停或移除。

## 7. 外部服务配置

在 Admin 中继续配置：

1. Email Integration：V1 选择 Resend，配置 API Key、From/Reply-To 和重试预算；API Key 只在写入时提交，之后不返回明文；
2. 在邮件配置页使用临时 Resend Full access Key 执行一次“安装默认模板”；管理端进度表逐项显示五个模板的等待、安装、完成、跳过或失败状态，相邻模板任务之间等待 5 秒。LicenKit 自动将 Template ID 绑定到四个 Customer 合同和 `instance.member_invited@1` Invitation 合同；临时 Key 不保存，日常发送继续使用 Integration 中的 Sending access Key；
3. 分别创建 Sandbox/Live Paddle Billing Provider，配置公开 Client-side Token、Platform Webhook Secret 和独立的 Simulator Webhook Secret；
4. Product、License Plan 和 Offer Mapping；只有“永久可用、有限期免费更新”的产品需要登记 Product Release；
5. 需要本地签名凭据时，从 Product 页面复制 LicenKit 自动生成的公钥并内置到客户端；私钥只由 Server 托管，不提供上传或下载入口；
6. 只有启用 Paddle Customer 读穿、对账或支付平台门户时，才配置具备对应最小权限的 Paddle API Key；
7. 若需要客户系统接收 License/订阅等业务事件，另行创建 `event_subscriber` Endpoint。它不发送邮件。

每个 Template Binding 的测试成功只证明 Resend Send API 返回 Message ID（Provider 已接收），不证明最终送达。没有真实 API Key、已发布 Template ID/Alias 和测试收件地址时，不得将 Resend E2E 写成已完成。

一次性安装只补齐缺失 Binding，不覆盖已有配置。安装完成后 LicenKit 不读取、更新、删除或同步 Resend 中的模板；后续模板文案和样式由管理员直接在 Resend 管理。

五种邮件合同分别测试并展示状态；Offer 激活只要求购买闭环直接依赖的 `customer.license_issued@1` Binding 已启用且邮件服务凭证可读取。邮件的真实投递结果在上线后的普通 Sandbox 购买中验证。找回、安全重置、Customer Magic Link 和 Instance Invitation 未就绪不会阻止 Offer 激活，但会使对应服务能力保持未就绪。

产品页直接使用 Paddle.js，不调用 LicenKit Checkout API。Paddle Price ID 必须在 LicenKit Offer 中映射到明确的 Product 和 License Plan。

每个 Paddle 环境建立一条 URL Notification Destination：使用 Admin 显示的环境回调 URL，将 `traffic_source` 设为 `all`（Platform, Simulation），保存该目标生成的 Secret。迁移旧配置时停用旧 Simulation-only 目标。仅有一次性 Offer 时订阅 `customer.created`、`customer.updated`、`transaction.completed`、`adjustment.created`、`adjustment.updated`；存在订阅 Offer 时再加入 `subscription.created`、`subscription.updated`。可在 Paddle Simulator 中逐类发送 Single event 检查模拟投递；这不是上线门禁，也不能替代真实购买。Sandbox 上线后通过管理后台发起普通购买测试，Live 上线后由管理员自行验证真实购买。

## 8. Customer Site 路由

Customer Site 与 LicenKit API 可以使用同站但不同 Origin，例如：

```text
https://tidest.app/customer/*                 使用方 Customer 页面
https://license.tidest.app/api/v1/customer/*  LicenKit Customer API
https://license.tidest.app/admin/*             LicenKit Admin
```

站点调用 Customer API 时必须使用绝对 API 地址、`credentials: "include"` 和服务端返回的 CSRF Token。只部署 LicenKit 不会得到 `/customer/*` 页面。Magic Link 的固定落地路径和 Customer API 见 [Customer Site API 与页面清单](./customer-site-integration.md)。如果站点与 API 属于不同协议或不同可注册站点，Setup 会以 `SETUP_CUSTOMER_SITE_CROSS_SITE_UNSUPPORTED` 拒绝，不能只修改 CORS。

## 9. 升级

升级前备份 D1，并分别记录源码 revision、当前 migration 和部署目标。升级步骤：

1. 阅读目标版本的迁移与配置变化；
2. 执行类型检查、测试和构建；
3. 对目标 D1 执行远程迁移；
4. 部署 Worker 与 Admin；
5. 在 Cloudflare 远程界面检查 Cron Trigger，并通过 Cron Events 与 Workers Logs 验证 Scheduled Worker 实际触发；同时检查待处理 Inbound Event、Delivery 和当前 Instance 的 System Issue；
6. 重新查询目标 D1 migration 历史和关键表/列，确认当前初始 Schema 已在正确数据库生效；
7. 用独立请求验证 Admin、API、支付 Webhook 和 Email Provider 的实际环境；支付侧分别核对 Sandbox/Live 的 Platform 与 Simulator 地址、`traffic_source`、独立 Secret 和当前事件清单；
8. 在每个启用的 Paddle 环境逐项完成当前必需事件的 Simulator 测试，并对 Sandbox 执行真实 Checkout；Simulator 证据不能替代 Platform 真实事件；
9. 逐个检查五个 Template Binding 的当前 revision 测试，确认返回 Provider Message ID；最终送达状态仍以 Provider 管理界面/事件为准。

本地命令成功不等于线上升级完成；必须对部署目标执行独立 readback。

`system_issues` 只保存能够归属具体 Instance 的 Billing、Webhook、Email 和业务任务错误，不保存部署级问题，也不作为产品操作门禁。资源绑定失败、Cron 顶层异常、数据库整体不可用等 Deployment 级故障只在 Cloudflare 平台与 Workers Logs 中观察；管理端不持久化 Scheduler 最近成功时间。
