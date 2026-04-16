
### 启动服务
docker-compose -f docker-compose.prod.yml up -d --build

### 停止服务
```bash
docker-compose -f docker-compose.prod.yml stop      # 停止服务
docker-compose -f docker-compose.prod.yml down      # 停止并删除容器
docker-compose -f docker-compose.prod.yml down -v   # 停止并删除容器和数据卷
```

### 查看状态和日志
```bash
docker-compose -f docker-compose.prod.yml ps                      # 查看容器状态
docker-compose -f docker-compose.prod.yml logs -f relayer-1       # 查看 Relayer-1 日
```

### 进入容器
```bash
docker exec -it relayer sh                    # 进入 Relayer 容器
docker exec -it redis-1 redis-cli             # 进入 Redis 容器
```

### 基本构建启动

```bash
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.prod.yml up -d --build
```

## API 接口文档

**服务端口：** 9525  
**架构：** Redis 集群模式，Relayer 3 实例，RPC 5 个（3 付费 + 2 免费）

---

### 1. 获取 AA 账户地址

**接口：** `GET /api/v1/getMyAddr`

**描述：** 根据 EOA 地址获取对应的 Safe AA 钱包地址

**请求参数：**
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| userAddress | String | 是 | EOA 地址（助记词生成） |

**请求示例：**
```bash
GET /api/v1/getMyAddr?userAddress=0x1234...
```

**返回格式：**
```json
{
  "success": true,
  "data": {
    "eoaAddress": "0x1234...",
    "safeAddress": "0x5678..."
  },
  "timestamp": 1234567890
}
```

**返回字段说明：**
| 字段 | 类型 | 说明 |
|------|------|------|
| success | Boolean | 请求是否成功 |
| data.eoaAddress | String | EOA 地址（助记词生成） |
| data.safeAddress | String | Safe AA 钱包地址 |
| timestamp | Number | 时间戳 |

**错误返回：**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误信息"
  },
  "timestamp": 1234567890
}
```

---

### 2. 部署 Safe 钱包

**接口：** `POST /api/v1/deploy-safe`

**描述：** Relayer 代付 gas 部署 Safe AA 钱包

**请求参数：**
```json
{
  "userAddress": "0x1234..."
}
```

**返回格式：**
```json
{
  "success": true,
  "data": {
    "txHash": "0xabc...",
    "safeAddress": "0x5678..."
  },
  "timestamp": 1234567890
}
```

---

### 3. 准备交易（收取 ERC20 gas 费）

**接口：** `POST /api/v1/prepare-transaction-with-fee`

**描述：** 准备 Safe 交易并计算 gas 费，返回 safeTxHash 供前端签名

**请求参数：**
```json
{
  "safeAddress": "0x5678...",
  "to": "0x9abc...",
  "value": "0",
  "data": "0x..."
}
```

**返回格式：**
```json
{
  "success": true,
  "data": {
    "safeTxHash": "0xdef...",
    "safeTransaction": {
      "to": "0x9abc...",
      "value": "0",
      "data": "0x...",
      "operation": 0,
      "safeTxGas": "100000",
      "baseGas": "50000",
      "gasPrice": "1000000000",
      "gasToken": "0x...",
      "refundReceiver": "0x0000...",
      "nonce": "1"
    }
  },
  "timestamp": 1234567890
}
```

---

### 4. 执行交易

**接口：** `POST /api/v1/execute-transaction`

**描述：** 执行已签名的 Safe 交易

**请求参数：**
```json
{
  "safeAddress": "0x5678...",
  "userAddress": "0x1234...",
  "signature": "0x...",
  "safeTransaction": {
    "to": "0x9abc...",
    "value": "0",
    "data": "0x...",
    "operation": 0,
    "safeTxGas": "100000",
    "baseGas": "50000",
    "gasPrice": "1000000000",
    "gasToken": "0x...",
    "refundReceiver": "0x0000...",
    "nonce": "1"
  }
}
```

**返回格式：**
```json
{
  "success": true,
  "data": {
    "txHash": "0xghi...",
    "status": "submitted",
    "nonce": 1
  },
  "timestamp": 1234567890
}
```




