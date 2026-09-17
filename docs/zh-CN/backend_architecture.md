# LicenKit 后端架构与核心系统设计说明书

> **适用技术栈**：TypeScript + Hono + Drizzle ORM + Cloudflare Workers + Cloudflare D1 (SQLite) + Cloudflare KV + Cloudflare Queues  
> **定位**：现代化 API-First 纯授权中枢。可自部署开源版本（LicenKit），开箱即用支持首次 Setup 与多用户协作运行，架构天然支撑未来商业 SaaS（LicenKit-Cloud）直接引入复用。

---

## 一、 系统架构与分层设计 (LicenKit vs LicenKit-Cloud)

```mermaid
graph TD
    subgraph "LicenKit-Cloud (商业闭源 SaaS 平台)"
        CloudSaaS["云端 SaaS 控制面 (独有表: cloud_subscriptions, cloud_quotas 等)<br/>• 开发者公网开放注册<br/>• Stripe 租户套餐订阅与超额计量<br/>• 平台多租户调度网关"]
    end

    subgraph "LicenKit (可自部署开源版本)"
        SysConfig["全局实例配置 (system_settings 表)<br/>• 单行 id='current' / instance_name / app_url / api_base_url / allow_signup"]
        TenantRoot["租户主体空间 (accounts 表)<br/>• 资产边界 / 专属 Slug / 自定义白标域名 custom_domain / 支付网关密文"]
        UserDomain["自然人管理体系 (users 表)<br/>• 登录邮箱 / 密码散列 / 角色 (owner/admin/member)<br/>• 支持同一租户下多成员协作与 RBAC"]
        LicBiz["核心授权领域<br/>• products, policies, licenses, machines, crypto_keys, trials, webhooks"]
    end

    CloudSaaS -->|"直接引入并运行"| LicenKit
    SysConfig -.->|"实例基准配置"| TenantRoot
    TenantRoot --> UserDomain
    TenantRoot --> LicBiz
```

### 1. 系统配置、租户与用户分层设计 (System vs Tenant vs User)
- **`system_settings` 表（系统实例配置 - 单行单例 `id = 'current'`）**：
  - 承载自部署实例的全局运行参数：`instance_name`、`app_url`（前端控制台基准 URL）、`api_base_url`（后端 API 基准 URL）、`allow_signup`（是否开放公开注册）；
  - **前后端域名与缺省子路径规则**：
    - **缺省情况 (默认单域名同域部署，90% 场景)**：若 `api_base_url` 为 NULL 或留空，系统自动继承 `app_url`，后端 API 统一挂载在 **`${app_url}/api/v1/*`** 子路径下。前端 SPA 托管在根路径 `/*`，全栈同源，**零 CORS 跨域问题**；
    - **前后端分离情况 (10% 场景)**：若站长将前端（如部署在 Vercel `https://license.example.com`）与后端（部署在 Worker `https://api.license.example.com`）分离，显式配置 `api_base_url`，后端 API 挂载在 **`${api_base_url}/api/v1/*`**，且 Worker 自动将 `app_url` 注入为跨域预检允许的 CORS Origin；
  - **动态基准地址解耦**：系统在生成支付网关回调 URL、邮件跳转链接时动态组装，**站长更换域名无需重新发布 Worker 代码**；
  - **业务通知与邮件解耦**：系统自身零邮件协议与第三方邮件库依赖，所有客户通知与发信事件统一推入异步队列，通过出向 Webhook (`/api/v1/admin/webhooks`) 广播，由外部系统或 Resend 自动化发信；
- **`accounts` 表（租户/团队空间）**：
  - 授权资产的终极所有者，挂载 `products`, `policies`, `licenses`, `machines`, `crypto_keys`, `webhook_*`；
  - 支持租户专属 `custom_domain`（用于云端 SaaS 模式下的 CNAME 租户白标或二级域名路由）；
  - 持有租户级商业凭据：`payment_configs`（AES-256-GCM 密文集合）；
- **`users` 表（自然人管理员）**：
  - 管理后台的登录实体，通过 `account_id` 归属于特定租户；
  - 拥有 `email`、`password_hash`、`role`（`owner`、`admin`、`member`）；
  - 首次运行 `/setup` 时原子生成系统配置、初始 Account 与首个 Owner User；底层天然具备多成员协作与精细化权限管控能力。

