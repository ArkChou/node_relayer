# Node.js Relayer 服务需求文档

## 项目背景

构建一个基于 Safe 智能合约钱包的 Relayer 服务，为 Flutter 移动端提供无 gas 交易支持。用户通过助记词生成 EOA 地址，后端代付 gas 费用完成链上操作。

## 技术栈

- **区块链**: BSC Testnet
- **智能合约**: Safe (Gnosis Safe) v1.3.0
- **Safe SDK**: @safe-global/protocol-kit v7.0.0
- **后端**: Node.js + Express + TypeScript
- **队列**: Bull (Redis)
- **前端**: Flutter (Dart)
- **合约交互**: MarketV2.sol (自定义市场合约)

## 核心功能

### 1. Safe 账户部署

**流程**:
1. **前端 (Flutter)**:
   - 用户输入助记词或私钥
   - 派生 EOA 地址作为 Safe owner
   - 调用 Safe SDK 预测 Safe 地址 (CREATE2)
   - 生成部署交易数据 (`to`, `value`, `data`)
   - 发送到后端 API

2. **后端 (Node.js)**:
   - 接收前端部署数据
   - 用 relayer 私钥估算 gas
   - 发送交易到 ProxyFactory 合约
   - 代付 gas 费用
   - 返回交易 hash 和 Safe 地址

**关键代码位置**:
- 前端脚本: `/SafeScripts/qiandeploy.js`
- 后端脚本: `/SafeScripts/houduan.js`

**数据格式**:
```json
{
  "userAddress": "0x35CbDEC2bDe7bfD21A70013D6Eda5b85C040Dd78",
  "predictedSafeAddress": "0x8a712F13B68A14dbf7428C99fc63d4Eed7Caa56c",
  "deploymentTx": {
    "to": "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    "value": "0",
    "data": "0x1688f0b9..."
  }
}
```

### 2. Safe 交易执行

**流程**:
1. **前端**:
   - 用户构造交易 (如 ERC20 转账、Market.purchase)
   - 用 Safe SDK 创建 SafeTransaction
   - 用户私钥签名
   - 发送签名数据到后端

2. **后端**:
   - 接收签名后的 SafeTransaction
   - 调用 `Safe.execTransaction()`
   - Relayer 代付 gas
   - 返回执行结果

**支持的交易类型**:
- ERC20 转账
- Market.purchase (购买订单)
- MultiSend (批量操作)

### 3. 批量交易处理

**场景**: 多个用户同时发起交易

**方案**: 并行发送 + 手动 nonce 管理

**实现**:
```javascript
// Redis 原子操作管理 nonce
async function getNextNonce(relayerAddress) {
  return await redis.incr(`nonce:${relayerAddress}`);
}

// 并行发送多笔交易
const txPromises = userTransactions.map(async (tx, index) => {
  const nonce = baseNonce + index;
  return relayer.sendTransaction({ ...tx, nonce });
});
```

**注意事项**:
- Nonce 必须严格递增且连续
- 如果某个 nonce 的交易失败未上链，后续交易会被阻塞
- 需要监控交易状态，失败时重发

## 合约信息

### BSC Testnet 部署地址

```javascript
// Safe 合约
Safe Singleton:      0x3E5c63644E683549055b9Be8653de26E0B4CD36E
Proxy Factory:       0xc22834581EbC8527d974F8a1c97E1bEA4EF910BC
MultiSend:           0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761

// 自定义合约
MarketV2:            0x6761bE38A9E28810b2F7D9FEd8cc8469D0Ba0F82
```

### MarketV2 合约接口

```solidity
struct PurchaseParams {
    bytes32 orderHash;     // 订单 ID（链下计算）
    bytes32 postId;        // 帖子 ID
    address seller;        // 卖家
    uint96  unitPrice;     // 单价
    uint32  quantity;      // 购买数量
    uint40  createdAt;     // 创建时间（链下传入）
}

function purchase(PurchaseParams calldata params) external returns (bytes32);
function redeem(bytes32 orderHash) external;
```

