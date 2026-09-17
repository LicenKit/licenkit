# LicenKit API 接口设计说明书

> **适用底座**：Cloudflare Workers + D1 (`DB`) + KV (`KEYS_KV`) + Queues (`EVENT_QUEUE`)  
> **定位**：现代化 API-First 纯授权中枢。可自部署开源版本（LicenKit），开箱即用支持首次 Setup 与多用户协作运行，架构天然支撑未来商业 SaaS（LicenKit-Cloud）直接引入复用。

---

## 一、 规范总览与通用约定

### 1. 通用技术约定
- **基准路径**：`/api/v1`
- **报文格式**：`application/json; charset=utf-8`
- **时间格式**：标准 ISO 8601 / RFC 3339 UTC 字符串（如 `2026-09-16T12:00:00Z`）
- **实体 ID 规范**：统一采用带语义前缀的 ULID / NanoID：
  - 租户空间：`acc_...`
  - 管理用户：`usr_...`
  - 软件产品：`prd_...`
  - 授权策略：`pol_...`
  - 激活凭据：`lic_...`
  - 机器设备：`mac_...`
  - 密钥版本：`kid_...`
  - Webhook 端点：`whe_...`
  - Webhook 事件：`evt_...`

### 2. 统一外层响应格式
```json
// 1. 单一实体成功响应 (HTTP 200 / 201)
{
  "success": true,
  "data": { ... }
}

// 2. 列表分页统一响应 (HTTP 200)
{
  "success": true,
  "data": {
    "items": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 142,
      "totalPages": 8,
      "hasNext": true
    }
  }
}

// 3. 统一错误响应 (HTTP 4xx / 5xx)
{
  "success": false,
  "error": {
    "code": "SEAT_LIMIT_EXCEEDED",
    "message": "该许可证绑定的设备数已达上限，请先在旧设备注销或前往管理后台解绑。"
  }
}
```

---

## 二、 接口权限分层与鉴权机制

| 命名空间 | 适用角色 | 鉴权方式 | 说明 |
| :--- | :--- | :--- | :--- |
| `/api/v1/system/*` | 首次部署站长 / 前端向导 | 免鉴权（受状态机严格防护） | 实例探活与首次安装向导（仅限未初始化时调用） |
| `/api/v1/auth/*` | 自然人管理员 | 免鉴权 / Session JWT | 管理员邮箱密码登录、查看当前登录态与租户资料 |
| `/api/v1/client/*` | 客户端软件 (Desktop/CLI) | 请求体 `account_id` + 指纹比对 | 客户端免登录，显式带租户 ID 保障隔离边界 |
| `/api/v1/admin/*` | 管理后台 / 脚本自动化调用 | `Authorization: Bearer <session_token>` | 自然人登录凭证 (JWT，通过 `/auth/login` 获取)，前端控制台与自动化脚本通用 |
| `/api/v1/webhooks/:provider/:account_id` | 外部支付网关回调 | 请求头签名 HMAC 验证 | 根据 URL 中 `account_id` 与 `provider` 解密网关密钥验签 |

---

## 三、 系统状态与首次安装向导接口 (System Setup API - `/api/v1/system/*`)

### 1. 检查系统初始化状态 (Get System Status)
- **请求路径**：`GET /api/v1/system/status`
- **功能描述**：前端单页应用（SPA）加载时首先调用。根据返回值决定向用户展示 `/setup` 向导页面还是 `/login` 登录界面。
- **成功响应 (Response 200 - 尚未初始化)**：
  ```json
  {
    "success": true,
    "data": {
      "initialized": false,
      "version": "1.0.0"
    }
  }
  ```
- **成功响应 (Response 200 - 已完成初始化)**：
  ```json
  {
    "success": true,
    "data": {
      "initialized": true,
      "instance_name": "ScreenStudio Licensing Hub",
      "app_url": "https://license.screenstudio.com",
      "api_base_url": "https://license.screenstudio.com", // 缺省时返回解析后的继承值
      "version": "1.0.0"
    }
  }
  ```

---

