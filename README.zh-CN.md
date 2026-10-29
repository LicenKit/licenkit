# LicenKit

[English](./README.md) | **简体中文**

LicenKit 是面向独立开发者和小型软件团队的自托管软件授权系统。提供注册码签发、设备激活、在线校验、签名授权令牌、客户自助管理和通知等能力。基础架构基于 Cloudflare。

## 核心能力

- 管理 Product、License Plan、License 和 Activation；
- 支持永久、固定期限和订阅三种 License 生命周期；
- 永久 License 可配置全版本使用或限定期限内发布版本的永久使用权；
- 接收支付 Webhook，并以幂等方式完成首次签发、续费、暂停和取消；
- 使用激活记录编号和设备指纹完成在线设备校验；
- 可选签发 Ed25519 Signed License Token，供客户端本地验证授权快照，包括无网络场景；
- 提供基于 Magic Link 和 Customer Session 的客户自助 API，用于查看 License、释放设备席位和进入支付平台管理订阅；
- 提供 Site（前台站点），包含产品展示、购买入口、邮箱登录和授权管理，并支持按文件定制；
- 通过 Instance 的 Email Integration 发送首次发码、注册码找回、安全重置、Customer Magic Link 和成员邀请通知；
- 保存支付入站事件、邮件投递状态、重试次数和审计记录，支持失败诊断与恢复；
- 天然支持多租户体系。

## 核心流程
以用户输入注册码、激活 App 为例：
1. 创建产品时，服务器自动生成一对 Ed25519 签名密钥。私钥用于签发授权，公钥用于检查授权真假。
2. 开发者把公钥随 App 一起发布；私钥加密保存在服务器。
3. 用户激活成功后，如果使用 signed 模式，服务器会把授权期限、可用功能、设备标识、App 版本等信息，用私钥签名后交给 App。
4. App 使用内置公钥验证签名，并核对设备、版本和有效期。修改授权里的到期时间或功能，会导致验签失败。
5. opaque 模式不进行客户端验签，是传统的在线 ID 模式。

## 存储加密
签名私钥、支付和邮件服务密钥、部分邮件内容等，使用 AES-256-GCM 加密后保存到数据库。服务器通过部署时配置的 STORAGE_ENCRYPTION_KEY（Cloudflare Secret） 解密，供签发授权、发送邮件等操作使用。
加密绑定了所属实例、数据记录和字段，直接把一条记录的密文挪到另一条记录，无法正常解密。它保护的是这些敏感字段，并非整个数据库的所有内容。

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
apps/site/builtin       Site 内置页面与公开资源
apps/site/custom        用户自己的 Site 文件，初始为空
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

LicenKit 的生产部署包含 Worker API、Scheduled Worker、`/admin/` 管理控制台，以及根路径 `/` 的 Site（前台站点）。内置 Site 包含产品与价格、购买结果、邮箱登录、我的授权及授权详情页面，授权详情支持设备和订阅管理。默认商品列表为空，配置自己的产品和 Paddle 价格后才提供购买入口；尚未配置商品时，已购客户仍可进入授权管理。

内置文件位于 `apps/site/builtin/`，需要定制的文件放进 `apps/site/custom/`。每次请求先读取 custom 对应文件，只有文件不存在时才读取 builtin 同名文件；页面、脚本、样式和图片分别选择。自定义文件出错时明确报告，不悄悄切换版本。公开配置 `site.json` 按整文件替换，不逐字段合并。生产修改需要重新构建和部署，用户应自行备份或用版本管理保存 custom 内容。

Setup 为每个 Instance 保存 `admin_api_url` 与 `customer_site_url`。前者是 LicenKit 管理后台和 API 的公开 Origin，Setup 页面默认读取当前 Worker Origin，服务端也要求两者完全一致；后者是前台站点的基础地址，用于生成邮件中的 Magic Link。新建实例时两个地址均默认填入当前 Worker Origin，使用内置页面时保留该前台地址。已有实例的站点地址不自动修改，自行托管的站点仍可按原方式接入。两者可以跨 Origin，但必须保持同协议、同可注册站点，才能使用 `SameSite=Lax` Customer Cookie。Customer CORS 按请求到达的 `admin_api_url` 找到 Instance，再只允许该 Instance 的 `customer_site_url` Origin，不再使用 Wrangler 全局变量。正式环境及普通域名必须使用 HTTPS；只有显式非正式环境的 `localhost` 或 `127.0.0.1` 允许 HTTP 本地开发。自部署只需把 Admin/API 域名绑定到对应 Worker，不显示 CNAME 或托管证书配置。

根目录 `wrangler.jsonc` 是当前部署唯一的 Worker 配置来源。Wrangler 由根包直接依赖，因为它负责整个 LicenKit 部署的开发、迁移、构建和发布；`apps/server` 只负责 Worker 服务端源码及其测试。直接在根配置中填写数据库 ID、变量和环境，不再从其他目录选择或合并配置。根配置显式开启 Workers Observability，远程验收还必须在 Cloudflare Cron Events 与 Workers Logs 中确认调度真实触发。

`dist/admin/` 保存管理后台资源，`dist/__site/builtin/` 和 `dist/__site/custom/` 分别保存两套 Site 文件；内部目录不是公开访问入口。页面路径、公开配置、文件定制和客户接口合同见 [Site 定制与 API 接入](./docs/zh-CN/customer-site-integration.md)。现有 API 字段 `customer_site_url` 保持原名。

测试与正式环境使用相同模块和调用流程，只替换资源地址、Secret 和支付平台环境等配置。

## 文档

从 [文档入口](./docs/README.md) 开始阅读。

## 许可证与贡献

本仓库的 LicenKit 原创代码和文档采用 **GNU Affero General Public License, version 3 only**，标识为 `AGPL-3.0-only`。完整条款见 [LICENSE](./LICENSE)。本项目未选择“3.0 或任何后续版本”；许可证原文附录中的应用示例不改变这一选择。版权所有者保留其各自的版权。

AGPL 允许商业使用，使用、修改、分发及通过网络提供修改版本时，应遵守其相应条款；网络交互场景的源码提供要求见第 13 节。该许可证声明不构成另外一项专有或商业许可。

第三方依赖、资产及其许可证和版权声明继续适用各自条款，不因本仓库的许可证选择而改写。[CLA.md](./CLA.md) 基于 Harmony 范本改编，其文本按文件内注明的 CC BY 3.0 许可提供；该文本的复用许可与贡献者授予项目的权利分别处理。本声明不替代既有贡献的权利归属核查，也不追溯取得其他权利人的额外授权。

贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。**向本仓库提交供合并的 PR，即表示您同意 [LicenKit CLA v1.0](./CLA.md) 的英文条款，并将该 PR 中您有权授权的贡献按该协议授权。** 请在提交前阅读完整协议。英文为本协议唯一具有约束力的文本；其他语言的翻译或说明仅供参考。您保留版权，同时授予接收方**商业、专有及多层级再许可权**；允许随项目或相关业务收购合法承接，受让方须**书面承担协议义务**，既有公开许可权利继续保留。初始接收方为 CLA 中标识的 GitHub 账号持有人。本规则适用于协议及提交提示发布后新提交的 PR，不自动覆盖历史贡献或其他权利人的权利。
