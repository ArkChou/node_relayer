# Relayer 部署指南

## 📋 目录

1. [多实例 + Nginx 负载均衡部署](#多实例--nginx-负载均衡部署)（推荐）
2. [前置要求](#前置要求)
3. [Docker Compose 部署](#docker-compose-部署)
4. [Kubernetes 部署](#kubernetes-部署)
5. [Redis 集群配置](#redis-集群配置)
6. [常见问题](#常见问题)

---

## 多实例 + Nginx 负载均衡部署

### 架构说明

```
                    ┌─────────────────┐
                    │   Nginx (80)    │
                    │  负载均衡器      │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
       ┌────▼────┐      ┌────▼────┐     ┌────▼────┐
       │Relayer-1│      │Relayer-2│     │Relayer-3│
       │  :9527  │      │  :9527  │     │  :9527  │
       └────┬────┘      └────┬────┘     └────┬────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Redis Cluster  │
                    │   (3 nodes)     │
                    └─────────────────┘
```

**特点**：
- ✅ 3 个 Relayer 实例（可扩展到 5-10 个）
- ✅ Nginx 负载均衡（最少连接策略）
- ✅ Redis 主节点选举（只有一个实例执行监控任务）
- ✅ 自动故障转移
- ✅ 支持 500-1500 并发用户

---

### 快速部署

#### 1. 准备配置文件

确保你有以下文件：
- `docker-compose.prod.yml` - 生产环境配置
- `nginx.conf` - Nginx 负载均衡配置
- `.env` - 环境变量（只需要 PRIVATE_KEY）

#### 2. 启动服务

```bash
# 停止旧服务（如果有）
docker-compose -f docker-compose.dev.yml down

# 启动生产环境（3 个 Relayer + Nginx）
docker-compose -f docker-compose.prod.yml up -d

# 查看所有容器状态
docker-compose -f docker-compose.prod.yml ps
```

**预期输出**：
```
NAME                  STATUS          PORTS
nginx                 Up              0.0.0.0:80->80/tcp
relayer-1             Up              
relayer-2             Up              
relayer-3             Up              
redis-node-1          Up              0.0.0.0:6379->6379/tcp
redis-node-2          Up              0.0.0.0:6380->6379/tcp
redis-node-3          Up              0.0.0.0:6381->6379/tcp
redis-cluster-init    Exited (0)
```

#### 3. 验证部署

```bash
# 1. 检查 Nginx 负载均衡
curl http://localhost/health

# 2. 查看 Relayer 日志（所有实例）
docker-compose -f docker-compose.prod.yml logs -f relayer-1
docker-compose -f docker-compose.prod.yml logs -f relayer-2
docker-compose -f docker-compose.prod.yml logs -f relayer-3

# 3. 查看 Nginx 日志
docker-compose -f docker-compose.prod.yml logs -f nginx

# 4. 测试 API
curl -X POST http://localhost/api/v1/get-safe-address \
  -H "Content-Type: application/json" \
  -d '{"userAddress":"0xYourAddress"}'
```

#### 4. 监控状态

```bash
# 查看哪个实例是主节点（执行监控任务）
docker-compose -f docker-compose.prod.yml logs relayer-1 | grep "主节点"
docker-compose -f docker-compose.prod.yml logs relayer-2 | grep "主节点"
docker-compose -f docker-compose.prod.yml logs relayer-3 | grep "主节点"

# 查看 Redis 集群状态
docker exec redis-node-1 redis-cli cluster info

# 查看容器资源使用
docker stats
```

---

### 扩展实例

如果需要更多实例（支持更高并发）：

#### 方法 1：修改 docker-compose.prod.yml

```yaml
# 添加更多 Relayer 实例
  relayer-4:
    build: .
    container_name: relayer-4
    environment:
      - PRIVATE_KEY=${PRIVATE_KEY}
      - REDIS_CLUSTER_NODES=redis-node-1:6379,redis-node-2:6379,redis-node-3:6379
    depends_on:
      - redis-cluster-init
    networks:
      - relayer-network
    restart: unless-stopped

  relayer-5:
    build: .
    container_name: relayer-5
    environment:
      - PRIVATE_KEY=${PRIVATE_KEY}
      - REDIS_CLUSTER_NODES=redis-node-1:6379,redis-node-2:6379,redis-node-3:6379
    depends_on:
      - redis-cluster-init
    networks:
      - relayer-network
    restart: unless-stopped
```

#### 方法 2：修改 nginx.conf

```nginx
upstream relayer_backend {
    least_conn;
    
    server relayer-1:9527 max_fails=3 fail_timeout=30s;
    server relayer-2:9527 max_fails=3 fail_timeout=30s;
    server relayer-3:9527 max_fails=3 fail_timeout=30s;
    server relayer-4:9527 max_fails=3 fail_timeout=30s;  # 新增
    server relayer-5:9527 max_fails=3 fail_timeout=30s;  # 新增
}
```

#### 重新部署

```bash
# 重新构建并启动
docker-compose -f docker-compose.prod.yml up -d --build

# 重新加载 Nginx 配置
docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

---

### 性能调优

#### 1. Nginx 配置优化

```nginx
# nginx.conf
events {
    worker_connections 2048;  # 增加连接数
}

http {
    # 启用 keepalive
    upstream relayer_backend {
        least_conn;
        keepalive 32;  # 保持 32 个连接
        
        server relayer-1:9527 max_fails=3 fail_timeout=30s;
        server relayer-2:9527 max_fails=3 fail_timeout=30s;
        server relayer-3:9527 max_fails=3 fail_timeout=30s;
    }
    
    # 调整限流
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=50r/s;  # 提高到 50/s
}
```

#### 2. 调整监控间隔

```typescript
// src/utils/nonceMonitor.ts
const MONITOR_INTERVAL = 15000; // 从 10 秒改为 15 秒（减少 Redis 压力）
```

#### 3. 增加 RPC 数量

```typescript
// src/config/config.ts
export const RPC_URLS = [
    'https://rpc.ankr.com/base_sepolia/...',
    'https://base-sepolia.g.alchemy.com/v2/...',
    'https://sepolia.base.org',
    'https://base-sepolia.infura.io/v3/...',  // 新增
    'https://base-sepolia.blastapi.io/...',   // 新增
];
```

---

### 故障排查

#### 问题 1：Nginx 无法连接到 Relayer

```bash
# 检查 Relayer 是否运行
docker-compose -f docker-compose.prod.yml ps

# 检查网络连接
docker exec nginx ping relayer-1

# 查看 Nginx 错误日志
docker-compose -f docker-compose.prod.yml logs nginx | grep error
```

#### 问题 2：只有一个实例在处理请求

```bash
# 检查 Nginx 配置
docker exec nginx cat /etc/nginx/nginx.conf

# 重新加载配置
docker exec nginx nginx -s reload

# 查看负载均衡状态（需要 Nginx Plus 或自定义监控）
```

#### 问题 3：Redis 主节点选举失败

```bash
# 查看 Redis 日志
docker-compose -f docker-compose.prod.yml logs redis-node-1

# 手动检查主节点锁
docker exec redis-node-1 redis-cli GET nonce_monitor_leader

# 清除锁（如果卡住）
docker exec redis-node-1 redis-cli DEL nonce_monitor_leader
```

---

### 回滚到单实例

如果需要回滚到开发环境：

```bash
# 停止生产环境
docker-compose -f docker-compose.prod.yml down

# 启动开发环境
docker-compose -f docker-compose.dev.yml up -d
```

---

## 前置要求

### 1. 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 添加 Redis 客户端
npm install ioredis
npm install -D @types/ioredis
```

### 2. 环境变量

创建 `.env` 文件：

```bash
URL=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY
PRIVATE_KEY=YOUR_RELAYER_PRIVATE_KEY
CHAIN_ID=84532
REDIS_CLUSTER_NODES=localhost:6379
```

---

## Docker Compose 部署

### 1. 构建镜像

```bash
# 构建 Docker 镜像
docker build -t relayer:latest .
```

### 2. 启动服务

```bash
# 启动所有服务（Relayer + Redis 集群 + Nginx）
docker-compose up -d

# 查看日志
docker-compose logs -f relayer

# 查看 Redis 集群状态
docker-compose exec redis-node-1 redis-cli cluster info
```

### 3. 初始化 Redis 集群

```bash
# Redis 集群会自动初始化
# 如果需要手动初始化：
docker-compose exec redis-node-1 redis-cli --cluster create \
  redis-node-1:6379 redis-node-2:6380 redis-node-3:6381 \
  redis-node-4:6382 redis-node-5:6383 redis-node-6:6384 \
  --cluster-replicas 1 --cluster-yes
```

### 4. 测试服务

```bash
# 健康检查
curl http://localhost/health

# 测试 API
curl -X GET "http://localhost/api/v1/getMyAddr?eoaAddress=0xYourAddress"
```

### 5. 扩展实例

```bash
# 扩展到 5 个实例
docker-compose up -d --scale relayer=5

# 查看运行的实例
docker-compose ps
```

---

## Kubernetes 部署

### 1. 准备镜像

```bash
# 构建并推送镜像到镜像仓库
docker build -t your-registry/relayer:v1.0.0 .
docker push your-registry/relayer:v1.0.0
```

### 2. 更新配置

编辑 `k8s/secret.yaml`，填入真实的环境变量：

```yaml
stringData:
  URL: "https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY"
  PRIVATE_KEY: "YOUR_PRIVATE_KEY"
```

编辑 `k8s/deployment.yaml`，更新镜像地址：

```yaml
image: your-registry/relayer:v1.0.0
```

### 3. 部署到 K8s

```bash
# 创建命名空间
kubectl apply -f k8s/namespace.yaml

# 部署 Redis 集群
kubectl apply -f k8s/redis-statefulset.yaml

# 等待 Redis 就绪
kubectl wait --for=condition=ready pod -l app=redis-cluster -n relayer --timeout=300s

# 初始化 Redis 集群
kubectl exec -it redis-cluster-0 -n relayer -- redis-cli --cluster create \
  $(kubectl get pods -l app=redis-cluster -n relayer -o jsonpath='{range.items[*]}{.status.podIP}:6379 {end}') \
  --cluster-replicas 1 --cluster-yes

# 部署配置和密钥
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml

# 部署 Relayer 服务
kubectl apply -f k8s/deployment.yaml

# 部署 Ingress（可选）
kubectl apply -f k8s/ingress.yaml
```

### 4. 查看状态

```bash
# 查看 Pod 状态
kubectl get pods -n relayer

# 查看日志
kubectl logs -f deployment/relayer -n relayer

# 查看 HPA 状态
kubectl get hpa -n relayer

# 查看服务
kubectl get svc -n relayer
```

### 5. 滚动更新

```bash
# 更新镜像版本
kubectl set image deployment/relayer relayer=your-registry/relayer:v2.0.0 -n relayer

# 查看更新状态
kubectl rollout status deployment/relayer -n relayer

# 回滚到上一个版本
kubectl rollout undo deployment/relayer -n relayer
```

---

## Redis 集群配置

### 架构说明

- **3 个主节点**：redis-node-1, redis-node-2, redis-node-3
- **3 个从节点**：redis-node-4, redis-node-5, redis-node-6
- **高可用**：主节点故障时自动切换到从节点

### 查看集群状态

```bash
# Docker Compose
docker-compose exec redis-node-1 redis-cli cluster nodes

# Kubernetes
kubectl exec -it redis-cluster-0 -n relayer -- redis-cli cluster nodes
```

### Nonce 管理说明

Redis 用于管理 Relayer 钱包的 nonce，确保多实例不会冲突：

```typescript
// 自动从 Redis 获取 nonce
const nonce = await acquireNonce(relayerWallet.address);

// 发送交易时使用
await relayerWallet.sendTransaction({
  to: "0x...",
  data: "0x...",
  nonce: nonce  // Redis 管理的 nonce
});
```

### 重置 Nonce（错误恢复）

如果 nonce 出现问题：

```bash
# 进入任意 Relayer 容器
docker-compose exec relayer sh

# 或 K8s
kubectl exec -it deployment/relayer -n relayer -- sh

# 在 Node.js REPL 中重置
node
> const { resetNonce } = require('./dist/utils/nonce.js');
> await resetNonce('0xYourRelayerAddress');
```

---

## 常见问题

### 1. Redis 连接失败

**问题**：`❌ Redis Cluster 错误: ECONNREFUSED`

**解决**：
```bash
# 检查 Redis 是否运行
docker-compose ps redis-node-1

# 检查网络连接
docker-compose exec relayer ping redis-node-1

# 重启 Redis
docker-compose restart redis-node-1
```

### 2. Nonce 冲突

**问题**：`nonce too low` 或 `replacement transaction underpriced`

**解决**：
```bash
# 重置 nonce
# 方法 1：通过 API（需要添加管理接口）
curl -X POST http://localhost/api/v1/admin/reset-nonce

# 方法 2：手动重置（见上面的重置 Nonce 步骤）
```

### 3. 健康检查失败

**问题**：Pod 一直重启

**解决**：
```bash
# 查看详细日志
kubectl logs -f deployment/relayer -n relayer

# 检查环境变量
kubectl describe pod <pod-name> -n relayer

# 检查 /health 接口
kubectl port-forward deployment/relayer 9527:9527 -n relayer
curl http://localhost:9527/health
```

### 4. 扩容后性能没提升

**问题**：增加实例但 QPS 没变化

**原因**：
- RPC 节点限流（最可能）
- Redis 性能瓶颈（不太可能）
- 负载均衡配置问题

**解决**：
```bash
# 1. 升级 RPC 节点（Alchemy Growth 版）
# 2. 检查 Nginx 负载均衡
docker-compose logs nginx

# 3. 监控 Redis 性能
docker-compose exec redis-node-1 redis-cli --latency
```

### 5. Docker 镜像太大

**问题**：镜像 > 500MB

**解决**：
```dockerfile
# 使用 alpine 基础镜像（已使用）
FROM node:18-alpine

# 多阶段构建（已使用）
FROM node:18-alpine AS builder

# 清理缓存
RUN npm cache clean --force
```

---

## 监控和日志

### Prometheus 监控（可选）

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'relayer'
    static_configs:
      - targets: ['relayer:9527']
```

### 日志收集（可选）

```bash
# 使用 Loki + Grafana
docker-compose -f docker-compose.yml -f docker-compose.logging.yml up -d
```

---

## 性能优化

### 1. 调整实例数

```bash
# Docker Compose
docker-compose up -d --scale relayer=5

# Kubernetes（自动扩展）
# 已配置 HPA，CPU > 70% 自动扩展到 10 个实例
```

### 2. 优化 Redis

```bash
# 增加 Redis 内存
docker-compose exec redis-node-1 redis-cli CONFIG SET maxmemory 1gb
```

### 3. 升级 RPC

- 免费版：25 RPS
- Growth 版：100 RPS（$49/月）
- Scale 版：无限制

---

## 安全建议

1. **不要提交 `.env` 和 `k8s/secret.yaml` 到 Git**
2. **使用 Sealed Secrets 或 External Secrets 管理密钥**
3. **启用 HTTPS（配置 TLS 证书）**
4. **限制 API 访问（IP 白名单或 API Key）**
5. **定期轮换 Relayer 私钥**

---

## 备份和恢复

### 备份 Redis 数据

```bash
# Docker Compose
docker-compose exec redis-node-1 redis-cli BGSAVE

# Kubernetes
kubectl exec redis-cluster-0 -n relayer -- redis-cli BGSAVE
```

### 恢复数据

```bash
# 复制 dump.rdb 到数据卷
docker cp dump.rdb redis-node-1:/data/
```

---

## 联系和支持

- 文档：[README.md](./README.md)
- 问题反馈：GitHub Issues