### 2. 首次进入安装向导 (Initial Setup Wizard)
- **请求路径**：`POST /api/v1/system/setup`
- **功能描述**：站长部署完成后首次打开系统时填写。在 D1 事务中**原子创建 1 条系统全局配置 (system_settings)、1 个初始 Account 与首个 Owner User**，并为该管理员直接签发初始管理员会话 Token。
- **安全防范**：**仅当 `initialized == false` 时允许调用**；一旦已有系统配置或账户记录，此接口永久硬阻断返回 `403 INSTANCE_ALREADY_INITIALIZED`，防恶意劫持。
- **请求参数**：
  ```json
  {
    "instance_name": "ScreenStudio Licensing Hub",
    "app_url": "https://license.screenstudio.com",
    "api_base_url": null, // 可选: 留空或 null 表示缺省单域名模式；若前后端分离部署可传入如 "https://api.screenstudio.com"
    "account_name": "ScreenStudio LLC",
    "slug": "screenstudio",
    "admin_name": "Alex (Founder)",
    "admin_email": "alex@screenstudio.com",
    "admin_password": "StrongAdminPassword123!"
  }
  ```
- **字段校验与缺省路径规则**：
  - `instance_name`: 1~100 字符；
  - `app_url`: 必填，合法的 HTTP/HTTPS 前端控制台基准 URL，如 `https://license.screenstudio.com`（用于生成邮件重置密码链接与 CORS 白名单）；
  - `api_base_url`: 可选，合法的 HTTP/HTTPS 后端 API 基准 URL：
    - **缺省情况 (默认单域名同域部署，90% 场景)**：留空或传 `null` 时，系统自动继承 `app_url`。API 接口统一挂载在 **`${app_url}/api/v1/*`** 子路径下（如 Webhook 路径为 `https://license.screenstudio.com/api/v1/webhooks/...`），前后端完全同源，免除一切跨域配置；
    - **前后端分离情况 (10% 场景)**：显式配置独立域名（如 `https://api.screenstudio.com`）时，API 挂载在 **`${api_base_url}/api/v1/*`**，且后端 Worker 自动将 `app_url` 注入为允许跨域的 CORS Origin；
  - `account_name`: 1~100 字符；
  - `slug`: 3~32 字符，仅限小写字母与连字符 `^[a-z0-9-]+$`（用于专属 Webhook 回调路由）；
  - `admin_name`: 1~50 字符；
  - `admin_email`: 合法邮箱格式（全库唯一用户登录账号）；
  - `admin_password`: 最少 8 字符。
- **成功响应 (Response 201)**：
  ```json
  {
    "success": true,
    "data": {
      "message": "系统初始化成功！",
      "settings": {
        "instance_name": "ScreenStudio Licensing Hub",
        "app_url": "https://license.screenstudio.com",
        "api_base_url": "https://license.screenstudio.com"
      },
      "account": {
        "id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
        "name": "ScreenStudio LLC",
        "slug": "screenstudio",
        "custom_domain": "https://license.screenstudio.com",
        "is_active": true,
        "created_at": "2026-09-16T12:00:00Z"
      },
      "user": {
        "id": "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5",
        "name": "Alex (Founder)",
        "email": "alex@screenstudio.com",
        "role": "owner"
      },
      "session_token": "eyJhbGciOiJIUzI1NiIsIn...<用于控制台界面会话的JWT>"
    }
  }
  ```

---

## 四、 自然人用户认证接口 (User Auth API - `/api/v1/auth/*`)

### 1. 管理员登录 (Login)
- **请求路径**：`POST /api/v1/auth/login`
- **功能描述**：自然人输入邮箱与密码登录控制台。
- **请求参数**：
  ```json
  {
    "email": "alex@screenstudio.com",
    "password": "StrongAdminPassword123!"
  }
  ```
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5",
        "name": "Alex (Founder)",
        "email": "alex@screenstudio.com",
        "role": "owner"
      },
      "account": {
        "id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
        "name": "ScreenStudio LLC",
        "slug": "screenstudio"
      },
      "session_token": "eyJhbGciOiJIUzI1NiIsIn...<JWT>"
    }
  }
  ```

---

### 2. 获取当前登录用户信息 (Get Profile)
- **请求路径**：`GET /api/v1/auth/me`
- **鉴权方式**：`Authorization: Bearer <session_token>`
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": "usr_01J8X9N2M4K7L8P9Q1W2E3R4T5",
        "name": "Alex (Founder)",
        "email": "alex@screenstudio.com",
        "role": "owner"
      },
      "account": {
        "id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
        "name": "ScreenStudio LLC",
        "slug": "screenstudio"
      }
    }
  }
  ```

