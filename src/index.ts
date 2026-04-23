import express from "express";
import safeModule from "./api/safe.js";
import transferModule from "./api/sendTx.js";
import configModule from "./api/prepare.js";
import cors from "cors";
import dotenv from "dotenv";
import { initRpcHealthPool } from "./utils/rpcHealthPool.js";
import { RPC_URLS, tokenInfo, contractAddresses } from "./config/config.js";
import { startNonceMonitor } from "./utils/nonceMonitor.js";
import { txQueue } from "./queue/txQueue.js";
import "./queue/worker.js";
import logger from "./utils/logger.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { successResponse, errorResponse } from "./utils/response.js";
import { ValidationError } from "./utils/errors.js";
import { validateAddress, validateSignature, validateRequired } from "./utils/validation.js";
import { validateEnv } from "./utils/envValidator.js";
import { getRpcHealthPool } from "./utils/rpcHealthPool.js";
import { getTransactionCount } from "./utils/rpcWrapper.js";
import { getRedisCluster } from "./utils/nonce.js";
import { ethers } from "ethers";
import { MARKET_ABI } from "./abi/MARKET_ABI.js";
import { getProvider } from "./utils/provider.js";

dotenv.config();

// 验证环境变量
validateEnv();

// 初始化 RPC 健康池
initRpcHealthPool(RPC_URLS);

// 辅助函数：动态获取 Market 合约实例（避免 RPC 断连问题）
function getMarketContract() {
  return new ethers.Contract(
    contractAddresses.MARKET,
    MARKET_ABI,
    getProvider()  // 每次都获取最新的健康 provider
  );
}

// 启动时强制同步 nonce
(async () => {
  try {
    const redis = getRedisCluster();
    const relayerAddress = tokenInfo.RELAYER_ADDRESS;
    
    // 从链上获取最新 nonce
    const chainNonce = await getTransactionCount(relayerAddress, 'latest');
    
    // 强制更新 Redis
    await redis.set(`confirmed_nonce:${relayerAddress.toLowerCase()}`, chainNonce);
    await redis.set(`pending_nonce:${relayerAddress.toLowerCase()}`, chainNonce);
    
    logger.info(`🔄 启动时同步 nonce: ${chainNonce}`);
  } catch (error: any) {
    logger.error('❌ 同步 nonce 失败', { error: error.message });
  }
})();

// 启动 Nonce 监控任务
startNonceMonitor(tokenInfo.RELAYER_ADDRESS);
logger.info("✅ Nonce 监控任务已启动");

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 9525;

// 请求日志中间件（放在最前面）
app.use(requestLogger);

