# LicenKit

LicenKit 是面向独立开发者和小型软件团队的自托管软件授权系统。它把支付平台确认的购买事实转换为 License，提供注册码签发、设备激活、在线校验、签名授权令牌、客户自助管理和通知等能力。

LicenKit 专注授权生命周期，不承载支付结账，也不直接集成邮件服务商。支付由 Paddle、Stripe 等外部平台完成；客户邮件由 LicenKit 调用使用方配置的 Notification Webhook，再由外部接收方发送。

## 核心能力

- 管理 Product、License Plan、License 和 Activation；
- 支持永久、固定期限和订阅三种 License 生命周期；
- 永久 License 可配置全版本使用或限定期限内发布版本的永久使用权；
- 接收支付 Webhook，并以幂等方式完成首次签发、续费、暂停和取消；
- 使用机器令牌完成在线设备校验；
- 可选签发 Ed25519 Signed License Token，供客户端本地验证授权快照，包括无网络场景；
- 提供使用 Magic Link 登录的客户授权中心，用于查看 License、释放设备席位和进入支付平台管理订阅；
- 通过 Notification Webhook 发送首次发码、注册码找回和安全重置通知；
- 保存入站事件、出站投递、重试尝试和审计记录，支持失败诊断与恢复。

## 工作方式

```text
支付平台 Webhook
        │
        ▼
入站事件 ──> 支付履约 ──> License / Subscription
                              │
                              ├──> Activation / Validation / Signed License Token
                              ├──> Customer Portal / Device Management
                              │
                              └──> Delivery ──> Notification Webhook ──> 邮件服务
```

LicenKit 将数据库中的入站事件和 Delivery 作为异步任务的事实来源。请求后的即时处理用于降低延迟，Scheduled Worker 负责扫描、重试和崩溃恢复；当前架构不依赖 Cloudflare Queues。

## 仓库结构

```text
apps/server    Hono + Cloudflare Workers API
apps/web       React 管理控制台与客户授权中心
apps/cli       命令行客户端
docs           产品、架构、数据模型和接口文档
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

测试与正式环境使用相同模块和调用流程，只替换资源地址、Secret 和支付平台环境等配置。

## 文档

从 [文档入口](./docs/README.md) 开始阅读。目标数据结构见 [schema.sql](./docs/schemas/schema.sql)。

## 当前状态

项目正在按 V1 合同重新开发。现有代码包含可复用的原型实现，但数据表、迁移和接口仍可能与目标文档不一致；功能是否完成以实现、测试和实际运行验证为准。
