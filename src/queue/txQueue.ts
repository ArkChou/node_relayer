import Queue from 'bull';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Safe 交易队列
 */
export const txQueue = new Queue('safe-transactions', {
  redis: {
    host: 'redis-node-1',
    port: 6379,
    password: process.env.REDIS_PASSWORD,
  },
  settings: {
    maxStalledCount: 3,      // 最多重试 3 次
    stalledInterval: 30000,  // 30 秒检查一次卡住的任务
  },
  defaultJobOptions: {
    attempts: 3,             // 失败重试 3 次
    backoff: {
      type: 'exponential',
      delay: 2000,           // 指数退避，初始 2 秒
    },
    removeOnComplete: 100,   // 保留最近 100 个完成的任务
    removeOnFail: 100,       // 保留最近 100 个失败的任务
  },
});

// 监听队列事件
txQueue.on('completed', (job, result) => {
  console.log(`✅ 任务完成: ${job.id}`, {
    txHash: result.txHash,
    duration: Date.now() - job.timestamp,
  });
});

txQueue.on('failed', (job, err) => {
  console.error(`❌ 任务失败: ${job.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

txQueue.on('stalled', (job) => {
  console.warn(`⚠️ 任务卡住: ${job.id}`);
});

console.log('📦 队列已初始化');