---

## 五、 客户端接口 (Client API - `/api/v1/client/*`)

### 1. 首次无感免费试用认领
- **请求路径**：`POST /api/v1/client/trial`
- **功能描述**：新用户初次打开软件时静默调用。单台机器针对单租户下的单款产品终生只能认领一次，由 `product_trials` 表独立闭环防刷，**零污染主商业 `licenses` 库**。
- **请求参数**：
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "product_id": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "trial_claimed": true,
      "already_claimed": false,
      "expired": false,
      "claimed_at": "2026-09-17T10:00:00.000Z",
      "expires_at": "2026-10-01T10:00:00.000Z",
      "features": ["feature_a", "feature_b"]
    }
  }
  ```

---

### 2. 商业许可证激活与设备绑定
- **请求路径**：`POST /api/v1/client/activate`
- **功能描述**：用户输入商业激活码激活软件。服务端原子校验设备席位并抢占，记录硬件指纹到 `machines` 表。
- **请求参数**：
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d...",
    "platform": "darwin-arm64",
    "name": "Alex's MacBook Pro"
  }
  ```
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "activated": true,
      "reused": false,
      "machine_id": "mac_01j8x9n8k1l2m3n4p5q6r7s8t9",
      "scheme": "ed25519",
      "expires_at": "2027-09-17T10:00:00.000Z"
    }
  }
  ```
  > 注：在开启 `scheme = 'ed25519'` 完整离线签发时，响应将同时携带经产品活跃私钥签名的紧凑 Base64Url 离线数字证书字符串与离线宽限期截止时间。

---

### 3. 在线验签与探活心跳
- **请求路径**：`POST /api/v1/client/validate`
- **功能描述**：客户端联网启动时静默探活。校验许可证有效状态，刷新该机器的 `lastHeartbeatAt` 探活时间戳。
- **请求参数**：
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "valid": true,
      "expires_at": "2027-09-17T10:00:00.000Z",
      "last_heartbeat_at": "2026-09-17T10:00:00.000Z"
    }
  }
  ```

---

### 4. 本机主动注销解绑
- **请求路径**：`POST /api/v1/client/deactivate`
- **功能描述**：用户在客户端界面点击“注销此电脑”。从 `machines` 表删除该设备记录，席位立即可供新设备激活。
- **请求参数**：
  ```json
  {
    "account_id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
    "license_key": "LIC-ABCD-1234-EFGH-5678",
    "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d..."
  }
  ```
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "deactivated": true,
      "message": "Machine successfully unregistered from license"
    }
  }
  ```

---

### 5. 获取产品活跃 Ed25519 验签公钥
- **请求路径**：`GET /api/v1/client/products/:id/pubkey?accountId=<account_id>`
- **功能描述**：客户端软件在初始化或离线验签启动前调用。免管理员鉴权，公开返回该产品当前处于活跃状态（`isActive = true`）的 Ed25519 验签公钥（Base64 编码的 32 字节原始公钥），客户端可将其缓存在本地 Keychain 或本地加密存储中，后续实现 100% 断网离线验签。
- **Query 参数**：`accountId`（必填，所属租户 ID）
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
      "kid": "kid_01j8x9n4k1l2m3n4p5q6r7s8t9",
      "algorithm": "Ed25519",
      "publicKey": "BGamrP3LR8c3FJnlZr0re67VUUcJWXpe0Teg3Ly5Wxw="
    }
  }
  ```

---

## 六、 租户管理后台接口 (Tenant Admin API - `/api/v1/admin/*`)

> **鉴权头**：`Authorization: Bearer <session_token>`（管理员通过 `/api/v1/auth/login` 获取的 JWT 凭证，所有操作自动绑定当前上下文的 `accountId`）  
> **命名规范**：Admin API 的所有请求体、Query 查询参数和响应 JSON 数据均严格采用标准 **`camelCase`** 命名规范。

