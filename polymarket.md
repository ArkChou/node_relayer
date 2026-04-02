# Polymarket Relayer 架构参考文档

> 基于 Polymarket 和行业最佳实践的 Relayer 服务架构设计

## 目录

1. [系统架构](#系统架构)
2. [核心模块](#核心模块)
3. [技术栈](#技术栈)
4. [API 设计](#api-设计)
5. [安全机制](#安全机制)
6. [性能优化](#性能优化)
7. [监控告警](#监控告警)

---

## 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                  Flutter/Web Frontend                    │
│              (用户界面 + 本地签名)                       │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS/WSS
                     ↓
┌─────────────────────────────────────────────────────────┐
│              Nginx / CloudFlare CDN                      │
│         (负载均衡 + DDoS 防护 + SSL 终止)                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────┐
│                   API Gateway                            │
│    - 身份验证 (JWT/API Key)                              │
│    - 限流 (Rate Limiting)                                │
│    - 请求路由                                            │
│    - 日志记录                                            │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ↓            ↓             ↓
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Node.js  │  │ Node.js  │  │ Node.js  │
│ Service  │  │ Service  │  │ Service  │
│    #1    │  │    #2    │  │    #3    │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │              │
     └─────────────┼──────────────┘
                   ↓
         ┌─────────────────────────┐
         │    Redis Cluster         │
         │  - Nonce 管理            │
         │  - Bull 队列             │
         │  - 缓存层                │
         │  - Session 存储          │
         └─────────┬───────────────┘
                   │
         ┌─────────┴───────────────┐
         │                         │
         ↓                         ↓
┌─────────────────┐      ┌─────────────────┐
│  Relayer Pool    │      │   PostgreSQL    │
│  - Wallet #1     │      │  - 用户数据     │
│  - Wallet #2     │      │  - 交易历史     │
│  - Wallet #3     │      │  - Safe 映射    │
│  (KMS 加密)      │      │  - 审计日志     │
└─────────┬───────┘      └─────────────────┘
          │
          ↓
┌─────────────────────────┐
│   Blockchain Networks    │
│  - Ethereum Mainnet      │
│  - Polygon               │
│  - BSC                   │
│  - Arbitrum              │
└─────────────────────────┘
```

---

## 核心模块

### 1. API Gateway 层

**职责**：
- 统一入口管理
- 身份验证和授权
- 请求限流和防护
- 请求路由和负载均衡

**技术实现**：
```typescript
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const app = express();

// 安全头
app.use(helmet());

// 全局限流
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 分钟
  max: 100,             // 每个 IP 最多 100 次
  message: 'Too many requests'
});
app.use(globalLimiter);

// API Key 验证
app.use('/api', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!isValidApiKey(apiKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});
```

---

### 2. 交易构造服务

**职责**：
- 生成 Safe 部署交易
- 构造 Safe 交易数据
- 计算交易哈希
- 验证交易参数

**核心功能**：

#### 2.1 部署交易生成
```typescript
// POST /api/prepare-deployment
async function prepareDeployment(eoaAddress: string) {
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: RELAYER_PRIVATE_KEY,
    predictedSafe: {
      safeAccountConfig: {
        owners: [eoaAddress],
        threshold: 1
      }
    },
    contractNetworks: SAFE_CONTRACTS
  });

  const safeAddress = await protocolKit.getAddress();
  const deploymentTx = await protocolKit.createSafeDeploymentTransaction();

  return {
    safeAddress,
    transaction: {
      to: deploymentTx.to,
      data: deploymentTx.data,
      value: deploymentTx.value || "0",
      chainId: CHAIN_ID
    }
  };
}
```

#### 2.2 Safe 交易构造
```typescript
// POST /api/prepare-transaction
async function prepareSafeTransaction(params: {
  safeAddress: string;
  to: string;
  value: string;
  data: string;
  operation?: number;
}) {
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: RELAYER_PRIVATE_KEY,
    safeAddress: params.safeAddress
  });

  const safeTransaction = await protocolKit.createTransaction({
    transactions: [{
      to: params.to,
      value: params.value,
      data: params.data,
      operation: params.operation || 0
    }]
  });

  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);

  return {
    safeTxHash,
    safeTransaction: {
      to: safeTransaction.data.to,
      value: safeTransaction.data.value,
      data: safeTransaction.data.data,
      operation: safeTransaction.data.operation,
      safeTxGas: safeTransaction.data.safeTxGas,
      baseGas: safeTransaction.data.baseGas,
      gasPrice: safeTransaction.data.gasPrice,
      gasToken: safeTransaction.data.gasToken,
      refundReceiver: safeTransaction.data.refundReceiver,
      nonce: safeTransaction.data.nonce
    }
  };
}
```

---

### 3. 签名验证服务

**职责**：
- 验证用户签名
- 恢复签名者地址
- 检查 Safe owner 权限
- 防重放攻击

**实现**：
```typescript
import { ethers } from 'ethers';

