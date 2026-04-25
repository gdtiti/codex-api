# Codex API 容器部署方案

## 1. 部署目标

目标机器：

部署设计应优先考虑：

- 简单
- 可持久化
- 易回滚
- 易于保存凭证与运行数据

不应过早为多节点规模化优化。

## 2. 部署拓扑

当前 `codex-api` 项目为前后端一体设计（静态前端资源内置于 `static` 目录中），因此部署拓扑极为简单：

1. 一个 `codex-api` 应用容器（同时提供 API 服务与承载 Admin 静态页）
2. 一个可选的反向代理容器
3. 挂载持久化宿主机卷，用于运行数据和日志存储

建议模式：

- 单主机
- 单应用副本
- 文件数据存储

不建议一开始就采用 Kubernetes 或外部集中式数据库，单节点部署足以应对早期流量并可避免状态一致性问题。

## 3. 容器镜像策略

建议的镜像方向：

- 基础镜像：Node.js 24 Debian slim
- 目标架构：`linux/arm64`
- 使用 multi-stage build

由于前后端一体，我们在 `runtime` 阶段需要将 `dist` 和 `static` 目录都复制到最终镜像中：

1. `deps` 阶段安装完整依赖用于构建
2. `build` 阶段编译 TypeScript 并准备 `static` 及 `dist`
3. `prod-deps` 阶段仅安装生产依赖
4. `runtime` 阶段仅保留运行环境，复制 `dist`、`static` 与生产环境的 `node_modules`
5. 运行用户切换为非 root 的 `node`
6. 镜像内置 `/health` 健康检查

## 4. 文件系统布局

容器内应将以下路径视为持久化目录：

- 业务数据和凭证存储目录
- 运行日志目录

建议的持久化挂载点：

- `/app/data`
- `/app/logs`

## 5. 反向代理

建议代理选择：

- `Caddy` 或 `Nginx`

职责：

- TLS 终止
- 请求体大小限制

由于应用是前后端一体化设计，你只需要代理这一个端口（如 3000）。前端 UI 将通过 `/` 根目录访问，而 API 将通过特定的前缀（如 `/api` 或是 `/v1`）访问，这极大降低了代理转发的配置复杂度。

## 6. 运行时配置

容器运行配置应统一走环境变量（不要把敏感信息写进镜像）。

典型变量：

- `NODE_ENV=production`
- `PORT=3000`
- `HOST=0.0.0.0`
- `ADMIN_PASSWORD` (管理后台密码)
- `LOG_LEVEL=info`

建议的注入方式是通过 Compose 的 `.env`。当前 Compose 默认约定：

- 容器内监听端口：`PORT`
- 宿主机暴露端口：`HOST_PORT`

## 7. 健康检查与重启策略

容器应暴露健康探针：

- `GET /health` 检查进程与路由是否可达

建议重启策略：

- `unless-stopped`

## 8. 当前可执行部署步骤

### 1. 准备环境文件

```bash
cp .env.example .env
```

按实际情况修改：
- `ADMIN_PASSWORD`
- `HOST_PORT` (如果需要自定义映射端口)

### 2. 构建并启动

在 OCI ARM 机器上直接构建：

```bash
docker compose up -d --build
```

如果需要显式构建 ARM64 镜像：

```bash
docker buildx build --platform linux/arm64 -t codex-api:local .
```

### 3. 检查服务状态

```bash
docker compose ps
docker compose logs -f codex-api
curl http://127.0.0.1:${HOST_PORT:-3000}/health
```

### 4. 数据持久化位置

- 宿主机 `./data`
- 宿主机 `./logs`

### 5. 更新发布

```bash
docker compose up -d --build
```

### 6. 回滚前建议

- 先备份 `./data` 目录
- 保留上一个镜像 tag
- 确认 `.env` 未被覆盖

## 9. PM2 部署指南（非 Docker 环境）

对于内存较小（如 512MB / 1GB）的 VPS，或者没有 Docker 的宿主机环境，可以通过 PM2 运行：

### 1. 全局安装 PM2

```bash
npm install -g pm2
```

### 2. 准备运行环境

配置环境变量并完成代码构建：

```bash
cp .env.example .env
npm install
npm run build
```

### 3. 启动并守护进程

项目已经提供了 `ecosystem.config.cjs` 配置文件，直接通过 PM2 启动即可：

```bash
pm2 start ecosystem.config.cjs
```

### 4. 设置开机自启

```bash
pm2 save
pm2 startup
```

### 5. 常用 PM2 命令

- **查看日志**: `pm2 logs codex-api`
- **监控面板**: `pm2 monit`
- **重启服务**: `pm2 restart codex-api`
- **停止服务**: `pm2 stop codex-api`
