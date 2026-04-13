import { Queue, QueueEvents } from 'bullmq';
import { Cluster } from 'ioredis';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

// Redis Cluster 配置
const redisNodes = (process.env.REDIS_CLUSTER_NODES || 'redis-node-1:6379,redis-node-2:6379,redis-node-3:6379')
  .split(',')
  .map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port) };
  });

/**
 * 共享的 Redis Cluster 连接实例
 * 所有 BullMQ 组件（Queue, Worker, QueueEvents）共享此连接
 */
export const clusterConnection = new Cluster(redisNodes, {
  redisOptions: {
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  },
  enableReadyCheck: false,
});

/**
 * Safe 交易队列（BullMQ + Redis Cluster）
 * 使用 {queue} hash tag 确保所有 key 在同一个 slot
 */
export const txQueue = new Queue('safe-transactions', {
  connection: clusterConnection,  // 使用共享连接
  prefix: '{queue}',  // 关键：使用 hash tag 让所有 key 在同一个 slot
  defaultJobOptions: {
    attempts: 3,             // 失败重试 3 次
    backoff: {
      type: 'exponential',
      delay: 2000,           // 指数退避，初始 2 秒
    },
    removeOnComplete: {
      count: 100,            // 保留最近 100 个完成的任务
    },
    removeOnFail: {
      count: 100,            // 保留最近 100 个失败的任务
    },
  },
});

// 创建 QueueEvents 监听队列事件（使用共享连接）
const queueEvents = new QueueEvents('safe-transactions', {
  connection: clusterConnection,
  prefix: '{queue}',
});

// 任务完成
queueEvents.on('completed', ({ jobId }) => {
  logger.debug(`✅ 任务完成: ${jobId}`);
});

// 任务失败
queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(`❌ 任务失败: ${jobId}`, { failedReason });
});

// 任务卡住
queueEvents.on('stalled', ({ jobId }) => {
  logger.warn(`⚠️ 任务卡住: ${jobId}`);
});

// 任务进度更新
queueEvents.on('progress', ({ jobId, data }) => {
  logger.debug(`📊 任务进度: ${jobId}`, { progress: data });
});

// 任务等待中
queueEvents.on('waiting', ({ jobId }) => {
  logger.debug(`⏳ 任务等待: ${jobId}`);
});

// 任务激活（开始处理）
queueEvents.on('active', ({ jobId }) => {
  logger.debug(`🔄 任务激活: ${jobId}`);
});

// 任务延迟
queueEvents.on('delayed', ({ jobId, delay }) => {
  logger.debug(`⏰ 任务延迟: ${jobId}`, { delay });
});

// 任务移除
queueEvents.on('removed', ({ jobId }) => {
  logger.debug(`🗑️ 任务移除: ${jobId}`);
});

// 定期清理旧任务（每小时执行一次）
setInterval(async () => {
  try {
    // 清理 1 小时前完成的任务，保留最近 100 个
    const cleanedCompleted = await txQueue.clean(3600000, 100, 'completed');
    // 清理 24 小时前失败的任务，保留最近 100 个
    const cleanedFailed = await txQueue.clean(86400000, 100, 'failed');
    
    const totalCleaned = cleanedCompleted.length + cleanedFailed.length;
    if (totalCleaned > 0) {
      logger.info(`🧹 清理旧任务`, { 
        completed: cleanedCompleted.length, 
        failed: cleanedFailed.length,
        total: totalCleaned
      });
    }
  } catch (error: any) {
    logger.error('❌ 清理任务失败', { error: error.message });
  }
}, 60 * 60 * 1000); // 每小时

logger.info('📦 队列已初始化（Redis Cluster + Hash Tag）');
