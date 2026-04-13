import { txQueue } from './txQueue.js';
import transferModule from '../api/sendTx.js';

/**
 * Worker 处理队列任务
 * 并发数：5（推荐配置：3 实例 × 5 = 15 个任务同时执行）
 */
const CONCURRENCY = 8;

txQueue.process('execute', CONCURRENCY, async (job) => {
  const { safeAddress, safeTransaction, signature, userAddress, safeTxHash } = job.data;
  
  console.log(`🔄 开始处理任务: ${job.id}`);
  console.log(`📊 队列状态: 等待=${await txQueue.getWaitingCount()}, 活跃=${await txQueue.getActiveCount()}`);
  
  try {
    // 调用原有的执行函数
    const result = await transferModule.executeSafeTransaction({
      safeAddress,
      safeTransaction,
      signature,
      userAddress,
      safeTxHash,
    });
    
    console.log(`✅ 任务成功: ${job.id}`, {
      txHash: result.txHash,
      status: result.status,
    });
    
    return result;
  } catch (error: any) {
    console.error(`❌ 任务失败: ${job.id}`, error.message);
    throw error; // 抛出错误，触发重试
  }
});

console.log(`🚀 Worker 已启动，并发数: ${CONCURRENCY}`);
