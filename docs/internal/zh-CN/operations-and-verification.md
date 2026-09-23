# 实现验证与发布检查

本文用于本地开发、远程 D1 验证和 Cloudflare 发布验收。命令成功只能证明对应边界，不应被表述为生产闭环。

## 1. 工程边界

- 根 `wrangler.jsonc` 是 Worker、D1、Assets、Cron 和 Observability 的部署来源；
- `apps/server` 是 Hono/Workers API 与 Scheduled Handler；
- `apps/admin` 构建到 `dist/admin`；
- `custom/site` 存在时选择完整自定义 Customer Site，否则使用模板站点；
- Customer Site 仍由使用方实现和验收，不是 Admin 的一部分；
- 当前数据库从唯一初始 migration 建立，不执行旧数据升级。

## 2. 本地命令

```bash
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

分包命令：

```bash
corepack pnpm --filter @licenkit/server run typecheck
corepack pnpm --filter @licenkit/server run test
corepack pnpm --filter @licenkit/admin run typecheck
corepack pnpm --filter @licenkit/admin run test
corepack pnpm --filter @licenkit/cli run typecheck
corepack pnpm --filter @licenkit/cli run test
```

`pnpm run build` 会清理构建输出、构建 CLI/Admin，并用 Wrangler dry-run 生成 Worker 产物。它不部署远程资源。

## 3. 配置

### 3.1 Worker Secrets

至少包括：

- `INITIAL_SETUP_TOKEN`：首次 Setup 的一次性部署 Secret；
- `SECRET_ENCRYPTION_KEY`：加密 Provider 凭据、邮件变量和受限载荷；
- `TURNSTILE_SECRET_KEY`：Customer Magic Link 等公开入口验证。

Provider Webhook Secret、API Secret 和 Email API Key 通过 Admin 加密进入 D1，不写进 `wrangler.jsonc`、前端环境变量、日志或文档示例。

### 3.2 Worker Variables

非敏感变量由根 `wrangler.jsonc` 管理。测试和正式环境使用相同模块、API 与流程，差异只来自部署配置和 Provider 环境。

Setup 中的 `admin_api_url` 必须与实际访问 Setup 的 Worker Origin 一致；`customer_site_url` 是用户自己的官网或 Customer Portal 地址。两者保存在 Instance 中，必须同协议、同可注册站点；正式环境及普通域名必须为 HTTPS。仅显式非正式环境的 `localhost` 与 `127.0.0.1` 允许 HTTP，IPv6 loopback 不支持。远程验收要用真实 Admin/API Host 和 Customer Site Origin 验证 Instance 解析、Customer 预检、带 Cookie 请求和错误响应，并验证同 Origin GET 在浏览器不携带 Origin 时仍可读取，同时确认 Admin、Client、Webhook 路径没有 Customer CORS Header。

Customer Session 的 `last_seen_at` 是非关键遥测：仅最终 2xx best-effort 更新。失败日志使用 `CUSTOMER_SESSION_LAST_SEEN_UPDATE_FAILED`，包含 `requestId`、`instanceId`、`sessionId`、底层错误类型、受限长度的错误码与脱敏消息；不得记录 Cookie、Token、SQL bind 或请求包体，且不得覆盖业务响应。

### 3.3 客户端与站点变量

公开命名统一为：

```text
LICENKIT_INSTANCE_ID
VITE_LICENKIT_INSTANCE_SLUG
```

JSON 使用 `instance_id/instance_slug`，TypeScript 使用 `instanceId/instanceSlug`，Swift 使用 `instanceID/instanceSlug`，CLI 使用 `--instance`，Signed License Token 使用 `ins`。

不配置或接受旧别名。配置 `instance_id` 时不能用公开 Slug 代替，反之亦然。

### 3.4 Cloudflare Bindings

根配置至少声明：

- D1 binding `DB`；
- Admin 静态 Assets；Customer Site 由使用方独立部署；
- 每分钟 Scheduled Trigger；
- Workers Observability `enabled: true`。

Observability 只让 Deployment 级异常可在平台查看，不把它们写成 Instance System Issue。

## 4. 数据库迁移

### 4.1 本地空库

```bash
corepack pnpm run db:migrate:local
```

验证：

1. 唯一初始 migration 成功；
2. 所有目标表、索引和 Trigger 存在；
3. 不存在旧租户表、旧设置表或 User 全局状态列；
4. `deployment_bootstrap`、User、Instance、Membership 与 Invitation 都为空；
5. `PRAGMA foreign_key_check` 无结果；
6. `PRAGMA integrity_check` 返回 `ok`。

### 4.2 真实远程 D1

```bash
corepack pnpm run db:migrate:remote
```

远程验收不能被本地 SQLite 代替。至少读取 migration bookkeeping、表/索引/Trigger、空 Bootstrap 状态，并执行一个可丢弃环境的 Setup 与登录闭环。Schema 不兼容时应新建数据库或设计明确前向迁移，不能绕过失败 migration。

## 5. Setup 验收

### 5.1 Token 验证

- 未配置 Secret 返回明确配置错误；
- 错 Token 被拒绝；
- Origin 不匹配被拒绝；
- 响应有 `Cache-Control: no-store`；
- 请求不会写数据库或记录 Token；
- 刷新页面后必须重新输入。

### 5.2 三步界面

三个步骤使用独立布局：验证 Token、创建 User、创建 Instance。第二、三步只在浏览器内存收集，最终通过一次 `POST /api/v1/setup` 提交。

检查字段和文案没有把显示名称当登录名，没有要求实例标识参与登录，也没有显示第二个 Instance 或切换入口。

### 5.3 原子提交

成功后检查：

- 恰好一个 User；
- 恰好一个 active Instance；
- 一条 active Owner Membership；
- 一条只绑定 User 的 Session；
- 一条 instance scope Setup 审计；
- `deployment_bootstrap(singleton_key='deployment')` 一条完成记录。

并发最终提交只能一个成功。故障注入后不得出现半个 User、Instance、Membership、Session 或完成记录。

## 6. Admin 身份与权限

### 6.1 登录

- 请求只包含邮箱和密码；
- 邮箱大小写规范化；
- 无 active Membership 的 User 不能进入 Instance；
- Session 不保存长期可信的角色；
- 每次业务请求读取当前 Membership；
- Cookie 和 CSRF 合同按 Origin、Header、Cookie 和 Session Hash 完整校验。

### 6.2 Profile

- 邮箱只读，没有修改 API；
- 显示名称只影响当前 User；
- 密码修改要求当前密码；
- 修改密码后当前 Session 保留，其他 Admin Session 全部撤销；
- 被撤销 Session 无法访问任何 Instance；
- 身份变更写 identity scope 审计。

### 6.3 Membership

- Owner 可以调整角色、disabled/active 和 removed；
- Admin/Member/Viewer 沿用既有业务权限矩阵；
- Owner 不能修改其他 User 资料或密码；
- 两个 Owner 并发降级、暂停或移除时最多一个成功；
- 最终至少一个 active Owner，失败保留 `LAST_ACTIVE_OWNER_REQUIRED`。

### 6.4 Invitation

- pending 邀请不创建 User 或 Membership；
- 邮件使用当前 Instance Integration；
- URL Token 位于 Fragment，页面立即清理且只在内存保管；
- 已存在 User 先认证且邮箱匹配；
- 新 User 自己设置密码；
- 接受、Membership、可选 User/Session 和审计原子提交；
- 重复/撤销/过期/并发接受无副作用；
- 重新发送使旧 Token 立即失效。

## 7. Instance 隔离

至少建立两个测试 Instance 和重叠对象 ID，验证：

- Admin、Customer、Client、Webhook 都不能跨 Instance 读取或修改；
- 唯一约束允许不同 Instance 使用相同业务 Slug/外部 ID，只在本 Instance 冲突；
- 复合外键拒绝跨 Instance Customer/Product/Plan/License/Delivery 关联；
- Webhook 由路径中的 `instance_slug` 先解析 Instance；
- Signed License Token 的 `ins` 不匹配返回 Instance 专用错误；
- CLI/SDK 不接受旧 Claim 或旧参数。

当前自部署 UI 仍只展示唯一 Instance，状态只读。

## 8. Customer Magic Link

验收至少覆盖：

1. Token 明文不入库、不入日志、不入查询参数和持久化存储；
2. 同一有效 Token 正常消费只创建一个 Customer Session；
3. 两个并发消费最多一个成功；
4. 失败请求返回 `CUSTOMER_LOGIN_CHALLENGE_NOT_CONSUMABLE` 的可追踪链路；
5. 失败批次不留下额外 Session、审计或 Delivery 变化；
6. 过期或已撤销 Token 同样无副作用；
7. Customer Site 的 Fragment 处理由使用方站点实际验收，服务端测试不能替代页面验收。

## 9. 支付与宽限期

### 9.1 Provider 与 Webhook

- Sandbox 和 Live 走同一代码和 API；
- 以原始 Body 验签；
- 幂等身份包含 Instance；
- Price 必须存在唯一 Offer Mapping；
- Provider/API 错误保留原始状态、代码和经过必要脱敏的详情；
- 重复或乱序 Event 不重复签发，也不让旧状态覆盖新状态。

### 9.2 宽限期快照

依次验证：

1. Product 默认 `payment_grace_seconds=0`；
2. 创建订阅 Plan 时固化 Product 当前值；
3. 非订阅 Plan 强制为 `0`；
4. 签发支付订阅 License 时固化 Plan 当前值；
5. 修改 Product 不改变已有 Plan/License；
6. 修改 Plan 不改变已有 License；
7. 手动订阅、买断和固定期限 License 的值为 `0`。

## 10. Email 与 Scheduled Worker

### 10.1 Email

- Delivery 在 Provider 调用前持久化；
- Customer 与 Invitation 收件人约束正确；
- `accepted` 只表示 Provider 接受；
- 自动尝试总次数包含第一次请求；
- 配置错误、Provider 错误、过期和取消分别保存；
- 敏感变量按状态和保留期清除；
- 人工再次发送创建新 Delivery。

### 10.2 Scheduler

Scheduled Worker 必须按 Instance 分页领取任务，并使用 Instance 条件完成租约与更新。系统不保存最近成功时间，也不因调度异常禁用 Admin 产品操作。

远程发布后在 Cloudflare 验证：

- Cron Trigger 已绑定；
- Cron Events 有执行记录；
- Workers Logs 可看到顶层异常和请求 ID；
- `system_issues` 只出现带非空 `instance_id` 的业务错误；
- Worker/D1/绑定/Cron 顶层错误没有伪装成 Instance Issue。

## 11. Readiness 与日志

Readiness 只报告服务是否能处理请求所必需的绑定和数据库访问，不读取 System Issue 或 Scheduler 最近成功时间作为门禁。

日志允许记录：请求 ID、Instance ID、路由、稳定错误码、外部状态和必要脱敏详情。禁止记录密码、Setup Token、Session/CSRF 明文、Magic Link/Invitation Token、Registration Key、Machine Token、Provider Secret 或完整敏感载荷。

错误响应和日志应保留原始原因链；只脱敏必要字段，不能把完整包体统一隐藏或把不同错误归一成无法定位的通用错误。

## 12. 发布检查

发布前：

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
git diff --check
```

发布后还要独立确认：

1. 实际 Worker 版本和预期提交/产物一致；
2. 远程 D1 migration 已应用；
3. Admin、API 和 Assets 可访问；
4. Observability、Cron Trigger、Cron Events 和 Workers Logs 生效；
5. Setup 或登录、Membership 权限、Customer Magic Link、Webhook 幂等至少各有一条目标环境证据；
6. Customer Site 由实际使用方站点完成页面与路由验收。

本地测试、dry-run、部署成功回执和生产业务闭环是四类不同证据，报告时必须分别说明。