async function verifySignature(params: {
  safeAddress: string;
  safeTxHash: string;
  signature: string;
  signerAddress: string;
}) {
  // 1. 恢复签名者地址
  const recoveredAddress = ethers.verifyMessage(
    ethers.getBytes(params.safeTxHash),
    params.signature
  );

  // 2. 验证地址匹配
  if (recoveredAddress.toLowerCase() !== params.signerAddress.toLowerCase()) {
    throw new Error('Signature verification failed');
  }

  // 3. 检查是否为 Safe owner
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: RELAYER_PRIVATE_KEY,
    safeAddress: params.safeAddress
  });

  const isOwner = await protocolKit.isOwner(recoveredAddress);
  if (!isOwner) {
    throw new Error('Signer is not a Safe owner');
  }

  // 4. 检查是否已执行（防重放）
  const isExecuted = await redis.sismember(
    `executed:${params.safeAddress}`,
    params.safeTxHash
  );
  if (isExecuted) {
    throw new Error('Transaction already executed');
  }

  return true;
}
```

---

### 4. Gas 管理服务

**职责**：
- Nonce 原子管理
- Gas 价格估算
- 交易加速
- 余额监控

#### 4.1 Nonce 管理（Redis 原子操作）
```typescript
import Redis from 'ioredis';

const redis = new Redis({
  host: 'localhost',
  port: 6379
});

class NonceManager {
  // 获取下一个 nonce
  async getNextNonce(relayerAddress: string): Promise<number> {
    const key = `nonce:${relayerAddress}`;
    
    // 原子递增
    const nonce = await redis.incr(key);
    
    // 设置过期时间（防止内存泄漏）
    await redis.expire(key, 3600);
    
    return nonce;
  }

  // 交易失败时回滚
  async rollbackNonce(relayerAddress: string): Promise<void> {
    const key = `nonce:${relayerAddress}`;
    await redis.decr(key);
  }

  // 同步链上 nonce
  async syncNonce(relayerAddress: string, provider: ethers.Provider): Promise<void> {
    const onChainNonce = await provider.getTransactionCount(relayerAddress);
    const key = `nonce:${relayerAddress}`;
    await redis.set(key, onChainNonce);
  }
}
```

#### 4.2 Gas 估算和优化
```typescript
async function estimateGasWithBuffer(tx: Transaction): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  // 估算 gas
  const estimatedGas = await provider.estimateGas(tx);
  
  // 加 20% buffer
  const gasLimit = (estimatedGas * 120n) / 100n;
  
  return gasLimit;
}

// EIP-1559 动态定价
async function getGasPrice(): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const feeData = await provider.getFeeData();
  
  return {
    maxFeePerGas: feeData.maxFeePerGas || 0n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n
  };
}
```

---

### 5. 交易执行服务

**职责**：
- Relayer 钱包池管理
- 并发交易发送
- 失败重试
- 交易加速

#### 5.1 Relayer 钱包池
```typescript
class RelayerPool {
  private relayers: Array<{
    address: string;
    wallet: ethers.Wallet;
    isAvailable: boolean;
  }>;

