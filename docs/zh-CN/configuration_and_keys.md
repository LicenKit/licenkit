# LicenKit 环境变量、Secrets 与凭据配置规范

> **适用架构**：Cloudflare Workers + D1 (`DB`) + KV (`KEYS_KV`) + Queues (`EVENT_QUEUE`)  
> **文档版本**：v1.1.0  
> **更新时间**：2026-09-16  

---

## 一、 核心安全与设计原则

LicenKit 作为专注开发者软件商业化（机器硬件指纹绑定、离线 Ed25519 许可证签发与核验）的自托管 License Engine，在环境变量与凭据设计上遵循以下安全规范：

1. **最小权限与被动履约原则 (Principle of Least Privilege)**：
   - LicenKit 采用**被动事件驱动架构**，充当下游履约中心。用户在官方商城（Stripe / Paddle / Lemon Squeezy）完成结账后，支付平台向 LicenKit 发起 Webhook 回调。
   - 系统**仅需验证来自网关的回调真实性**，因此**严禁也不需要存储具备资金转账、退款、查看客户全量隐私的高权限网关 API Key / Secret Key（如 `sk_live_...`）**，将自托管的资金安全风险降为零。

2. **平台主密钥信封加密与零明文持久化 (Envelope Encryption)**：
   - 全局仅需在 Cloudflare Worker 中注入 32 字节主加密密钥（KEK: `STORAGE_ENCRYPTION_KEY`）。
   - 所有租户级的入向支付 Webhook 签名秘钥、各产品生成的非对称签名私钥种子，均在持久化写入 Cloudflare D1 前采用 **WebCrypto 原生 AES-256-GCM** 加密存储。
   - Worker 仅在接收 Webhook 验签或签发 License Token 的瞬间在内存中解密，执行完毕立即随垃圾回收释放，绝不在分布式 KV 或日志中泄露明文。

---

## 二、 存储安全分级与加密规范矩阵

针对系统内所有的变量、密钥、凭据与敏感字段，其**存储介质、加密算法、加密主体与安全要求**完整矩阵如下：

| 变量 / 凭据名称 | 存储位置 | 存储安全形态 | 加密算法 / 机制 | 加密保护密钥 | 说明与明文暴露策略 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`STORAGE_ENCRYPTION_KEY`** | Cloudflare Secrets | **云厂商密文保护** | Cloudflare 平台 KMS 静态加密 (Encrypted at Rest) | Cloudflare 托管 | 运行时仅注入 Worker 隔离内存，**严禁**落入日志或数据库 |
| **`JWT_SECRET`** | Cloudflare Secrets | **云厂商密文保护** | Cloudflare 平台 KMS 静态加密 (Encrypted at Rest) | Cloudflare 托管 | 仅在登录签发与 JWT 验签时在内存中使用 |
| **支付网关 Webhook 秘钥**<br>(`accounts.payment_configs`) | Cloudflare D1<br>数据库表 | 🔒 **强制应用层加密** | **AES-256-GCM**<br>(12 字节随机 IV + 密文 Base64) | `STORAGE_ENCRYPTION_KEY`<br>(平台主密钥) | **零明文持久化**：仅在验签瞬间内存解密；API 查询输出时一律掩码脱敏（如 `••••••••abcd`） |
| **产品 Ed25519 私钥种子**<br>(`crypto_keys.key_material`) | Cloudflare D1<br>数据库表 | 🔒 **强制应用层加密** | **AES-256-GCM**<br>(12 字节随机 IV + 密文 Base64) | `STORAGE_ENCRYPTION_KEY`<br>(平台主密钥) | **零明文持久化**：私钥种子绝不离开 Worker 内存，签发离线 License Token 后立即丢弃 |
| **管理员与用户登录密码**<br>(`users.password_hash`) | Cloudflare D1<br>数据库表 | 🔒 **单向慢哈希**<br>(不可逆) | **PBKDF2-HMAC-SHA256**<br>(100,000 次迭代 + 16B 随机盐) | 无需密钥<br>(防彩虹表/暴力碰撞) | **不可逆**：密码绝不明文存储，亦不可逆向解密，仅用于登录时比对计算值 |
| **出向 Webhook 共享秘钥**<br>(`webhook_endpoints.secret`) | Cloudflare D1<br>数据库表 | **明文存储**<br>(或 D1 内部隔离) | 明文随机高熵字符串 | 无 | 开发者自建端点或自动化系统需在前端查看此 Key 并配置到外部服务，作为 HMAC 签名比对 |
| **产品 Ed25519 公钥**<br>(`crypto_keys.public_key`) | Cloudflare D1<br>& KEYS_KV | **公开明文** | Base64 字符串 | 无 (公开信息) | 非对称加密公钥本质公开，用于内置到客户端程序或 SDK 验证离线证书签名 |
| **普通环境变量与系统配置**<br>(`ENVIRONMENT`, `APP_VERSION`, `app_url` 等) | `wrangler.jsonc`<br>& D1 `system_settings` | **公开明文** | 明文存储 | 无 | 实例运行环境标识与 URL 配置，属于非敏感元数据 |