---

### 2. 存储层门面设计 (`getTenantDB`)

```mermaid
graph TD
    subgraph "接入层 (Hono Middleware)"
        Req[外部请求] --> MW{路由与鉴权匹配}
    end

    subgraph "上下文注入 (Context Injection)"
        MW -- "Setup/登录: /system/*, /auth/*" --> PublicMW[免 Key / 密码核验]
        MW -- "管理端/脚本: Bearer <session_token>" --> AuthMW[校验管理员用户 JWT 会话]
        MW -- "支付端: /webhooks/:provider/:account_id" --> PathMW[从路径提取 account_id]
        MW -- "客户端: /client/*" --> ClientMW[从请求体提取 account_id]
        
        AuthMW --> Ctx["注入 c.set('accountId', user.accountId)"]
        PathMW --> Ctx
        ClientMW --> Ctx
    end

    subgraph "存储层门面 (D1 Routing Abstraction)"
        Ctx --> Router["getTenantDB(c, accountId)"]
        Router --> DB[(D1 数据库: licenkit_db)]
    end
```

- **LicenKit 开源自部署**：`getTenantDB(c, accountId)` 直接返回 `c.env.DB`，单库闭环，部署极简；
- **LicenKit-Cloud 商业版**：`getTenantDB` 内部可按 `accountId` 路由至不同的 D1 分片绑定（如 VIP 专属库或水平 Shard），业务代码零修改直接复用。

---

### 3. 凭据信封加密与零明文持久化

```mermaid
graph LR
    subgraph "Worker 环境变量 (Secret)"
        KEK["STORAGE_ENCRYPTION_KEY<br/>(平台 32B AES 主密钥)"]
    end

    subgraph "D1 密文存储 (持久化)"
        DB1["crypto_keys.key_material<br/>(产品 Ed25519 种子密文 - 托管或自主上传)"]
        DB2["accounts.payment_configs<br/>(支付网关配置与 Secret JSON 密文)"]
    end

    subgraph "Worker 运行时内存"
        KEK --> Decrypt["WebCrypto AES-256-GCM 解密"]
        DB1 --> Decrypt
        DB2 --> Decrypt
        Decrypt --> Mem["纯内存极速计算 (验签/出码/签发)<br/>执行完毕即被 GC 销毁"]
    end
```

- **信封加密**：支付网关配置与 Ed25519 私钥种子统一由 `STORAGE_ENCRYPTION_KEY` 通过 **AES-256-GCM** 加密后持久化；
- **零明文保证**：数据库脱库无法获取任何明文私钥或网关密钥；Worker 仅在处理对应业务时内存即时解密；
- **安全红线**：严禁将私钥明文或密文写入全球分布式 KV 边缘节点，杜绝潜在安全敞口。

---

## 二、 代码目录组织规范 (Monorepo 架构)

为了兼顾“普通用户一键部署”与“进阶用户独立二开前端 UI”，项目采用 **Monorepo** 架构进行分包，核心引擎与控制台彻底解耦：

```text
licenkit/
├── apps/
│   ├── server/                  # 【LicenKit Server】授权核心引擎 (Cloudflare Worker)
│   │   ├── src/
│   │   │   ├── index.ts         # Worker 入口 (装配 Hono 实例与 Queue Consumer)
│   │   │   ├── types.ts         # 全局环境绑定 (DB, KEYS_KV, EVENT_QUEUE, Secrets)
│   │   │   │
│   │   │   ├── domains/         # 核心业务领域
│   │   │   │   ├── system/      # 0. 系统配置与 Setup 向导 (system_settings)
│   │   │   │   ├── auth/        # 1. 用户认证域 (users)
│   │   │   │   ├── account/     # 2. 租户主体与配置域 (accounts, custom_domain)
│   │   │   │   ├── policy/      # 3. 策略域 (policies)
│   │   │   │   ├── licensing/   # 4. 许可证与设备域 (licenses, machines, trials)
│   │   │   │   └── webhook/     # 5. 双向事件流 (webhook_endpoints, webhook_events)
│   │   │   │
│   │   │   ├── queue/           # 异步出向队列派发消费者
│   │   │   ├── infra/           # 基础设施 (WebCrypto 密码学、KV 缓存、D1 门面)
│   │   │   ├── middleware/                  # 中间件 (SetupGuard, SessionAuth, ErrorHandler)
│   │   │   └── routes/          # API 路由 (/api/v1/*)
│   │   ├── wrangler.jsonc       # Worker 配置 (单域名部署时通过 assets 嵌入 apps/web 静态产物)
│   │   └── package.json
│   │
│   └── web/                     # 【LicenKit-Web】管理控制台前端 SPA (React / Tailwind / shadcn)
│       ├── src/
│       │   ├── pages/           # /setup, /login, /dashboard, /licenses, /products...
│       │   ├── components/      # 现代化 UI 组件
│       │   └── lib/api-client.ts# 统一 API 请求封装 (支持读取 VITE_API_BASE_URL)
│       ├── vite.config.ts       # 构建配置
│       └── package.json
```