**特点**:
- 购买时不扣款，只生成订单 hash
- 核销时才从买家扣款给卖家
- 支持卖家授权核销员

## API 设计

### 1. 部署 Safe

**Endpoint**: `POST /api/deploy-safe`

**Request**:
```json
{
  "userAddress": "0x...",
  "predictedSafeAddress": "0x...",
  "deploymentTx": {
    "to": "0x...",
    "value": "0",
    "data": "0x..."
  }
}
```

**Response**:
```json
{
  "success": true,
  "txHash": "0x...",
  "safeAddress": "0x...",
  "blockNumber": 99055728,
  "gasUsed": "259243"
}
```

### 2. 执行 Safe 交易

**Endpoint**: `POST /api/execute-safe-tx`

**Request**:
```json
{
  "safeAddress": "0x...",
  "safeTxHash": "0x...",
  "to": "0x...",
  "value": "0",
  "data": "0x...",
  "operation": 0,
  "safeTxGas": "0",
  "baseGas": "0",
  "gasPrice": "0",
  "gasToken": "0x0000000000000000000000000000000000000000",
  "refundReceiver": "0x0000000000000000000000000000000000000000",
  "nonce": 0,
  "signatures": {
    "0xUserAddress": "0x签名数据"
  }
}
```

**Response**:
```json
{
  "success": true,
  "txHash": "0x...",
  "blockNumber": 123456
}
```

### 3. 查询部署状态

**Endpoint**: `GET /api/deploy-status/:jobId`

**Response**:
```json
{
  "status": "completed",
  "result": {
    "txHash": "0x...",
    "safeAddress": "0x..."
  }
}
```

## 限流与并发

### 限流策略

```javascript
// API 级别限流
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 分钟
  max: 100,                  // 每个 IP 最多 100 次
});

// 部署专用限流
const deploySafeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,                   // 每分钟最多 10 次部署
  keyGenerator: (req) => req.body.userAddress, // 按用户地址限流
});
```

### 队列处理

```javascript
const Queue = require('bull');

const deployQueue = new Queue('safe-deployment', {
  redis: { host: 'localhost', port: 6379 }
});

// 限制并发数为 5
deployQueue.process(5, async (job) => {
  return await deploySafeForUser(job.data);
});
```

### 高并发架构

```
Flutter App (1000+ 用户)
    ↓ HTTPS
Nginx (负载均衡)
    ↓
Node.js 微服务 (多实例)
    ↓
Redis (队列 + nonce 管理)
    ↓
BSC Testnet
```

**性能指标**:
- 单实例: ~100 req/s
- 3 实例 + 队列: ~300 req/s
- 瓶颈: 链上确认速度 (BSC ~3s/block)

## 关键技术点

### 1. CREATE2 地址预测

Safe 使用 CREATE2 部署，地址可预测：

```
address = keccak256(
  0xff ++ 
  proxyFactory ++ 
  salt ++ 
  keccak256(proxyCreationCode)
)[12:]
```

**优势**:
- 前端可以提前知道 Safe 地址
- 用户可以先向 Safe 地址转账，再部署

### 2. Nonce 管理

**问题**: 多个交易并发时 nonce 冲突

**解决方案**: Redis 原子操作
```javascript
// 获取并递增 nonce
const nonce = await redis.incr(`nonce:${relayerAddress}`);

// 交易失败时回滚
tx.wait().catch(() => {
  redis.decr(`nonce:${relayerAddress}`);
});
```

### 3. Gas 估算

```javascript
// 估算 gas
const estimatedGas = await provider.estimateGas({
  to: deploymentTx.to,
  value: deploymentTx.value,
  data: deploymentTx.data
});

// 加 20% buffer
const gasLimit = estimatedGas * 120n / 100n;
```

### 4. MultiSend 批量操作

用户一次交易执行多个操作（如 approve + purchase）：

```javascript
const transactions = [
  { to: tokenAddress, data: approveCalldata, operation: 0 },
  { to: marketAddress, data: purchaseCalldata, operation: 0 }
];

const safeTx = await protocolKit.createTransaction({
  transactions // 自动使用 MultiSend
});
```