  constructor(privateKeys: string[], provider: ethers.Provider) {
    this.relayers = privateKeys.map(pk => {
      const wallet = new ethers.Wallet(pk, provider);
      return {
        address: wallet.address,
        wallet,
        isAvailable: true
      };
    });
  }

  // 获取可用的 Relayer
  async getAvailableRelayer(): Promise<ethers.Wallet> {
    // 轮询选择
    const available = this.relayers.find(r => r.isAvailable);
    if (!available) {
      throw new Error('No available relayer');
    }

    available.isAvailable = false;
    return available.wallet;
  }

  // 释放 Relayer
  releaseRelayer(address: string): void {
    const relayer = this.relayers.find(r => r.address === address);
    if (relayer) {
      relayer.isAvailable = true;
    }
  }

  // 监控余额
  async checkBalances(): Promise<void> {
    for (const relayer of this.relayers) {
      const balance = await relayer.wallet.provider.getBalance(relayer.address);
      const balanceInEth = ethers.formatEther(balance);
      
      if (parseFloat(balanceInEth) < 0.1) {
        console.warn(`⚠️ Low balance for ${relayer.address}: ${balanceInEth} ETH`);
        // 发送告警
        await sendAlert(`Relayer ${relayer.address} balance low`);
      }
    }
  }
}
```

#### 5.2 交易执行
```typescript
async function executeSafeTransaction(params: {
  safeAddress: string;
  safeTransaction: SafeTransaction;
  signatures: Record<string, string>;
}) {
  const relayer = await relayerPool.getAvailableRelayer();
  
  try {
    const protocolKit = await Safe.init({
      provider: RPC_URL,
      signer: relayer.privateKey,
      safeAddress: params.safeAddress
    });

    // 添加签名
    for (const [address, signature] of Object.entries(params.signatures)) {
      params.safeTransaction.addSignature({
        signer: address,
        data: signature
      });
    }

    // 获取 nonce
    const nonce = await nonceManager.getNextNonce(relayer.address);

    // 执行交易
    const txResponse = await protocolKit.executeTransaction(
      params.safeTransaction,
      { nonce }
    );

    console.log('Transaction sent:', txResponse.hash);

    // 等待确认
    const receipt = await txResponse.wait();

    // 标记为已执行
    await redis.sadd(
      `executed:${params.safeAddress}`,
      params.safeTransaction.hash
    );

    return {
      txHash: txResponse.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    };

  } catch (error) {
    // 回滚 nonce
    await nonceManager.rollbackNonce(relayer.address);
    throw error;
  } finally {
    relayerPool.releaseRelayer(relayer.address);
  }
}
```

---

### 6. 队列系统（Bull + Redis）

**职责**：
- 异步任务处理
- 并发控制
- 失败重试
- 任务优先级

**实现**：
```typescript
import Queue from 'bull';

// 部署队列
const deployQueue = new Queue('safe-deployment', {
  redis: { host: 'localhost', port: 6379 }
});

// 执行队列
const executeQueue = new Queue('safe-execution', {
  redis: { host: 'localhost', port: 6379 }
});

// 部署任务处理（限制并发数为 5）
deployQueue.process(5, async (job) => {
  const { userAddress, predictedSafeAddress, deploymentTx } = job.data;
  
  console.log(`Processing deployment for ${userAddress}`);
  
  const result = await deploySafeByRelayer({
    userAddress,
    predictedSafeAddress,
    deploymentTx
  });
  
  return result;
});

// 执行任务处理（限制并发数为 10）
executeQueue.process(10, async (job) => {
  const { safeAddress, safeTransaction, signatures } = job.data;
  
  console.log(`Processing execution for ${safeAddress}`);
  
  const result = await executeSafeTransaction({
    safeAddress,
    safeTransaction,
    signatures
  });
  
  return result;
});

// 失败重试
deployQueue.on('failed', async (job, err) => {
  console.error(`Job ${job.id} failed:`, err);
  
  if (job.attemptsMade < 3) {
    // 重试 3 次
    await job.retry();
  }
});

