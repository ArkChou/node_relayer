类型安全（使用 SafeTransactionData）
配置管理（使用 feeConfig）
Provider 复用
长期优化（有时间再做）
Safe 初始化重构
日志系统
Gas 估算容错
请求限流


## 启动redis docker集群
docker-compose -f docker-compose.redis.yml up -d

## Docker 常用命令

### 启动服务
```bash
docker-compose -f docker-compose.prod.yml up -d
docker-compose -f docker-compose.prod.yml up -d --build  # 重新构建
```

### 停止服务
```bash
docker-compose -f docker-compose.prod.yml stop      # 停止服务
docker-compose -f docker-compose.prod.yml down      # 停止并删除容器
docker-compose -f docker-compose.prod.yml down -v   # 停止并删除容器和数据卷
```

### 查看状态和日志
```bash
docker-compose -f docker-compose.prod.yml ps                      # 查看容器状态
docker-compose -f docker-compose.prod.yml logs -f relayer-1       # 查看 Relayer-1 日志
docker-compose -f docker-compose.prod.yml logs -f                 # 查看所有日志
docker-compose -f docker-compose.prod.yml logs --tail=100 relayer-1  # 查看最后100行
docker-compose -f docker-compose.prod.yml logs -f relayer-1 relayer-2 relayer-3  # 查看所有 Relayer
```

### 重启服务
```bash
docker-compose -f docker-compose.prod.yml restart relayer-1  # 重启 Relayer-1
docker-compose -f docker-compose.prod.yml restart            # 重启所有服务
```

### 进入容器
```bash
docker exec -it relayer sh                    # 进入 Relayer 容器
docker exec -it redis-1 redis-cli             # 进入 Redis 容器
```


# 1. 停止开发环境
docker-compose -f docker-compose.dev.yml down
 
# 3. 查看状态
docker-compose -f docker-compose.prod.yml ps
 
# 4. 查看日志
docker-compose -f docker-compose.prod.yml logs -f relayer-1
 
# 5. 测试负载均衡
curl http://localhost/health

# 构建命令
docker-compose -f docker-compose.prod.yml up -d --build

# 启动生产环境
docker-compose -f docker-compose.prod.yml up -d

# 查看状态
docker-compose -f docker-compose.prod.yml ps