## 测试脚本

### 前端测试 (qiandeploy.js)

```bash
node SafeScripts/qiandeploy.js
```

**功能**:
- 用户私钥生成 Safe 部署数据
- 输出 JSON 格式，可直接发送给后端

### 后端测试 (houduan.js)

```bash
node SafeScripts/houduan.js
```

**功能**:
- 接收部署数据
- Relayer 代付 gas 发送交易
- 输出交易 hash 和结果

### 签名测试 (qianduan.js)

```bash
node SafeScripts/qianduan.js
```

**功能**:
- 连接已部署的 Safe
- 构造并签名交易
- 输出签名数据

## 环境配置

### 依赖安装

```bash
npm install @safe-global/protocol-kit@7.0.0
npm install ethers@6.x
npm install express
npm install express-rate-limit
npm install bull
npm install ioredis
```

### 环境变量

```env
# Base Sepolia
RPC_URL=https://base-sepolia.g.alchemy.com/v2/QT61ixLwVZ9CguVBHYkJp
CHAIN_ID=84532

# Relayer
RELAYER_PRIVATE_KEY=0x...

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# API
PORT=3000
```

## 安全考虑

1. **Relayer 私钥管理**:
   - 使用 AWS KMS 或 HashiCorp Vault
   - 定期轮换私钥
   - 监控余额，及时充值

2. **限流防刷**:
   - IP 级别限流
   - 用户地址级别限流
   - 验证码 (可选)

3. **交易验证**:
   - 前端签名验证
   - Gas 估算失败直接拒绝
   - 监控异常交易模式

4. **错误处理**:
   - 交易失败重试机制
   - Nonce 冲突自动恢复
   - 详细日志记录

## 部署方案

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### PM2 进程管理

```bash
pm2 start server.js -i 3  # 启动 3 个实例
pm2 logs                   # 查看日志
pm2 monit                  # 监控
```

### Kubernetes (可选)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: safe-relayer
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: relayer
        image: safe-relayer:latest
        ports:
        - containerPort: 3000
```

## 监控与日志

### 关键指标

- Relayer 余额
- 交易成功率
- 平均 gas 消耗
- API 响应时间
- 队列长度

### 日志格式

```json
{
  "timestamp": "2026-04-01T11:46:00Z",
  "level": "info",
  "service": "safe-relayer",
  "action": "deploy-safe",
  "userAddress": "0x...",
  "safeAddress": "0x...",
  "txHash": "0x...",
  "gasUsed": "259243",
  "duration": "3.2s"
}
```

## 未来优化

1. **Gas 优化**:
   - 批量部署多个 Safe (需要自定义合约)
   - 使用 EIP-1559 动态 gas 定价

2. **扩展性**:
   - 支持多链 (Polygon, Arbitrum)
   - 多 Relayer 负载均衡

3. **用户体验**:
   - WebSocket 实时推送交易状态
   - 交易加速功能 (提高 gas price)

## 参考资料

- [Safe SDK v7 文档](https://docs.safe.global/sdk/protocol-kit)
- [EIP-4337 Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [CREATE2 部署](https://eips.ethereum.org/EIPS/eip-1014)
- [Polymarket 架构参考](https://polymarket.com)

## 联系方式

项目路径: `/Users/shark/Documents/erc`

关键文件:
- 合约: `/contracts/MarketV2.sol`
- 前端脚本: `/SafeScripts/qiandeploy.js`
- 后端脚本: `/SafeScripts/houduan.js`
- 测试: `/test/WholeProcess.test.js`


## 快速测试
- Post
curl -X POST http://localhost:9527/initialAccount -H "Content-Type: application/json" -d '{"eoaAddress":"0x35cbdec2bde7bfd21a70013d6eda5b85c040dd78"}'

- Get 
curl "http://localhost:9527/getMyAddr?address=0x35cbdec2bde7bfd21a70013d6eda5b85c040dd78"