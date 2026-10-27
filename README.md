# LicenKit

LicenKit 是面向独立开发者和小型软件团队的自托管软件授权系统。它把支付平台确认的购买事实转换为 License，提供注册码签发、设备激活、在线校验、签名授权令牌、客户自助管理和通知等能力。

LicenKit 专注授权生命周期，不承载支付结账。支付由 Paddle 等外部平台完成；客户邮件由 LicenKit 通过当前 Instance 配置的 Email Integration 发送。

## 核心能力

- 管理 Product、License Plan、License 和 Activation；
- 支持永久、固定期限和订阅三种 License 生命周期；
- 永久 License 可配置全版本使用或限定期限内发布版本的永久使用权；
- 接收支付 Webhook，并以幂等方式完成首次签发、续费、暂停和取消；
- 使用激活记录编号和设备指纹完成在线设备校验；
- 可选签发 Ed25519 Signed License Token，供客户端本地验证授权快照，包括无网络场景；
- 提供基于 Magic Link 和 Customer Session 的客户自助 API，用于查看 License、释放设备席位和进入支付平台管理订阅；
- 通过 Instance 的 Email Integration 发送首次发码、注册码找回、安全重置、Customer Magic Link 和成员邀请通知；
- 保存支付入站事件、邮件投递状态、重试次数和审计记录，支持失败诊断与恢复。
- 使用全局 User 身份登录管理端，通过 Membership 在 Instance 内获得角色；Instance 是全部授权业务数据的租户边界。

## 工作方式

```text
支付平台 Webhook
        │
        ▼
入站事件 ──> 支付履约 ──> License / Subscription
                              │
                              ├──> Activation / Validation / Signed License Token
                              ├──> Customer API / Device Management
                              │
                              └──> Delivery ──> Email Provider ──> 邮件服务
```

LicenKit 将数据库中的入站事件和 Delivery 作为异步任务的事实来源。请求后的即时处理用于降低延迟，Scheduled Worker 负责扫描、重试和崩溃恢复；当前架构不依赖 Cloudflare Queues。

身份与租户关系固定为：User 是登录身份，Instance 是业务租户，Membership 保存角色与访问状态，Invitation 是加入 Instance 的入口。自部署产品只开放一个 Instance，但数据库与服务端查询仍按 `instance_id` 隔离；当前界面不提供第二个 Instance 的创建或切换入口。

## 仓库结构

```text
apps/server             Hono + Cloudflare Workers API
apps/admin              React 管理控制台
apps/cli                命令行客户端
wrangler.jsonc          当前实例的 Cloudflare Worker 配置
docs                    使用者文档、维护者参考与过程记录
```

Swift SDK 位于同级独立仓库 `licenkit-sdk-swift`。

## 技术栈

- Cloudflare Workers、D1 和 Scheduled Triggers；
- Hono、Drizzle ORM、TypeScript；
- React、Vite；
- Swift SDK 使用 Foundation、CryptoKit、Security 和 IOKit。

## 本地开发

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 部署与站点边界

LicenKit 的生产部署只包含 Worker API、Scheduled Worker 和 `/admin` 管理控制台。根路径重定向到 `/admin/`；产品官网、购买结果页、Magic Link 页面和 Customer Portal 不由 LicenKit 提供，也不在仓库中保存前端示例源码。

Setup 为每个 Instance 保存 `admin_api_url` 与 `customer_site_url`。前者是 LicenKit 管理后台和 API 的公开 Origin，Setup 页面默认读取当前 Worker Origin，服务端也要求两者完全一致；后者是用户自己的官网及 Customer Portal 基础地址，用于生成邮件中的 Magic Link。两者可以跨 Origin，但必须保持同协议、同可注册站点，才能使用 `SameSite=Lax` Customer Cookie。Customer CORS 按请求到达的 `admin_api_url` 找到 Instance，再只允许该 Instance 的 `customer_site_url` Origin，不再使用 Wrangler 全局变量。正式环境及普通域名必须使用 HTTPS；只有显式非正式环境的 `localhost` 或 `127.0.0.1` 允许 HTTP 本地开发。自部署只需把 Admin/API 域名绑定到对应 Worker，不显示 CNAME 或托管证书配置。

根目录 `wrangler.jsonc` 是当前部署唯一的 Worker 配置来源。Wrangler 由根包直接依赖，因为它负责整个 LicenKit 部署的开发、迁移、构建和发布；`apps/server` 只负责 Worker 服务端源码及其测试。直接在根配置中填写数据库 ID、变量和环境，不再从其他目录选择或合并配置。根配置显式开启 Workers Observability，远程验收还必须在 Cloudflare Cron Events 与 Workers Logs 中确认调度真实触发。

`dist` 只包含 LicenKit Admin 的部署资产。使用方需要实现的页面、Customer API 和安全合同见[Customer Site 接入清单](./docs/zh-CN/customer-site-integration.md)。

测试与正式环境使用相同模块和调用流程，只替换资源地址、Secret 和支付平台环境等配置。

## 文档

从 [文档入口](./docs/README.md) 开始阅读。

## 许可证与贡献

本仓库的 LicenKit 原创代码和文档采用 **GNU Affero General Public License, version 3 only**，标识为 `AGPL-3.0-only`。完整条款见 [LICENSE](./LICENSE)。本项目未选择“3.0 或任何后续版本”；许可证原文附录中的应用示例不改变这一选择。版权所有者保留其各自的版权。

AGPL 允许商业使用，使用、修改、分发及通过网络提供修改版本时，应遵守其相应条款；网络交互场景的源码提供要求见第 13 节。该许可证声明不构成另外一项专有或商业许可。

第三方依赖、资产及其许可证和版权声明继续适用各自条款，不因本仓库的许可证选择而改写。[CLA.md](./CLA.md) 基于 Harmony 范本改编，其文本按文件内注明的 CC BY 3.0 许可提供；该文本的复用许可与贡献者授予项目的权利分别处理。本声明不替代既有贡献的权利归属核查，也不追溯取得其他权利人的额外授权。

贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。**CLA v1.0 已启用，贡献者阅读后使用本人账号在 PR 中发表一条同意评论即可完成确认。** 英文为唯一确认文本，中文仅帮助理解。协议保留贡献者版权，允许接收方进行商业、专有及多层级再许可，并允许在项目或相关业务被收购时合法承接，要求受让方书面承担协议义务。初始接收方为 CLA 中标识的 GitHub 账号持有人。确认覆盖本次 PR 中明确授权的贡献，由维护者在合并前核查并保存记录。