---

## 三、 Cloudflare Worker 基础运行时配置

配置定义在后端项目根目录 [`apps/server/wrangler.jsonc`](file:///Users/mixbayes/Projects/LicenKit/apps/server/wrangler.jsonc) 中。

### 1. 基础设施资源绑定 (Cloudflare Bindings)

| 绑定名称 (Binding) | 资源类型 | 配置键名 / ID | 作用与职责 |
| :--- | :--- | :--- | :--- |
| `DB` | Cloudflare D1 (SQLite) | `licenkit-db` | 存储多租户数据、许可证、策略、机器席位及加密凭据 |
| `KEYS_KV` | Cloudflare KV | `licenkit-kv-placeholder` | 边缘只读公钥与轻量级全局状态快速索引 |
| `EVENT_QUEUE` | Cloudflare Queues | `licenkit-event-queue` | 异步削峰、出向 Webhook 事件广播与重试投递队列 |
| `ASSETS` | Cloudflare Workers Assets | `../web/dist` | 托管 React 单页管理控制台（SPA）前端静态资源 |

### 2. 普通文本变量 (Vars - 非敏感)

定义在 `wrangler.jsonc` 的 `vars` 属性中：

```jsonc
"vars": {
  "ENVIRONMENT": "development", // 运行环境: development | production
  "APP_VERSION": "1.0.0"        // 系统版本号
}
```

### 3. 敏感运行时密钥 (Secrets - 严禁进入版本库)

通过 Cloudflare 密钥体系注入，本地开发在 [`apps/server/.dev.vars`](file:///Users/mixbayes/Projects/LicenKit/apps/server/.dev.vars) 中指定，生产环境通过 CLI 注入：

| Secret 变量名 | 推荐长度与格式 | 本地配置载体 | 生产环境设置命令 | 作用与安全影响 |
| :--- | :--- | :--- | :--- | :--- |
| `STORAGE_ENCRYPTION_KEY` | 32 字节高熵随机字符串 | `apps/server/.dev.vars` | `npx wrangler secret put STORAGE_ENCRYPTION_KEY` | **平台最高主加密密钥 (KEK)**<br>保护数据库内所有支付网关 Webhook 秘钥与产品 Ed25519 私钥种子 |
| `JWT_SECRET` | 32 字节高熵随机字符串 | `apps/server/.dev.vars` | `npx wrangler secret put JWT_SECRET` | **控制台 Session 鉴权密钥**<br>用于管理员登录鉴权生成的 Session Token（HMAC-SHA256） |

```bash
# 生成高熵随机主密钥并注入 Cloudflare 示例
openssl rand -hex 16 | npx wrangler secret put STORAGE_ENCRYPTION_KEY
openssl rand -hex 16 | npx wrangler secret put JWT_SECRET
```

---

## 四、 多租户入向支付网关凭据规范

入向支付凭据由租户在管理后台（或首次安装时）按需配置，存储在 D1 数据库 `accounts.payment_configs` 中（整个 JSON 由 `STORAGE_ENCRYPTION_KEY` 采用 AES-256-GCM 整体加密）。

### 1. 字段模型与数据结构

```typescript
// 解密后于内存中存在的标准数据结构
export interface PaymentConfigs {
  paddle?: {
    enabled: boolean;
    webhook_secret: string; // Paddle Notification Secret Key
  };
  stripe?: {
    enabled: boolean;
    webhook_secret: string; // Stripe Webhook Signing Secret
  };
  lemonsqueezy?: {
    enabled: boolean;
    webhook_secret: string; // Lemon Squeezy Signing Secret
  };
}
```

### 2. 各渠道配置对照表

| 支付服务商 | 需要填写的唯一凭据 | 对应官方控制台位置 | 签名请求头 | 验签算法 |
| :--- | :--- | :--- | :--- | :--- |
| **Stripe** | `webhook_secret`<br>(Stripe 官方 Signing secret) | **Developers** -> **Webhooks** -> 选取端点 -> **Signing secret** | `Stripe-Signature` | HMAC-SHA256 校验时间戳与内容 |
| **Paddle Billing** | `webhook_secret`<br>(Paddle 官方 Secret Key) | **Notifications** -> **Notification Settings** -> **Secret Key** | `Paddle-Signature` | HMAC-SHA256 校验时间戳与 Hash |
| **Lemon Squeezy** | `webhook_secret` | **Settings** -> **Webhooks** -> 新建端点 -> **Signing Secret** | `X-Signature` | HMAC-SHA256 散列值比对 |

### 3. API 交互与安全响应规范

- **获取配置 (`GET /api/v1/admin/settings`)**：
  服务端解密后仅输出脱敏字符串，**绝不回显完整明文**：
  ```json
  {
    "payment_configs": {
      "paddle": { "enabled": true, "webhook_secret_masked": "••••••••9b2a" },
      "stripe": { "enabled": true, "webhook_secret_masked": "••••••••5f1c" },
      "lemonsqueezy": { "enabled": false, "webhook_secret_masked": "" }
    }
  }
  ```
- **更新配置 (`PUT /api/v1/admin/settings`)**：
  仅需传入变更的渠道对象，后台自动与数据库已有解密配置执行 Merge：
  ```json
  {
    "payment_configs": {
      "stripe": {
        "enabled": true,
        "webhook_secret": "<your_stripe_webhook_signing_secret>"
      }
    }
  }
  ```

---

## 五、 授权核心非对称加密密钥 (Ed25519)

用于实现客户端离线验签与硬件席位绑定的产品核心密钥对，由系统自动生成，存储在 D1 数据库 `crypto_keys` 表中。

| 字段名称 | 存储形态 | 安全等级 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `publicKey` | Base64 字符串 | **公开 (Public)** | 32 字节 Ed25519 公钥。直接内置于客户端 SDK、嵌入产品程序或分发给用户用于验证离线 License Token。 |
| `keyMaterial` | AES-256-GCM 密文字符串 | **绝密 (Secret)** | 32 字节 Ed25519 私钥种子。入库前强制由平台主密钥 `STORAGE_ENCRYPTION_KEY` 加密，仅在发码或在线探活换发离线 Token 时解密使用。 |

---

## 六、 出向事件广播 Webhook 密钥 (Outbound Webhooks)

用于向开发者自建系统、Resend 自动化发信平台或 Zapier 广播发码、暂停、解绑等业务事件，配置存储在 D1 数据库 `webhook_endpoints` 表中。

| 字段名称 | 存储形态 | 作用说明 |
| :--- | :--- | :--- |
| `url` | 明文 HTTPS URL | 接收广播事件的外部 Webhook 端点地址 |
| `secret` | 随机生成的高熵字符串 | 开发者自建端点用于校验请求的共享密钥。LicenKit 发起 HTTP POST 投递时，在请求头携带 `X-LicenKit-Signature`（根据 `secret` 对原始 Payload 计算的 HMAC-SHA256 签名） |

---

## 七、 完整配置落地检查清单 (Checklist)

部署或迁移 LicenKit 实例时，只需确认以下清单：

- [ ] **Cloudflare Secrets 配置**
  - [ ] 已设置 `STORAGE_ENCRYPTION_KEY`（生产：`npx wrangler secret put STORAGE_ENCRYPTION_KEY`）
  - [ ] 已设置 `JWT_SECRET`（生产：`npx wrangler secret put JWT_SECRET`）
- [ ] **Cloudflare 资源绑定配置**
  - [ ] `DB` (D1) 已绑定且已执行数据库迁移（`npm run db:migrate:remote`）
  - [ ] `EVENT_QUEUE` (Cloudflare Queues) 生产者与消费者已就绪
  - [ ] `KEYS_KV` 命名空间已绑定
- [ ] **支付入向 Webhook 配置（按需开启）**
  - [ ] 如使用 Stripe：仅需配置其 Webhook Signing Secret
  - [ ] 如使用 Paddle：仅需配置其 Notification Secret Key
  - [ ] 如使用 Lemon Squeezy：仅需配置其 Signing Secret
- [ ] **出向通知（邮件/自动化）配置**
  - [ ] 在控制台添加接收端点 URL 与接收事件（如 `license.created`），由外部接收端点或 Resend 处理最终用户邮件发送。
