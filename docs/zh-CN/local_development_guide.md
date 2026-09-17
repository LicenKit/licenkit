# LicenKit 本地开发与运行调试指南

> 本指南将引导你在本地完全零成本搭建、启动和调试 **LicenKit**（开源自部署版）的完整 Monorepo 全栈环境。  
> 底座基于 **TypeScript + Hono + Cloudflare Workers (Local Miniflare/workerd) + D1 (SQLite) + Cloudflare Queues + React 19 + Vite**。

---

## 一、 环境依赖与准备工作

在开始之前，请确保本地已安装以下基础工具链：

| 依赖项 | 建议版本 | 校验命令 | 说明 |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 20.x` (推荐 `22.x` / `24.x`) | `node -v` | 支持原生 WebCrypto 与现代 ES 规范 |
| **pnpm** | `>= 9.x` / `10.x` | `pnpm -v` | Monorepo 多包管理工具 |
| **Git** | 最新稳定版 | `git --version` | 版本控制与工作流提交 |
| **Cloudflare Wrangler** | `>= 3.100` / `4.x` | `npx wrangler --version` | 本地通过 Miniflare 极速模拟 D1/KV/Queues |

### 1. 克隆代码与安装依赖
在项目根目录 `/Users/mixbayes/Projects/LicenKit` 下执行：

```bash
# 安装根目录及 apps/server, apps/web 全部工作区依赖
pnpm install
```

---

## 二、 环境变量与本地机密配置

LicenKit 核心遵循**凭据信封加密与零明文持久化**原则。在本地运行调试前，需要为后端服务配置本地运行时的密钥。

### 1. 配置 `apps/server/.dev.vars`
在 `apps/server` 目录下创建 `.dev.vars` 文件（该文件已被 `.gitignore` 保护，专门由 Wrangler 本地开发加载）：

```bash
cat << 'EOF' > apps/server/.dev.vars
# 平台 32 字节主加密密钥 (用于 AES-256-GCM 加密支付网关 Secret 与产品 Ed25519 私钥种子)
STORAGE_ENCRYPTION_KEY=licenkit_dev_master_storage_key_32b_!

# 管理员 Session JWT 签名秘钥
JWT_SECRET=licenkit_local_jwt_secret_development_only_123456

# 运行环境标记
ENVIRONMENT=development
APP_VERSION=1.0.0
EOF
```

> [!NOTE]
> `STORAGE_ENCRYPTION_KEY` 长度建议不少于 32 字符（系统内部会自动截取或补齐 32 字节生成 AES-GCM Key）。

### 2. 前端环境变量说明 (`apps/web`)
在本地开发模式下，前端 Vite 默认已配置反向代理：
- 前端请求以 `/api` 开头的接口时，Vite 开发服务器会自动将请求反向代理到后端 Worker (`http://localhost:8787`)；
- 因此 **无需在 `apps/web` 配置任何 `.env` 文件** 即可开箱同源直通；
- 若需要测试前后端完全跨域分离模式，可在 `apps/web/.env.local` 中显式指定：
  ```bash
  VITE_API_BASE_URL=http://localhost:8787
  ```

---

## 三、 本地数据库初始化与迁移 (Local D1)

LicenKit 在本地运行时完全使用 Wrangler 内置的 SQLite 引擎模拟 Cloudflare D1，**无需公网账号，零网络延迟**。

### 1. 执行 Drizzle 迁移初始化本地表结构
我们在项目中已基于 11 张核心表生成了标准迁移文件，直接运行以下命令将表结构应用到本地 D1 数据库：

```bash
# 将 Drizzle 迁移脚本应用至本地 D1
pnpm --filter @licenkit/server run db:migrate:local
```

终端将输出类似以下成功提示：
```text
Applying migration 0000_sloppy_green_goblin.sql...
Migration applied successfully!
```

### 2. （可选）使用原始 SQL 初始化本地 D1
你也可以直接将 `docs/schema.sql` 应用到本地 D1：
```bash
npx --prefix apps/server wrangler d1 execute licenkit-db --local --file=../../docs/schema.sql
```

### 3. 查看本地数据库内容
若要查看本地 D1 中的表或直接执行 SQL：
```bash
npx --prefix apps/server wrangler d1 execute licenkit-db --local --command="SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 四、 本地启动与联合调试

### 1. 一键启动全栈双端联动模式（推荐）
在项目根目录下直接运行：

```bash
pnpm run dev
```

该命令将并发启动：
1. **`@licenkit/web` (前端 Vite)**：运行于 `http://localhost:5173`，支持毫秒级 HMR 热更新；
2. **`@licenkit/server` (后端 Worker)**：运行于 `http://localhost:8787`，模拟 D1、KV、Queues 运行时。

---

### 2. 单独启动特定服务
- **仅启动后端 Worker API**：
  ```bash
  pnpm run dev:server
  # 或
  pnpm --filter @licenkit/server run dev
  ```
- **仅启动前端控制台 SPA**：
  ```bash
  pnpm run dev:web
  # 或
  pnpm --filter @licenkit/web run dev
  ```

---

## 五、 首次安装向导与联调流程 (Step-by-Step)