### 1. 实例全局与支付网关配置 (`/api/v1/admin/settings`)
> **权限要求**：实例级配置，仅限 `owner` 与 `admin` 角色访问。
- **获取系统与租户设置**：`GET /api/v1/admin/settings`
  - **成功响应 (Response 200)**：
    ```json
    {
      "success": true,
      "data": {
        "system": {
          "instance_name": "LicenKit Hub",
          "app_url": "https://license.example.com",
          "api_base_url": "https://license.example.com",
          "allow_signup": false
        },
        "account": {
          "id": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
          "name": "DevStudio LLC",
          "slug": "devstudio",
          "custom_domain": null,
          "payment_configs": {
            "paddle": { "enabled": true, "webhook_secret_masked": "••••••••9b2a" },
            "stripe": { "enabled": false, "webhook_secret_masked": "" },
            "lemonsqueezy": { "enabled": false, "webhook_secret_masked": "" }
          }
        }
      }
    }
    ```
- **更新系统设置与网关 Secret**：`PUT /api/v1/admin/settings`
  - **功能描述**：支持动态修改实例名称与基准域名，同时支持加密存储各支付网关的 Webhook Secret（服务端自动使用 `STORAGE_ENCRYPTION_KEY` 执行 AES-256-GCM 信封加密）。
  - **请求参数**：
    ```json
    {
      "instance_name": "ScreenStudio Licensing Hub",
      "app_url": "https://license.screenstudio.com",
      "api_base_url": null,
      "allow_signup": false,
      "payment_configs": {
        "paddle": {
          "enabled": true,
- **系统环境与密钥安全健康检查**：`GET /api/v1/admin/settings/env-check`
  - **功能描述**：用于控制台设置面板环境自检或自动化监控脚本。检测 Cloudflare Workers 绑定的各项基础设施（D1 `DB`、KV `KEYS_KV`、Queues `EVENT_QUEUE`）以及 Secrets（`STORAGE_ENCRYPTION_KEY`、`JWT_SECRET`）的配置强度与状态，返回各资源的健康标识与修复建议。
  - **成功响应 (Response 200)**：
    ```json
    {
      "success": true,
      "data": {
        "environment": "development",
        "version": "1.0.0",
        "all_ready": true,
        "items": [
          {
            "key": "STORAGE_ENCRYPTION_KEY",
            "label": "Storage Master Key (KEK)",
            "category": "secret",
            "required": true,
            "status": "ready",
            "description": "AES-256-GCM master key protecting payment secrets & Ed25519 private keys in database.",
            "fixHint": "Configure in apps/server/.dev.vars (local) or run 'npx wrangler secret put STORAGE_ENCRYPTION_KEY' (production)."
          },
          {
            "key": "JWT_SECRET",
            "label": "JWT Authentication Secret",
            "category": "secret",
            "required": true,
            "status": "ready",
            "description": "HMAC-SHA256 secret for signing and verifying administrator session tokens.",
            "fixHint": "Configure in apps/server/.dev.vars (local) or run 'npx wrangler secret put JWT_SECRET' (production)."
          },
          {
            "key": "DB",
            "label": "Cloudflare D1 Database",
            "category": "binding",
            "required": true,
            "status": "ready",
            "description": "Relational SQLite database for all platform state.",
            "fixHint": "Ensure [[d1_databases]] binding is active in wrangler.jsonc."
          }
        ]
      }
    }
    ```

---

### 2. 业务指标看板统计 (`/api/v1/admin/stats`)
- **获取概览统计指标**：`GET /api/v1/admin/stats`
- **成功响应 (Response 200)**：
  ```json
  {
    "success": true,
    "data": {
      "totalProducts": 3,
      "totalLicenses": 42,
      "activatedMachines": 18,
      "expiringSoon": 5
    }
  }
  ```

---

### 3. 团队成员管理 (`/api/v1/admin/users`)
- **获取当前租户成员列表**：`GET /api/v1/admin/users`
- **邀请/创建新成员**：`POST /api/v1/admin/users`
  - **请求参数**：
    ```json
    {
      "name": "Bob (Engineer)",
      "email": "bob@screenstudio.com",
      "password": "InitialPassword123!",
      "role": "admin"
    }
    ```
- **移除团队成员**：`DELETE /api/v1/admin/users/:id`（阻断删除自身或最后一个 `owner`）

---

### 4. 软件产品管理 (`/api/v1/admin/products`)
- **获取租户产品列表**：`GET /api/v1/admin/products`
  - **成功响应 (Response 200)**：
    ```json
    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
            "accountId": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
            "name": "ScreenStudio Pro",
            "description": "专业的 macOS 录屏与编辑工具",
            "trialDays": 14,
            "trialFeatures": ["feature_a", "feature_b"],
            "isActive": true,
            "createdAt": "2026-09-17T08:00:00.000Z",
            "updatedAt": "2026-09-17T08:00:00.000Z",
            "publicKey": "y2a4L9...<Base64 32B Ed25519 Public Key>",
            "kid": "kid_01j8x9n4k1l2m3n4p5q6r7s8t9"
          }
        ]
      }
    }
    ```
- **创建新软件产品**：`POST /api/v1/admin/products`
  - **功能描述**：支持平台自动生成 Ed25519 密钥对（`keyMode = "auto"`），或租户自主上传导入私钥（`keyMode = "upload"`）。**创建成功时仅返回一次私钥（`privateKey`），供管理员下载备份**。
  - **请求参数 (自动生成模式)**：
    ```json
    {
      "name": "ScreenStudio Pro",
      "description": "专业的 macOS 录屏与编辑工具",
      "trialDays": 14,
      "trialFeatures": ["feature_a", "feature_b"],
      "keyMode": "auto"
    }
    ```
  - **请求参数 (自主上传私钥模式)**：
    ```json
    {
      "name": "ScreenStudio Pro",
      "description": "专业的 macOS 录屏与编辑工具",
      "trialDays": 14,
      "trialFeatures": ["feature_a", "feature_b"],
      "keyMode": "upload",
      "privateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI...\n-----END PRIVATE KEY-----",
      "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----"
    }
    ```
  - **成功响应 (Response 201)**：
    ```json
    {
      "success": true,
      "data": {
        "id": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
        "name": "ScreenStudio Pro",
        "description": "专业的 macOS 录屏与编辑工具",
        "trialDays": 14,
        "trialFeatures": ["feature_a", "feature_b"],
        "isActive": true,
        "publicKey": "y2a4L9...<Base64>",
        "privateKey": "MC4CAQ...<仅此一次返回完整私钥>",
        "keySource": "platform",
        "kid": "kid_01j8x9n4k1l2m3n4p5q6r7s8t9"
      }
    }
    ```
- **获取单个产品详情**：`GET /api/v1/admin/products/:id`
- **更新产品基础信息**：`PATCH /api/v1/admin/products/:id`
  - **请求参数**：
    ```json
    {
      "name": "ScreenStudio Max",
      "description": "更新后的描述",
      "trialDays": 7,
      "trialFeatures": ["feature_a"],
      "isActive": true
    }
    ```
- **删除产品**：`DELETE /api/v1/admin/products/:id`
  - **安全约束**：若该产品下已存在策略或已签发过许可证，严格阻断并返回 `409 PRODUCT_IN_USE`。

---

### 5. 授权策略管理 (`/api/v1/admin/policies`)
- **创建策略模板**：`POST /api/v1/admin/policies`
  - **请求参数**：
    ```json
    {
      "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
      "name": "Professional Annual (3 Seats)",
      "duration": 31536000,
      "offlineGracePeriod": 2592000,
      "maxMachines": 3,
      "floating": false,
      "strict": true,
      "scheme": "ed25519",
      "features": ["feature_a", "feature_b"],
      "metadata": {
        "stripe_price_id": "price_1Ov4z2...",
        "paddle_price_id": "pri_01j8..."
      }
    }
    ```
  - **成功响应 (Response 201)**：返回创建成功的 Policy 详情（包含 `productName`）。
- **获取策略列表**：`GET /api/v1/admin/policies?productId=prd_xxx`
- **获取策略详情**：`GET /api/v1/admin/policies/:id`
- **更新策略模板**：`PATCH /api/v1/admin/policies/:id`
- **删除策略模板**：`DELETE /api/v1/admin/policies/:id`（若已被许可证使用，阻断返回 `409 POLICY_IN_USE`）。

---

### 6. 商业许可证全生命周期管控 (`/api/v1/admin/licenses`)
- **手动签发商业许可证**：`POST /api/v1/admin/licenses`
  - **功能描述**：管理员手动发码。自动校验关联 Product 与 Policy 的归属有效性；自动根据 Policy 的 `duration` 计算 `expiresAt`；若未传 `key` 则自动生成 16 位标准激活码（`LIC-XXXX-XXXX-XXXX-XXXX`）。
  - **请求参数**：
    ```json
    {
      "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
      "policyId": "pol_01j8x9n5u1v2w3x4y5z6a7b8c9",
      "customerEmail": "buyer@screenstudio.com",
      "key": "LIC-ABCD-1234-EFGH-5678", // 可选: 留空则系统自动生成
      "expiresAt": null, // 可选: 留空则继承策略 duration 推算，传 null 为买断永久
      "metadata": {
        "orderSource": "manual_vip_grant"
      }
    }
    ```
  - **成功响应 (Response 201)**：
    ```json
    {
      "success": true,
      "data": {
        "id": "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
        "key": "LIC-ABCD-1234-EFGH-5678",
        "customerEmail": "buyer@screenstudio.com",
        "expiresAt": "2027-09-17T10:00:00.000Z",
        "status": "active",
        "productName": "ScreenStudio Pro",
        "policyName": "Professional Annual"
      }
    }
    ```
- **多条件组合查询许可证列表**：`GET /api/v1/admin/licenses`
  - **支持 Query 参数**：
    - `page`: 默认 `1`
    - `limit`: 默认 `20`，上限 `100`
    - `productId`: 过滤指定产品
    - `policyId`: 过滤指定策略
    - `status`: 筛选 `all` | `active` | `suspended` | `revoked`
    - `customerEmail`: 精确过滤买家邮箱
    - `query`: 模糊搜索激活码或买家邮箱
  - **成功响应 (Response 200)**：
    ```json
    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
            "accountId": "acc_01j8x9n2r4z7qw8m3p5v1y6t2c",
            "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
            "productName": "ScreenStudio Pro",
            "policyId": "pol_01j8x9n5u1v2w3x4y5z6a7b8c9",
            "policyName": "Professional Annual",
            "maxMachines": 3,
            "machinesCount": 2,
            "scheme": "ed25519",
            "key": "LIC-ABCD-1234-EFGH-5678",
            "customerEmail": "buyer@screenstudio.com",
            "status": "active",
            "metadata": {},
            "expiresAt": "2027-09-17T10:00:00.000Z",
            "suspendedAt": null,
            "createdAt": "2026-09-17T10:00:00.000Z",
            "updatedAt": "2026-09-17T10:00:00.000Z"
          }
        ],
        "pagination": {
          "page": 1,
          "limit": 20,
          "totalItems": 1,
          "totalPages": 1,
          "hasNext": false
        }
      }
    }
    ```
- **查看许可证详情及绑定设备列表**：`GET /api/v1/admin/licenses/:id`
  - **成功响应 (Response 200)**：聚合返回许可证属性及所有已绑定的机器列表：
    ```json
    {
      "success": true,
      "data": {
        "id": "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
        "key": "LIC-ABCD-1234-EFGH-5678",
        "customerEmail": "buyer@screenstudio.com",
        "status": "active",
        "maxMachines": 3,
        "machinesCount": 1,
        "machines": [
          {
            "id": "mac_01j8x9n8k1l2m3n4p5q6r7s8t9",
            "licenseId": "lic_01j8x9n6d1e2f3g4h5i6j7k8l9",
            "fingerprint": "sha256:d8e8fca2dc6b1296e38f9024f0d...",
            "name": "Alex's MacBook Pro",
            "platform": "darwin-arm64",
            "ip": "203.0.113.1",
            "lastHeartbeatAt": "2026-09-17T10:30:00.000Z",
            "createdAt": "2026-09-17T10:00:00.000Z"
          }
        ]
      }
    }
    ```
- **调整许可证状态与期限**：`PATCH /api/v1/admin/licenses/:id`
  - **请求参数**：`{ "status": "suspended", "expiresAt": "2028-09-17T10:00:00Z" }`
- **一键更换激活码 (Rotate Key)**：`POST /api/v1/admin/licenses/:id/rotate-key`
  - **功能描述**：激活码泄露或客户申请换码时一键更换新 Key，**原子清退该许可证下全部旧设备席位**。
  - **请求参数**：`{ "key": "LIC-OPTIONAL-NEW-KEY" }`（留空则自动生成）
- **挂起与恢复许可证**：
  - `POST /api/v1/admin/licenses/:id/suspend`（挂起，置 status = 'suspended'）
  - `POST /api/v1/admin/licenses/:id/reinstate`（恢复，置 status = 'active'）
- **吊销作废许可证**：
  - `POST /api/v1/admin/licenses/:id/revoke`（置 status = 'revoked' 并清空全部绑定席位）
- **管理员强制解绑指定设备席位**：
  - **请求路径**：`DELETE /api/v1/admin/licenses/:id/machines/:machineId`
  - **功能描述**：管理员在控制台协助客户释放闲置或损坏电脑的占用席位。

---

### 7. 出向广播端点与事件审计 (`/api/v1/admin/webhooks`)
- **注册出向 Webhook 端点**：`POST /api/v1/admin/webhooks`
  - **请求参数**：
    ```json
    {
      "productId": "prd_01j8x9n3a1b2c3d4e5f6g7h8j9",
      "url": "https://api.mysite.com/licenkit-webhook",
      "events": ["*"]
    }
    ```
  - **成功响应 (Response 201)**：返回端点 ID 与随机生成的出向共享秘钥 `secret`。
- **查看出向端点列表**：`GET /api/v1/admin/webhooks`
- **删除出向端点**：`DELETE /api/v1/admin/webhooks/:id`
- **测试发送出向 Webhook 验证消息**：`POST /api/v1/admin/webhooks/:id/test`
  - **功能描述**：在控制台添加端点后，点击“Test”向目标 URL 实时发送一条带有真实防重放签名的 `test.ping` 探针报文，并直接返回目标服务的 HTTP 状态码、响应体与耗时（毫秒），以便排查网络与签名逻辑。
  - **成功响应 (Response 200)**：
    ```json
    {
      "success": true,
      "data": {
        "endpointId": "whe_01j8x9n3...",
        "url": "https://api.mysite.com/licenkit-webhook",
        "eventId": "evt_test_01j8...",
        "statusCode": 200,
        "durationMs": 142,
        "responseBody": "{\"ok\":true}"
      }
    }
    ```
- **查看双向 Webhook 流水审计日志**：`GET /api/v1/admin/webhooks/events?limit=50`
  - **功能描述**：查询入向支付网关与出向广播的实时派发流水，包含 Payload 报文与失败错误原因。

---

## 七、 租户专属入向支付回调 (Inbound Webhook)

### 统一路径：`POST <api_base_url>/api/v1/webhooks/:provider/:account_id`
- **控制台交互与默认渠道规范**：
  - 管理后台与初始化向导界面提供渠道切换 Tab，**默认选中 Paddle**（全球独立软件开发者的首选 Merchant of Record 渠道），支持点击自由切换至 **Stripe**；
  - 切换不同 Tab 时，界面动态展示专属 Webhook URL、一键复制按钮、对应秘钥填报表单与官方配置指引：
    - **Paddle (默认选中)**：
      - Webhook URL：`POST <api_base_url>/api/v1/webhooks/paddle/<account_id>`
      - 需填入秘钥：`Notification Secret Key`
      - 建议监听事件：`transaction.completed`、`transaction.updated`、`subscription.canceled`
    - **Stripe**：
      - Webhook URL：`POST <api_base_url>/api/v1/webhooks/stripe/<account_id>`
      - 需填入秘钥：`Signing Secret`
      - 建议监听事件：`checkout.session.completed`、`invoice.payment_succeeded`、`customer.subscription.deleted`
- **路径生成规则**：
  - **缺省同域模式**：当未配置独立 `api_base_url` 时，系统自动继承 `app_url`，接口挂载在 `${app_url}/api/v1/*` 子路径。示例：`POST https://license.screenstudio.com/api/v1/webhooks/paddle/acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C`；
  - **前后端分离模式**：当显式配置 `api_base_url` 时，示例：`POST https://api.screenstudio.com/api/v1/webhooks/paddle/acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C`。
- **支持 Provider**：`paddle`（默认）、`stripe`、`lemonsqueezy`、`custom`。
- **执行流程与状态机**：
  1. **签名验证**：
     - 从路径获取 `account_id`，从 `accounts` 表解密对应 `provider` 的 `webhook_secret`；
     - 恒定时间比对签名头部（如 `Stripe-Signature`、`Paddle-Signature`）；
  2. **精确三维幂等排重**：
     - 查询 `webhook_events WHERE account_id = ? AND provider = ? AND event_id = ? AND direction = 'inbound'`；
     - 若已存在且状态为 `processed`，立即幂等返回 `200 OK` 阻断网关重试；
  3. **原子履约事务 (D1 Batch)**：
     - 首次购买（`checkout.session.completed` / `transaction.completed`）：根据价格参数匹配 `product_id` 与 `policy_id`，生成 `licenses` 记录，插入 `webhook_events` 审计流水；
     - 订阅续费：匹配 `metadata` 对应许可证，顺延到期时间；
     - 扣款失败/退订：置状态为 `suspended`；
     - 退款/拒付争议：置状态为 `revoked` 并立即清空关联设备；
  4. **异步队列解耦广播**：
     - 成功履约后向 `EVENT_QUEUE` 发送出向任务（`license.created` 等），向支付网关快速返回 `200 OK`。

---

## 八、 出向事件广播规范 (Outbound Webhooks Specification)

### 1. 签名格式
```http
POST /webhooks/receiver HTTP/1.1
Host: api.mysite.com
Content-Type: application/json
X-LicenKit-Signature: t=1757923200,v1=9f8a2b3c4d5e6f7a8b9c...
```
- `t`: 当前派发时刻的 Unix 秒级时间戳（例如 `1757923200`）；
- `v1`: `HMAC-SHA256("${t}.${raw_body}", endpoint.secret)` 64 位小写十六进制签名；
- **防重放保护**：接收方应校验时间偏差 `Math.abs(Date.now() / 1000 - t) <= 300`（默认 5 分钟宽限窗口），超出容差范围应拒绝处理以杜绝重放攻击。

### 2. 标准报文结构
```json
{
  "id": "evt_01J8X9N9F1G2H3I4J5K6L7M8N9",
  "account_id": "acc_01J8X9N2R4Z7QW8M3P5V1Y6T2C",
  "event": "license.created",
  "created_at": "2026-09-16T12:00:00Z",
  "data": {
    "license_id": "lic_01J8X9N6D1E2F3G4H5I6J7K8L9",
    "key": "SCR-8820-ABCD-9901",
    "scheme": "ed25519",
    "product_id": "prd_01J8X9N3A1B2C3D4E5F6G7H8J9",
    "policy_id": "pol_01J8X9N5U1V2W3X4Y5Z6A7B8C9",
    "customer_email": "buyer@example.com",
    "status": "active",
    "expires_at": "2027-09-16T12:00:00Z"
  }
}
```

---

## 九、 核心业务错误码对照表

| 错误代码 (Error Code) | HTTP 状态码 | 业务场景描述 |
| :--- | :--- | :--- |
| `INSTANCE_ALREADY_INITIALIZED` | 403 Forbidden | 系统已完成初始化，禁止二次运行 setup 向导 |
| `INSTANCE_NOT_INITIALIZED` | 503 Service Unavailable | 系统尚未初始化，请先访问 /setup 设置初始租户与管理员 |
| `EMAIL_ALREADY_EXISTS` | 409 Conflict | 该邮箱已被注册 |
| `SLUG_ALREADY_EXISTS` | 409 Conflict | 该专属 Slug 已被占用 |
| `INVALID_CREDENTIALS` | 401 Unauthorized | 登录邮箱或密码错误 |
| `UNAUTHORIZED` | 401 Unauthorized | API Key 无效或未提供 Bearer Token |
| `SEAT_LIMIT_EXCEEDED` | 409 Conflict | 绑定席位已达上限，原子抢占失败 |
| `TRIAL_ALREADY_CLAIMED` | 403 Forbidden | 该机器硬件指纹已认领过试用 |
| `LICENSE_NOT_FOUND` | 404 Not Found | 激活码输入有误，数据库未命中 |
| `LICENSE_SUSPENDED` | 403 Forbidden | 许可证因扣款失败或冻结处于挂起状态 |
| `LICENSE_EXPIRED` | 403 Forbidden | 许可证已超出有效期 |
| `LICENSE_REVOKED` | 403 Forbidden | 许可证因退款争议已被吊销作废 |
| `PRODUCT_NOT_FOUND` | 404 Not Found | 产品未命中或不属于当前租户 |
| `POLICY_NOT_FOUND` | 404 Not Found | 授权策略模板未命中 |
| `MACHINE_NOT_FOUND` | 404 Not Found | 设备未命中或不属于该许可证 |
| `SIGNATURE_VERIFY_FAILED`| 400 Bad Request | 网关回调签名验证失败 |
| `INTERNAL_SERVER_ERROR`| 500 Internal Server Error | 服务端内部异常 |