// 添加任务到队列
async function queueDeployment(data: any) {
  const job = await deployQueue.add(data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true
  });
  
  return job.id;
}
```

---

## API 设计

### 1. 部署 Safe

**Endpoint**: `POST /api/deploy-safe`

**Request**:
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

**Response**:
```json
{
  "success": true,
  "txHash": "0xabc123...",
  "safeAddress": "0x8a712F13B68A14dbf7428C99fc63d4Eed7Caa56c",
  "blockNumber": 99055728,
  "gasUsed": "259243"
}
```

---

### 2. 执行 Safe 交易

**Endpoint**: `POST /api/execute-safe-tx`

**Request**:
```json
{
  "safeAddress": "0x8a712F13B68A14dbf7428C99fc63d4Eed7Caa56c",
  "safeTxHash": "0xdef456...",
  "to": "0x6761bE38A9E28810b2F7D9FEd8cc8469D0Ba0F82",
  "value": "0",
  "data": "0xa9059cbb...",
  "operation": 0,
  "safeTxGas": "0",
  "baseGas": "0",
  "gasPrice": "0",
  "gasToken": "0x0000000000000000000000000000000000000000",
  "refundReceiver": "0x0000000000000000000000000000000000000000",
  "nonce": 0,
  "signatures": {
    "0x35CbDEC2bDe7bfD21A70013D6Eda5b85C040Dd78": "0x1234567890abcdef..."
  }
}
```

**Response**:
```json
{
  "success": true,
  "txHash": "0xghi789...",
  "blockNumber": 99055729,
  "gasUsed": "156432"
}
```

---

### 3. 查询任务状态

**Endpoint**: `GET /api/job-status/:jobId`

**Response**:
```json
{
  "status": "completed",
  "result": {
    "txHash": "0xabc123...",
    "safeAddress": "0x8a712F13B68A14dbf7428C99fc63d4Eed7Caa56c"
  }
}
```

---

## 安全机制

### 1. 身份验证

```typescript
// JWT Token 验证
import jwt from 'jsonwebtoken';

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

### 2. 限流策略

```typescript
// 按 IP 限流
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});

// 按用户地址限流
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body.userAddress
});

// 部署专用限流（更严格）
const deployLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body.userAddress
});
```

### 3. 私钥管理

```typescript
// 使用 AWS KMS 或 HashiCorp Vault
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';

async function getRelayerPrivateKey(): Promise<string> {
  const kms = new KMSClient({ region: 'us-east-1' });
  
  const command = new DecryptCommand({
    CiphertextBlob: Buffer.from(ENCRYPTED_PRIVATE_KEY, 'base64')
  });
  
  const response = await kms.send(command);
  const privateKey = Buffer.from(response.Plaintext).toString('utf-8');
  
  return privateKey;
}
```

### 4. 防重放攻击

```typescript
// 使用 Redis 记录已执行的交易
async function checkReplayAttack(safeAddress: string, safeTxHash: string): Promise<boolean> {
  const key = `executed:${safeAddress}`;
  const isExecuted = await redis.sismember(key, safeTxHash);
  
  if (isExecuted) {
    throw new Error('Transaction already executed');
  }
  
  // 标记为已执行
  await redis.sadd(key, safeTxHash);
  await redis.expire(key, 86400 * 7); // 7 天过期
  
  return true;
}
```

---

## 性能优化

### 1. 并发控制

```typescript
// 使用 p-limit 控制并发
import pLimit from 'p-limit';

const limit = pLimit(10); // 最多 10 个并发

const promises = transactions.map(tx => 
  limit(() => executeSafeTransaction(tx))
);

const results = await Promise.all(promises);
```

### 2. 缓存策略

```typescript
// Redis 缓存 Safe 地址
async function getCachedSafeAddress(eoaAddress: string): Promise<string | null> {
  const key = `safe:${eoaAddress}`;
  const cached = await redis.get(key);
  
  if (cached) {
    return cached;
  }
  
  // 计算并缓存
  const safeAddress = await getSafeAddress(eoaAddress);
  await redis.setex(key, 3600, safeAddress);
  
  return safeAddress;
}
```

