# Factory Cloud Executor

独立 Node.js 22+ Vercel 项目，使用 Vercel Sandbox microVM 执行不可变 Git commit 的检查任务。它与 NovaAgent 原有 Cloudflare Worker / Telegram 运行时隔离。

## 部署方式

在 Vercel 创建独立项目，Root Directory 设置为 `services/factory-executor`，运行时使用 Node.js 22+。

配置以下仅服务端可见的环境变量：
- `FACTORY_DATABASE_REST_URL`：Factory 专用 PostgreSQL / PostgREST URL。
- `FACTORY_DATABASE_SERVICE_KEY`：Factory 数据库 service role key。
- `CRON_SECRET`：Vercel Cron 请求认证密钥。
- `FACTORY_AUTH_SECRET`、`FACTORY_AUTH_ISSUER`、`FACTORY_AUTH_AUDIENCE`：仅旧版同步 `POST /api/execute` 端点需要。

不要把数据库 service key、Cron secret 或 JWT 签名密钥暴露给浏览器。Sandbox 使用部署环境的 Vercel OIDC，不向项目容器传递 Vercel token。

## Durable execution flow

当前推荐执行流程：

1. Cloudflare Factory API 的 `POST /api/factory/executions` 验证用户 JWT、角色、租户和输入。
2. Worker 调用 PostgreSQL RPC `factory_enqueue_execution_job`，持久化任务、commit SHA、检查集和幂等键。
3. Vercel Cron 每分钟触发 `GET /api/worker`。
4. Worker 通过 `factory_claim_execution_job` 原子领取一个任务。数据库以 `FOR UPDATE SKIP LOCKED`、租约和组织预算限制并发。
5. Sandbox 检出不可变 commit，安装依赖后关闭网络，再执行固定脚本白名单。
6. `factory_finish_execution_job` 记录结果、运行时长、工作流事件和审计事件；失败任务按上限重试。
7. Worker 崩溃或租约过期时，下一次 claim 会回收租约；达到最大尝试次数后转为终态失败。

队列语义为至少一次执行。当前运行的是纯检查任务，不做代码写入；未来加入 Coding Harness 后，文件修改、分支推送和 PR 创建必须使用独立幂等键和凭据代理。

## Database migration and budget provisioning

先在 Factory 专用 PostgreSQL 数据库按顺序执行：
- `migrations/factory/0001_control_plane.sql`
- `migrations/factory/0002_control_plane_rpc.sql`
- `migrations/factory/0003_ai_usage_budgets.sql`
- `migrations/factory/0004_durable_execution_jobs.sql`

每个组织必须显式配置执行预算；没有预算行时任务不会被领取（fail closed）。例如，给指定组织配置每月 36,000 秒、最多 2 个并发任务：

```sql
INSERT INTO factory_execution_budgets (
  organization_id, monthly_limit_seconds, max_concurrent, period_start
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  36000, 2, date_trunc('month', now())::date
)
ON CONFLICT (organization_id) DO UPDATE SET
  monthly_limit_seconds = EXCLUDED.monthly_limit_seconds,
  max_concurrent = EXCLUDED.max_concurrent,
  updated_at = now();
```

数据库预算单位为 Sandbox 执行秒，不是美元账单。每次领取先预留 240 秒；完成后按实际运行时长结算，异常过期租约按预留上限保守计入用量。月度额度在新月份首次领取任务时自动滚动重置。

## Enqueue API

`POST /api/factory/executions`

Headers:
- `Authorization: Bearer <Factory JWT>`
- `Idempotency-Key: <unique-key-at-least-8-characters>`
- `Content-Type: application/json`

Body:
```json
{
  "runId": "00000000-0000-4000-8000-000000000001",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "checks": ["type-check", "test", "build"]
}
```

`checks` 可选，默认 `type-check/test/build`。只允许 `type-check`、`test`、`build`、`lint`。仓库地址从租户内项目记录读取，调用方不能提交任意 URL 或 shell 命令。

## Legacy synchronous endpoint

`POST /api/execute` 仍保留给旧版诊断调用，使用 Factory JWT 并同步等待 Sandbox。新产品流程应使用上述 durable enqueue API，不应把同步端点作为长任务调度方案。

## Sandbox isolation

- 每个尝试使用一次性 Sandbox，Node 22 image、2 vCPU、180 秒脚本上限、`persistent: false`。
- GitHub clone 和 npm install 阶段仅允许 GitHub source hosts 与 npm registry。
- 安装后先设置 `deny-all`，再运行仓库脚本。
- 仅执行固定 npm script allowlist，不接受用户命令。
- stdout/stderr 有长度上限；finally 中停止 Sandbox。

## Validation

在 `services/factory-executor` 目录执行：

```bash
npm install
npm run type-check
npm test
```

## Not yet production-proven

代码与单元测试不能替代真实环境验收。当前仍需配置真实 Vercel 项目、PostgreSQL 迁移、Cron secret、每组织预算，并验证真实 Sandbox clone/install/egress lockdown/cleanup。尚未支持私有仓库凭据代理、Coding Harness 文件修改、GitHub 分支/PR、预览部署或生产发布。