### 步骤 1：访问首次初始化页面
打开浏览器访问：**`http://localhost:5173`**。
1. 前端向导检测到 `GET /api/v1/system/status` 返回 `{ initialized: false }`；
2. 页面自动渲染 **SetupPage** 首次配置向导：
   - **Instance Name**：填写实例名称，如 `Local LicenKit Hub`
   - **App URL**：保持默认 `http://localhost:5173`
   - **API Base URL**：**直接留空**（验证默认单域名同源 `/api/v1/*` 零 CORS 特性）
   - **Team / Org Name**：填写默认团队，如 `DevStudio LLC`
   - **Slug**：填写团队唯一二级标识，如 `devstudio`
   - **Admin Name / Email / Password**：设置首个 Owner 超管的账号与登录密码（至少 8 位）
3. 点击 **Complete Setup & Launch Dashboard**；
4. 后端 Worker 自动执行**原子批处理**：
   - 插入 `system_settings` 单例配置；
   - 插入 `accounts` 空间主体；
   - 经 WebCrypto PBKDF2 计算密码加盐散列后插入 `users` 表；
   - 签发有效期 7 天的 Session JWT 并返回前端。

### 步骤 2：进入管理控制台 (Dashboard)
初始化完成后，前端将自动持久化 Token 并进入控制台主界面：
1. **Overview 概览**：查看产品数、许可证数、Ed25519 签名引擎状态；
2. **Gateways & Webhooks 支付网关**：
   - 查看 **Paddle (Default)** 与 **Stripe** Tab 切换；
   - 实时看到当前租户专属的回调地址：
     ```text
     http://localhost:5173/api/v1/webhooks/paddle/acc_...
     ```
   - 界面提供一键复制按钮与密文保存入口；
3. **Products / Policies / Licenses**：可创建产品、配置机器席位上限（Max Machines）、签发离线 Token 许可证。

---

## 六、 常用接口本地 cURL 联调示例

在本地开发调试客户端 SDK 或支付回调时，可直接通过 `curl` 模拟请求：

### 1. 检查系统状态 (无需鉴权)
```bash
curl -i http://localhost:8787/api/v1/system/status
```

### 2. 模拟管理员登录获取 Session Token
```bash
curl -i -X POST http://localhost:8787/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "your_password_here"
  }'
```

### 3. 模拟客户端激活设备与席位抢占 (无需登录，带 account_id)
```bash
curl -i -X POST http://localhost:8787/api/v1/client/activate \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "acc_your_account_id",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "macbook-pro-m2-sha256-fingerprint-9988",
    "platform": "darwin-arm64",
    "name": "My MacBook Pro"
  }'
```

### 4. 模拟第三方支付网关回调 (Paddle / Stripe)
```bash
curl -i -X POST http://localhost:8787/api/v1/webhooks/paddle/acc_your_account_id \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_test_paddle_001",
    "event_type": "transaction.completed",
    "data": {
      "customer": { "email": "buyer@company.com" },
      "items": [{ "price_id": "pri_123" }]
    }
  }'
```

---

## 七、 生产打包与模拟部署验证 (Build & Dry-Run)

在向 Cloudflare 部署前，在本地运行完整的打包和静态资产装配校验：

```bash
# 1. 运行全仓库 TypeScript 静态类型检查
pnpm run typecheck

# 2. 执行全栈一体化构建 (Vite 编译前端 -> Worker 打包并装配 Static Assets)
pnpm run build
```

在 `pnpm run build` 的输出中，你可以看到类似：
```text
✓ built in 617ms (dist/index.html, dist/assets/...)
✨ Read 5 files from the assets directory apps/web/dist
Total Upload: ~485 KiB / gzip: ~88 KiB
Binding: env.DB, env.KEYS_KV, env.EVENT_QUEUE, env.ASSETS...
--dry-run: exiting now.
```
这表明前端静态资源已完美嵌入 Worker 单一交付产物中。

---

## 八、 常见问题与排错手册 (Troubleshooting)

### Q1: 重新初始化或清空本地数据
若想重新测试全新部署的 `/setup` 流程：
- 方案 A（清理本地 D1 缓存）：直接删除 `apps/server/.wrangler/state/v3/d1` 目录，然后重新运行 `pnpm --filter @licenkit/server run db:migrate:local`；
- 方案 B（SQL 清空配置）：
  ```bash
  npx --prefix apps/server wrangler d1 execute licenkit-db --local --command="DELETE FROM system_settings; DELETE FROM accounts; DELETE FROM users;"
  ```
- 清除浏览器中的 `localStorage.removeItem('licenkit_token')` 并刷新。

### Q2: 提示 `cryptoKey` 或 `STORAGE_ENCRYPTION_KEY` 相关错误
- 确保 `apps/server/.dev.vars` 存在且包含 `STORAGE_ENCRYPTION_KEY`；
- 在 Cloudflare Workers 本地开发时，`.dev.vars` 会被 `wrangler dev` 自动读取并挂载到 `c.env` 上。

### Q3: 前端控制台报 `401 Unauthorized`
- 检查当前登录状态是否已过期；
- LicenKit Session JWT 默认有效期为 7 天，可在控制台右上角点击退出登录，重新输入管理员账号密码登录。
