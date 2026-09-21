# LicenKit 文档

这里仅列出部署和使用 LicenKit 时需要阅读的文档。

## 自部署

- [部署、初始化与升级](./zh-CN/deployment.md)：配置 Cloudflare Worker、D1、Secret，执行迁移并完成首次 Setup。
- [API 参考](./zh-CN/api-reference.md)：三步 Setup、User/Instance/Membership/Invitation、Customer、Client、支付入站和通知出站接口。

## 产品与客户端接入

- [Swift SDK 集成](./zh-CN/swift-sdk.md)：macOS App 的激活、验证、凭据保存和错误处理。
- [静态产品页与 Paddle Checkout](./zh-CN/static-product-page.md)：产品页如何直接使用 Paddle.js，并由已验签 Webhook 完成履约。
- [Customer Site API 与页面清单](./zh-CN/customer-site-integration.md)：使用方需要实现的页面、Customer API、Magic Link、Cookie 和 CSRF 合同。

## 文档边界

LicenKit 不提供产品官网、Customer Magic Link 页面或 Customer Portal 前端；这些页面由使用方实现。生产部署只包含 API、Scheduled Worker 和 `/admin` 管理控制台，其中成员 Invitation 接受页属于 Admin。

领域模型、业务状态机、系统架构和数据模型属于维护者参考，保存在 `docs/internal/`，不进入用户文档入口。开发计划、提案、审计和阶段记录保存在 `docs/process/`，不得用来声明当前产品能力。