app.use(cors({
  origin: '*', // 开发环境可以用 *，生产环境应该指定具体域名
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 解析 JSON
app.use(express.json());


/**
 * 健康检查
 */
app.get("/", (req, res) => {
  res.send("Relayer is running 🚀");
});

app.get("/health", async (req, res) => {
  try {
    // 检查 RPC 健康状态
    const rpcHealth = getRpcHealthPool().getStatus();
    const rpcOk = rpcHealth.healthy.length > 0;
    
    // 检查队列连接
    let queueOk = false;
    try {
      const client = await txQueue.client;
      await client.ping();
      queueOk = true;
    } catch (error) {
      queueOk = false;
    }
    
    const healthy = rpcOk && queueOk;
    
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      version: "v1.0.0",
      timestamp: Date.now(),
      uptime: process.uptime(),
      checks: {
        rpc: rpcOk,
        rpcHealthy: rpcHealth.healthy.length,
        rpcUnhealthy: rpcHealth.unhealthy.length,
        queue: queueOk
      }
    });
  } catch (error: any) {
    return res.status(503).json({
      status: "error",
      error: error.message
    });
  }
});

/**
 * 就绪状态检查（用于 Docker 健康检查）
 */
app.get("/health/ready", async (req, res) => {
  try {
    // 检查所有依赖是否就绪
    const rpcHealth = getRpcHealthPool().getStatus();
    const rpcReady = rpcHealth.healthy.length > 0;
    
    let queueReady = false;
    try {
      const client = await txQueue.client;
      await client.ping();
      queueReady = true;
    } catch (error) {
      queueReady = false;
    }
    
    const ready = rpcReady && queueReady;
    
    if (ready) {
      return res.json({ ready: true, status: "ok" });
    } else {
      return res.status(503).json({ 
        ready: false, 
        status: "not_ready",
        checks: {
          rpc: rpcReady,
          queue: queueReady
        }
      });
    }
  } catch (error: any) {
    return res.status(503).json({ 
      ready: false, 
      status: "error",
      error: error.message 
    });
  }
});

/**
 * RPC 健康池状态
 */
app.get("/api/v1/rpc-health", (req, res) => {
  try {
    const { getRpcHealthPool } = require("./utils/rpcHealthPool.js");
    const healthPool = getRpcHealthPool();
    const status = healthPool.getStatus();
    
    res.json({
      success: true,
      ...status
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/v1/getMyAddr", async (req, res) => {
   try {
    const eoaAddress = req.query.eoaAddress as string;
    if (!eoaAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing address parameter"
      })
    }

    const safeAddress = await safeModule.getSafeAddress(eoaAddress);

    return res.json({
      success: true,
      eoaAddress,
      safeAddress
    })

   } catch (error: any) {
      console.error(error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
   }
})

/**
 * 检查 Safe 钱包是否已部署
 */
app.get("/api/v1/checkSafeDeployed", async (req, res) => {
  try {
    const eoaAddress = req.query.eoaAddress as string; 
    const safeAddr = await safeModule.getSafeAddress(eoaAddress);
    if (!safeAddr) {
      return res.status(400).json({
        success: false,
        error: "Missing address parameter"
      });
    }

    const isDeployed = await safeModule.isSafeDeployed(safeAddr);

    return res.json({
      success: true,
      safeAddress: safeAddr,
      isDeployed
    });

  } catch (error: any) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
})

/**
 * Relayer 代付 gas 部署 Safe
 */
app.post("/api/v1/deploy-safe", async (req, res, next) => {
  try {
    const { userAddress } = req.body;
    
    // 参数验证
    validateRequired(req.body, ['userAddress']);
    validateAddress(userAddress, '用户地址');

    logger.info("🚀 开始部署 Safe", { userAddress });
    const result = await safeModule.deploySafeByRelayer({
      userAddress
    });
    
    return res.json(successResponse(result));

  } catch (err: any) {
    next(err);
  }
});

/**
 * 准备 Safe 交易并收取 ERC20 gas 费
 * 返回 safeTxHash 供前端签名
 */
app.post("/api/v1/prepare-transaction-with-fee", async (req, res) => {
  try {
    const { safeAddress, to, value, data } = req.body;
    
    if (!safeAddress || !to || !data) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: safeAddress, to, data"
      });
    }

    const result = await configModule.prepareConfigWithFee({
      safeAddress,
      to,
      value: value || "0",
      data
    });
    
    return res.json({
      success: true,
      ...result
    });

  } catch (err: any) {
    console.error("❌ 准备交易失败:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 执行 Safe 交易（异步队列）
 */
app.post("/api/v1/execute-transaction", async (req, res, next) => {
  try {
    const { safeAddress, safeTransaction, signature, userAddress, safeTxHash } = req.body;
    
    // 参数验证
    validateRequired(req.body, ['safeAddress', 'safeTransaction', 'signature', 'userAddress']);
    validateAddress(safeAddress, 'Safe 地址');
    validateAddress(userAddress, '用户地址');
    validateSignature(signature);

    logger.info("📥 交易加入队列", { safeAddress, userAddress });
    
    // 添加到队列（BullMQ 不需要 job type）
    const job = await txQueue.add('execute-transaction', {
      safeAddress,
      safeTransaction,
      signature,
      userAddress,
      safeTxHash
    });
    
    logger.info(`✅ 任务已入队: ${job.id}`);
    
    // 立即返回任务 ID
    return res.json(successResponse({
      jobId: job.id,
      status: 'queued',
      message: '交易已加入队列，请使用 jobId 查询状态'
    }));

  } catch (err: any) {
    next(err);
  }
});

/**
 * 查询任务状态
 */
app.get("/api/v1/transaction/:jobId", async (req, res, next) => {
  try {
    const job = await txQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json(
        errorResponse('JOB_NOT_FOUND', '任务不存在', { jobId: req.params.jobId })
      );
    }

    const state = await job.getState();
    
    return res.json(successResponse({
      jobId: job.id,
      state,           // 'waiting', 'active', 'completed', 'failed'
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    }));
  } catch (error: any) {
    next(error);
  }
});

/**
 * 查询订单信息
 */
app.get("/api/v1/getOrders", async (req, res, next) => {
  try {
    const { orderHash } = req.query;
    
    // 参数验证
    if (!orderHash || typeof orderHash !== 'string') {
      return res.status(400).json(
        errorResponse('INVALID_PARAMETER', '缺少 orderHash 参数')
      );
    }

    // 查询订单（动态获取合约实例，确保使用健康的 RPC）
    const marketContract = getMarketContract();
    const order = await marketContract.orders(orderHash);

    // 检查订单是否存在（buyer 为零地址表示不存在）
    if (order.buyer === ethers.ZeroAddress) {
      return res.status(404).json(
        errorResponse('ORDER_NOT_FOUND', '订单不存在', { orderHash })
      );
    }

    // 格式化返回数据
    const orderData = {
      orderHash,
      postId: order.postId,
      buyer: order.buyer,
      seller: order.seller,
      createdAt: Number(order.createdAt),
      quantity: Number(order.quantity),
      unitPrice: order.unitPrice.toString(),
      redeemed: order.redeemed
    };

    return res.json(successResponse(orderData));
  } catch (error) {
    next(error);
  }
});

/**
 * 监控指标接口
 */
app.get("/api/v1/metrics", async (req, res, next) => {
  try {
    const queueCounts = await txQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    const isPaused = await txQueue.isPaused();
    const rpcHealth = getRpcHealthPool().getStatus();
    
    return res.json(successResponse({
      queue: {
        ...queueCounts,
        isPaused,
        name: txQueue.name,
        prefix: '{queue}',
        workers: {
          concurrency: 8,
          instances: 3
        }
      },
      rpc: {
        healthy: rpcHealth.healthy.length,
        unhealthy: rpcHealth.unhealthy.length,
        healthyUrls: rpcHealth.healthy,
        unhealthyUrls: rpcHealth.unhealthy,
        current: rpcHealth.current
      },
      system: {
        uptime: process.uptime(),
        memory: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
          external: Math.round(process.memoryUsage().external / 1024 / 1024) + ' MB'
        },
        pid: process.pid,
        nodeVersion: process.version
      }
    }));
  } catch (error: any) {
    next(error);
  }
});

// 404 处理
app.use((req, res) => {
  res.status(404).json(errorResponse(
    'NOT_FOUND',
    `路径 ${req.path} 不存在`
  ));
});

// 全局错误处理（放在最后）
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Relayer 启动成功`);
  logger.info(`   监听地址: http://0.0.0.0:${PORT}`);
  logger.info(`   可访问: http://localhost:${PORT}`);
});

// 全局未捕获异常处理
process.on('unhandledRejection', (reason: any, promise) => {
  logger.error('❌ 未处理的 Promise 拒绝', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

process.on('uncaughtException', (error: Error) => {
  logger.error('❌ 未捕获的异常', {
    error: error.message,
    stack: error.stack
  });
  // 给日志系统一点时间写入
  setTimeout(() => {
    process.exit(1); // 退出让 Docker 重启
  }, 1000);
});

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('📛 收到 SIGTERM 信号，开始优雅关闭...');
  
  // 停止接受新请求
  logger.info('⏸️  停止接受新请求');
  
  // 等待队列任务完成（最多等待 30 秒）
  logger.info('⏳ 等待队列任务完成...');
  await txQueue.close();
  
  logger.info('✅ 服务已关闭');
  process.exit(0);
});