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
- `ENVIRONMENT`、`APP_VERSION` 和公开的 `TURNSTILE_SITE_KEY`；
- Admin 静态资产目录仍为 `./dist`。

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

首次部署使用空数据库执行当前全部迁移。不要通过删除 `system_settings` 绕过已完成的 Setup；需要重新初始化测试实例时，应明确重建测试数据库。

邮件重构通过 `0001_email_delivery_schema.sql` 追加，不重写 `0000_v1_initial.sql`。已确认本次改造尚未部署，因此 `0001` 直接删除未使用的 Outbound 表并建立邮件专用结构，不迁移旧 Outbound 数据。在目标库执行前仍先查询：

```bash
pnpm exec wrangler d1 migrations list DB --remote
pnpm exec wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

仅在确认绑定的 `DB` 就是目标库、现有 migration 历史与备份已记录后，才执行 `pnpm db:migrate:remote`。应用后重新列出 migration，并 readback `email_integrations`、`email_template_bindings`、`email_deliveries` 和 `system_issues`，同时确认三个旧 Outbound 表、`system_issue_inbound_events` 及 `inbound_events.blocking_system_issue_id` 已删除。本文档不表示任何远程 D1 已经应用 `0001` 或 `0002`。

## 6. 部署与首次 Setup

完成配置和迁移后部署：

```bash
pnpm deploy
```

部署完成后访问：

```text
https://你的域名/admin/
```

首次 Setup 需要填写实例名称、Account slug、`siteUrl`、Owner 信息和 `INITIAL_SETUP_TOKEN`。其中：

- `appUrl` 从 Setup 请求的 Origin 自动确定；
- Admin 固定为 `appUrl + /admin/`；
- API 固定为 `appUrl + /api/v1`；
- `siteUrl` 用于生成邮件中的 Magic Link，当前必须与 `appUrl` 同源。

Setup 成功后会永久关闭初始化入口。确认 Owner 可以登录后，从部署环境移除 `INITIAL_SETUP_TOKEN`。

## 7. 外部服务配置

在 Admin 中继续配置：

1. Email Integration：V1 选择 Resend，配置 API Key、From/Reply-To 和重试预算；API Key 只在写入时提交，之后不返回明文；
2. 在 Resend 创建并发布四个外部模板，将 Template ID/Alias 绑定到四个 V1 邮件合同，逐个执行配置测试；
3. Paddle Billing Provider、Webhook Secret 和公开 Client-side Token；
4. Product、License Plan、Offer Mapping 和 Product Release；
5. 需要本地签名凭据时配置 Product Signing Key；
6. 只有启用 Paddle Customer 读穿、对账或支付平台门户时，才配置具备对应最小权限的 Paddle API Key；
7. 若需要客户系统接收 License/订阅等业务事件，另行创建 `event_subscriber` Endpoint。它不发送邮件。

每个 Template Binding 的测试成功只证明 Resend Send API 返回 Message ID（Provider 已接收），不证明最终送达。没有真实 API Key、已发布 Template ID/Alias 和测试收件地址时，不得将 Resend E2E 写成已完成。

四种邮件合同分别测试并展示状态；Offer 激活只要求购买闭环直接依赖的 `customer.license_issued@1` Binding 当前测试通过。找回、安全重置和 Magic Link 未就绪不会阻止 Offer 激活，但会使对应客户服务能力保持未就绪。

产品页直接使用 Paddle.js，不调用 LicenKit Checkout API。Paddle Price ID 必须在 LicenKit Offer 中映射到明确的 Product 和 License Plan。

## 8. Customer Site 路由

当前 Customer Session 不支持跨 Origin。使用方可以把站点和 LicenKit 放在不同仓库或不同部署中，但必须由同一个公开 Origin 完成路由，例如：

```text
/                       使用方站点
/customer/*             使用方 Customer 页面
/api/v1/*               LicenKit Worker
/admin/*                LicenKit Admin
```

只部署 LicenKit 不会得到 `/customer/*` 页面。Magic Link 的固定落地路径和 Customer API 见 [Customer Site API 与页面清单](./customer-site-integration.md)。

## 9. 升级

升级前备份 D1，并分别记录源码 revision、当前 migration 和部署目标。升级步骤：

1. 阅读目标版本的迁移与配置变化；
2. 执行类型检查、测试和构建；
3. 对目标 D1 执行远程迁移；
4. 部署 Worker 与 Admin；
5. 检查线上状态、Scheduled Worker、待处理 Inbound Event 和 Delivery；
6. 重新查询目标 D1 migration 历史和关键表/列，确认 `0001` 已在正确数据库生效；
7. 用独立请求验证 Admin、API、支付 Webhook 和 Email Provider 的实际环境；
8. 逐个检查四个 Template Binding 的当前 revision 测试，确认返回 Provider Message ID；最终送达状态仍以 Provider 管理界面/事件为准。

本地命令成功不等于线上升级完成；必须对部署目标执行独立 readback。
