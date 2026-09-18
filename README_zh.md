<div align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</div>

# LicenKit

> 现代、轻量、高可用的 API-First 软件授权中枢与激活码生成引擎 (Modern, Self-hosted API-First Licensing Hub & Key Generator)。

---

> [!WARNING]
> 🚧 **当前项目正处于积极开发阶段 (Work in Progress / Alpha)**  
> 核心模块与 API 规范正在快速迭代中，文档更新可能不够及时，敬请谅解！暂不建议直接用于关键生产环境。欢迎关注与参与共建！

---

## 🎯 项目目标与愿景

**LicenKit** 旨在为独立开发者（Indie Hackers）、微型 SaaS 及商业软件团队提供一套现代化、真正开箱即用且极致低成本的开源授权解决方案。

- **API-First & 边缘原生**：基于 Cloudflare Workers + D1 架构构建，全球毫秒级响应，轻松实现零运维、近乎零成本的边缘自部署。
- **高强度现代密码学支撑**：内置 WebCrypto 原生 Ed25519 签名与 AES-256-GCM 信封加密，兼顾在线心跳与离线无网强验签需求。
- **完整的授权生命周期闭环**：覆盖产品管理、授权策略定义（买断/订阅/宽限期/设备席位）、激活码生成与分发、机器硬件指纹绑定、试用防刷以及吊销/轮换。
- **开箱即用的支付履约与生态**：规划与深度集成 Paddle、Stripe 等主流商业支付网关，自动完成下单发码与续费流转，并逐步提供全平台原生 SDK。

---

## 🏗️ 技术架构

本项目采用现代化 **Monorepo** 结构管理：

```text
licenkit/
├── apps/
│   ├── server/        # 核心授权与 API 引擎 (Hono + Cloudflare Workers + D1 + Drizzle ORM)
│   ├── web/           # 现代管理控制台 SPA (React 19 + Tailwind CSS v4 + Vite)
│   └── cli/           # 跨平台授权激活与离线验签命令行工具 (Node.js + WebCrypto Ed25519)
├── docs/
│   ├── en/            # 英文版通用技术文档
│   ├── zh-CN/         # 中文版通用技术文档
│   ├── schemas/       # 数据库 DDL 与结构资产
│   └── proposals/     # 过程演进方案与 RFC（内含 archive/ 归档）
└── scripts/           # 运维与辅助工具脚本
```

- **Runtime / Infra**: [Cloudflare Workers](https://workers.cloudflare.com/), [Cloudflare D1](https://developers.cloudflare.com/d1/), [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- **Backend**: [Hono](https://hono.dev/), [Drizzle ORM](https://orm.drizzle.team/), WebCrypto API (Ed25519, AES-256-GCM, PBKDF2)
- **Frontend**: [React 19](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS v4](https://tailwindcss.com/), [Lucide Icons](https://lucide.dev/)
- **CLI**: [Node.js](https://nodejs.org/), [cac](https://github.com/cacjs/cac), native WebCrypto Ed25519
- **Package Manager**: [pnpm](https://pnpm.io/) (Workspace)

---

## 🚀 本地开发快速上手

### 前置要求
- [Node.js](https://nodejs.org/) (>= 20.x)
- [pnpm](https://pnpm.io/) (>= 10.x)

### 安装与启动

1. **克隆项目并安装依赖**：
   ```bash
   git clone https://github.com/your-org/licenkit.git
   cd licenkit
   pnpm install
   ```

2. **启动本地全栈开发环境**：
   ```bash
   # 同时启动 Server API (端口 8787) 与 Web 控制台 (端口 5173)
   pnpm dev
   ```

3. **单独运行子模块**：
   ```bash
   pnpm dev:server   # 仅启动后端 API 引擎
   pnpm dev:web      # 仅启动前端管理面板
   pnpm dev:cli      # 运行客户端 CLI 工具
   ```

4. **类型检查与构建**：
   ```bash
   pnpm typecheck    # 全局 TypeScript 静态检查
   pnpm build        # 全局构建
   ```

---

## 📖 开发与设计文档

深入了解系统架构与开发进度，请参阅 `docs/` 目录：

> [!NOTE]
> 💡 *由于当前项目正处于 **Active Development** 快速开发阶段，文档更新可能不够及时，请见谅。如发现文档与实际代码有出入，请以最新源码和单元测试为准。*

- [开发计划与任务分解矩阵 (Roadmap)](./docs/zh-CN/development_plan.md) ([English](./docs/en/development_plan.md))
- [后端架构设计与密码学方案](./docs/zh-CN/backend_architecture.md) ([English](./docs/en/backend_architecture.md))
- [数据库设计与表结构规范](./docs/zh-CN/database_design.md) ([English](./docs/en/database_design.md))
- [RESTful API 完整规范](./docs/zh-CN/api_specification.md) ([English](./docs/en/api_specification.md))
- [环境变量、Secrets 与凭据配置规范](./docs/zh-CN/configuration_and_keys.md) ([English](./docs/en/configuration_and_keys.md))
- [本地开发与部署指引](./docs/zh-CN/local_development_guide.md) ([English](./docs/en/local_development_guide.md))