- **开箱一体交付**：在 Monorepo 根目录下运行 `pnpm build && wrangler deploy`，前端打包至 `apps/web/dist` 并通过 Worker Static Assets 直出。普通用户无需额外购买服务器，**单域名同域直通 `${app_url}/api/v1/*`，零跨域摩擦**；
- **独立二开交付**：用户可单独 Fork `apps/web` 进行主题更换、品牌定制或嵌入企业内部门户，只需配置 `VITE_API_BASE_URL=https://api.yourdomain.com` 即可与 Core 独立通信。

---

## 三、 核心业务时序图

### 1. 首次进入设置密码与原子初始化开户链路 (Setup Wizard)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 开发者 / 站长
    participant Route as apps/server/routes/system.routes.ts
    participant SysSvc as SystemService
    participant D1 as c.env.DB

    Admin->>Route: 首次访问 GET /api/v1/system/status
    Route->>SysSvc: getStatus()
    SysSvc->>D1: SELECT id, instance_name, app_url, api_base_url FROM system_settings WHERE id = 'current'
    SysSvc-->>Route: 返回 { initialized: false }
    Route-->>Admin: 前端引导呈现 /setup 首次设置页面

    Admin->>Route: POST /api/v1/system/setup { instance_name, app_url, api_base_url, account_name, slug, admin_name, admin_email, admin_password }
    Route->>SysSvc: setupInstance(input)
    SysSvc->>D1: 再次检查 system_settings 是否已存在 (并发加锁防刷)
    alt 已存在记录
        SysSvc-->>Route: 抛出 InstanceAlreadyInitialized 异常
        Route-->>Admin: 403 Forbidden
    else 确认未初始化
        Note over SysSvc: 若 api_base_url 为空，系统自动缺省继承 app_url (挂载在 ${app_url}/api/v1/*)
        SysSvc->>SysSvc: 生成全局唯一的 account_id (acc_...)
        SysSvc->>SysSvc: WebCrypto PBKDF2 计算 admin_password 散列
        SysSvc->>SysSvc: 生成首位用户 user_id (usr_...)
        
        Note over SysSvc,D1: 【原子事务落盘】：同时创建 SystemSettings、Account 与 Owner User
        SysSvc->>D1: db.batch([insertSystemSettings, insertAccount, insertUser(role='owner')])
        
        SysSvc->>SysSvc: 签发管理员 Session JWT (包含 user_id 与 account_id)
        
        SysSvc-->>Route: 返回初始化成功报文
        Route-->>Admin: 201 Created + session_token
        Note over Admin: 站长直接进入控制台
    end
```

---

### 2. 专属支付网关回调出码与出向广播链路

```mermaid
sequenceDiagram
    autonumber
    actor Gateway as 支付网关 (Stripe/Paddle)
    participant Route as routes/webhook.routes.ts
    participant Inbound as InboundWebhookService
    participant D1 as getTenantDB(c, accountId)
    participant Queue as EVENT_QUEUE
    participant Consumer as EventConsumer
    actor TenantEndpoint as 接收端点 (开发者自有系统/Zapier)

    Gateway->>Route: POST /api/v1/webhooks/stripe/acc_01J8X9... (带 Stripe-Signature)
    Route->>Inbound: handleWebhook('stripe', 'acc_01J8X9...', header, rawPayload)
    
    Inbound->>D1: 查询 accounts WHERE id = 'acc_01J8X9...'
    Inbound->>Inbound: WebCrypto AES-256-GCM 解密 payment_configs 出明文 webhook_secret
    Inbound->>Inbound: 恒定时间验证 Stripe HMAC 签名

    Inbound->>D1: SELECT status FROM webhook_events WHERE account_id = ? AND provider = 'stripe' AND event_id = ? AND direction = 'inbound'
    alt event 已存在且 status == 'processed'
        Note over Route,Gateway: 重复投递，幂等返回 200 阻断网关无休止重试
        Route-->>Gateway: 200 OK
    else 新事件 或 上次未完成
        Note over Inbound,D1: 【原子事务：向对应租户写入 License 并记录 processed 事件】
        Inbound->>D1: db.batch([insertInboundEvent, insertLicense(account_id, ...), markEventProcessed])
        
        alt 数据库事务成功
            Note over Inbound,D1: 查询匹配该产品的 N 个 Webhook 端点，批量写入 N 条 outbound 记录
            Inbound->>D1: 插入 N 条 webhook_events (direction='outbound', endpoint_id=whe_xxx, status='pending')
            Inbound->>Queue: 批量向 EVENT_QUEUE 发送 N 条派发任务 { event_id: 'evt_xxx', endpoint_id: 'whe_xxx' }
            Route-->>Gateway: 200 OK (支付完成确认)

            Note over Queue,Consumer: 【出向事件可靠广播】：各端点异步独立投递与重试
            Queue->>Consumer: 派发广播任务
            Consumer->>TenantEndpoint: POST https://api.mysite.com/webhooks (带 X-LicenKit-Signature)
            TenantEndpoint-->>Consumer: 200 OK (成功更新对应 evt 记录为 processed)
        else 数据库事务失败
            Inbound->>D1: UPDATE webhook_events SET status = 'failed'
            Route-->>Gateway: 500 Internal Server Error (保活支付网关退避重试)
        end
    end
```

---

### 3. 客户端硬件指纹激活抢座链路

```mermaid
sequenceDiagram
    autonumber
    actor Client as 客户端软件 (首次联网)
    participant Route as routes/client.routes.ts
    participant MacService as MachineService
    participant LicService as LicenseService
    participant D1 as getTenantDB(c, accountId)

    Client->>Route: POST /api/v1/client/activate { account_id, license_key, fingerprint, platform, name }
    Route->>MacService: activate(account_id, license_key, fingerprint, ...)
    
    MacService->>D1: 查询 License 实体及其关联的 Policy (包含 max_machines, scheme, offline_grace_period)
    
    alt 许可证状态不是 active 或已过期/吊销 (revoked)
        MacService-->>Route: 抛出 LicenseInactive 异常
        Route-->>Client: 403 Forbidden
    end

    alt 当前机器指纹已激活该许可证
        MacService-->>LicService: 获取有效凭证 (Token 或在线核验)
    else 占用新席位 (一期固定席位原子抢占)
        Note over MacService,D1: 【原子条件写入】：单句检查并抢占席位
        MacService->>D1: INSERT INTO machines (...) SELECT ..., 'mac_xxx' WHERE (SELECT COUNT(*) FROM machines WHERE license_id = ?) < policy.max_machines
        alt rows_affected == 0 (席位已满)
            MacService-->>Route: 抛出 SeatLimitExceeded 异常
            Route-->>Client: 409 Conflict: SEAT_LIMIT_EXCEEDED
        end
    end

    alt policy.scheme == 'ed25519' (离线签名模式)
        MacService->>LicService: signToken(license, fingerprint, policy.offline_grace_period)
        LicService->>D1: 读取当前产品活跃 Ed25519 密钥材料密文
        LicService->>LicService: WebCrypto 纯内存通过 STORAGE_ENCRYPTION_KEY 解密私钥
        LicService->>LicService: 纯内存签发含离线宽限期 exp 的 Ed25519 Token
        LicService-->>Client: 200 OK + { scheme: "ed25519", token: "header.claims.sig", token_expires_at, ... }
    else policy.scheme == 'guid' (纯在线核验模式)
        LicService-->>Client: 200 OK + { scheme: "guid", valid: true, license_expires_at, ... }
    end
```
