import { Worker, Job } from 'bullmq';
import transferModule from '../api/sendTx.js';
import logger from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { clusterConnection } from './txQueue.js';

/**
 * Worker 处理队列任务
 * 并发数：8（推荐配置：3 实例 × 8 = 24 个任务同时执行）
 */
const CONCURRENCY = 8;

const worker = new Worker('safe-transactions', async (job: Job) => {
  const { safeAddress, safeTransaction, signature, userAddress, safeTxHash } = job.data;
  
  logger.info(`🔄 开始处理任务: ${job.id}`, {
    safeAddress,
    userAddress,
    attempt: job.attemptsMade + 1
  });
  
  try {
    // 调用原有的执行函数
    const result = await transferModule.executeSafeTransaction({
      safeAddress,
      safeTransaction,
      signature,
      userAddress,
      safeTxHash,
    });
    
    logger.info(`✅ 任务成功: ${job.id}`, {
      txHash: result.txHash,
      status: result.status,
    });
    
    return result;
  } catch (error: any) {
    // 区分错误类型，记录详细日志
    if (error instanceof AppError) {
      logger.error(`❌ 业务错误: ${job.id}`, {
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        attempt: job.attemptsMade + 1
      });
    } else {
      logger.error(`❌ 未知错误: ${job.id}`, {
        error: error.message,
        stack: error.stack,
        attempt: job.attemptsMade + 1
      });
    }
    
    throw error; // 抛出错误，触发重试
  }
}, {
  connection: clusterConnection,  // 使用共享连接
  prefix: '{queue}',  // 必须与 Queue 使用相同的 prefix
  concurrency: CONCURRENCY,
});

// 监听 Worker 事件
worker.on('completed', (job) => {
  logger.debug(`✅ Worker 完成任务: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`❌ Worker 任务失败: ${job?.id}`, {
    error: err.message
  });
});

worker.on('error', (err) => {
  logger.error('❌ Worker 错误', { error: err.message });
});

logger.info(`🚀 Worker 已启动，并发数: ${CONCURRENCY}`);