### 3. 批量处理

```typescript
// 批量发送交易
async function batchSendTransactions(txs: Transaction[]): Promise<string[]> {
  const baseNonce = await provider.getTransactionCount(relayerAddress);
  
  const promises = txs.map((tx, index) => {
    return relayer.sendTransaction({
      ...tx,
      nonce: baseNonce + index
    });
  });
  
  const responses = await Promise.all(promises);
  return responses.map(r => r.hash);
}
```

---

## 监控告警

### 1. 关键指标

```typescript
// Prometheus 指标
import { Counter, Gauge, Histogram } from 'prom-client';

// 交易计数
const txCounter = new Counter({
  name: 'relayer_transactions_total',
  help: 'Total number of transactions',
  labelNames: ['type', 'status']
});

// Relayer 余额
const balanceGauge = new Gauge({
  name: 'relayer_balance_eth',
  help: 'Relayer wallet balance in ETH',
  labelNames: ['address']
});

// Gas 消耗
const gasHistogram = new Histogram({
  name: 'relayer_gas_used',
  help: 'Gas used per transaction',
  buckets: [50000, 100000, 200000, 500000, 1000000]
});
```

### 2. 告警规则

```typescript
// 余额告警
async function checkBalanceAlert() {
  for (const relayer of relayers) {
    const balance = await provider.getBalance(relayer.address);
    const balanceInEth = parseFloat(ethers.formatEther(balance));
    
    if (balanceInEth < 0.1) {
      await sendAlert({
        level: 'critical',
        message: `Relayer ${relayer.address} balance low: ${balanceInEth} ETH`,
        channel: 'slack'
      });
    }
  }
}

// 交易失败率告警
async function checkFailureRate() {
  const failureRate = await redis.get('tx:failure_rate');
  
  if (parseFloat(failureRate) > 0.1) { // 超过 10%
    await sendAlert({
      level: 'warning',
      message: `High transaction failure rate: ${failureRate}`,
      channel: 'email'
    });
  }
}
```

### 3. 日志系统

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// 结构化日志
logger.info('Transaction executed', {
  txHash: '0xabc123...',
  safeAddress: '0x8a712F...',
  gasUsed: '156432',
  duration: '3.2s'
});
```

---

## 部署架构

### Docker Compose 示例

```yaml
version: '3.8'

services:
  # Node.js 服务
  relayer:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - REDIS_HOST=redis
      - POSTGRES_HOST=postgres
    depends_on:
      - redis
      - postgres
    deploy:
      replicas: 3

  # Redis
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  # PostgreSQL
  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=relayer
      - POSTGRES_USER=relayer
      - POSTGRES_PASSWORD=secret
    volumes:
      - postgres-data:/var/lib/postgresql/data

  # Nginx
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - relayer

volumes:
  redis-data:
  postgres-data:
```

---

## 参考资料

- [Polymarket 官网](https://polymarket.com)
- [Safe SDK v7 文档](https://docs.safe.global/sdk/protocol-kit)
- [EIP-4337 Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [Bull Queue 文档](https://github.com/OptimalBits/bull)
- [Redis 最佳实践](https://redis.io/docs/manual/patterns/)

---

## 总结

Polymarket Relayer 的核心特点：

1. **多层架构**：API Gateway → 业务服务 → 队列 → 区块链
2. **Relayer 池**：多钱包负载均衡，避免 nonce 冲突
3. **原子 Nonce**：Redis 原子操作管理 nonce
4. **队列系统**：Bull + Redis 处理高并发
5. **安全机制**：签名验证 + 限流 + 防重放
6. **监控告警**：实时监控余额、交易状态、性能指标

这套架构可以支持：
- 单实例：~100 req/s
- 3 实例 + 队列：~300 req/s
- 水平扩展：可达 1000+ req/s
