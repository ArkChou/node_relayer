import express from "express";
import safeModule from "./api/safe.js";
import transferModule from "./api/sendTx.js";
import configModule from "./api/prepare.js";
import cors from "cors";
import dotenv from "dotenv";
import { initRpcHealthPool } from "./utils/rpcHealthPool.js";
import { RPC_URLS, tokenInfo } from "./config/config.js";
import { startNonceMonitor } from "./utils/nonceMonitor.js";
import { txQueue } from "./queue/txQueue.js";
import "./queue/worker.js";

dotenv.config();

// 初始化 RPC 健康池
initRpcHealthPool(RPC_URLS);

// 启动 Nonce 监控任务
startNonceMonitor(tokenInfo.RELAYER_ADDRESS);
console.log("✅ Nonce 监控任务已启动");

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 9525;

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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "v1.0.0",
    timestamp: Date.now(),
    uptime: process.uptime()
  });
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
app.post("/api/v1/deploy-safe", async (req, res) => {
  try {
    const { userAddress } = req.body;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: userAddress"
      });
    }

    console.log("\n🚀 开始部署 Safe...");
    const result = await safeModule.deploySafeByRelayer({
      userAddress
    });
    
    return res.json({
      success: true,
      ...result
    });

  } catch (err: any) {
    console.error("❌ 部署失败:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});


/**
 * 准备 Safe 交易（ERC20 转账、合约调用等）
 * 返回 safeTxHash 供前端签名
 */
app.post("/api/v1/prepare-transaction", async (req, res) => {
  try {
    const { safeAddress, to, value, data } = req.body;
    
    if (!safeAddress || !to || !data) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: safeAddress, to, data"
      });
    }

    console.log("\n📝 准备 Safe 交易...");
    const result = await configModule.prepareConfig({
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
app.post("/api/v1/execute-transaction", async (req, res) => {
  try {
    const { safeAddress, safeTransaction, signature, userAddress, safeTxHash } = req.body;
    
    if (!safeAddress || !safeTransaction || !signature || !userAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: safeAddress, safeTransaction, signature, userAddress"
      });
    }

    console.log("\n📥 交易加入队列...");
    
    // 添加到队列
    const job = await txQueue.add('execute', {
      safeAddress,
      safeTransaction,
      signature,
      userAddress,
      safeTxHash
    });
    
    console.log(`✅ 任务已入队: ${job.id}`);
    
    // 立即返回任务 ID
    return res.json({
      success: true,
      jobId: job.id,
      status: 'queued',
      message: '交易已加入队列，请使用 jobId 查询状态'
    });

  } catch (err: any) {
    console.error("❌ 入队失败:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 查询任务状态
 */
app.get("/api/v1/transaction/:jobId", async (req, res) => {
  try {
    const job = await txQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    const state = await job.getState();
    const progress = job.progress();
    
    return res.json({
      success: true,
      jobId: job.id,
      state,           // 'waiting', 'active', 'completed', 'failed'
      progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Relayer running on http://0.0.0.0:${PORT}`);
  console.log(`   可访问: http://localhost:${PORT}`);
});