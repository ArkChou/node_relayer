import { Cluster } from "ioredis";
import { getTransactionCount } from "./rpcWrapper.js";

let redisCluster: Cluster | null = null;

/**
 * 初始化 Redis 集群连接
 */
export function getRedisCluster(): Cluster {
  if (!redisCluster) {
    const nodes = process.env.REDIS_CLUSTER_NODES?.split(',') || ['localhost:6379'];
    
    redisCluster = new Cluster(
      nodes.map(node => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port) };
      }),
      {
        redisOptions: {
          password: process.env.REDIS_PASSWORD,
        },
        clusterRetryStrategy: (times: any) => {
          const delay = Math.min(100 + times * 10, 2000);
          return delay;
        },
      }
    );

    redisCluster.on('error', (err: any) => {
      console.error('❌ Redis Cluster 错误:', err);
    });

    redisCluster.on('ready', () => {
      console.log('✅ Redis Cluster 已连接');
    });
  }

  return redisCluster;
}

/**
 * 从 Redis 获取下一个可用的 nonce（双 nonce 机制）
 * pending_nonce: 下一个可分配的 nonce（原子递增，支持并发）
 * confirmed_nonce: 链上已确认的 nonce（由定时任务同步）
 */
export async function acquireNonce(address: string): Promise<number> {
  const redis = getRedisCluster();
  const pendingKey = `pending_nonce:${address.toLowerCase()}`;
  const confirmedKey = `confirmed_nonce:${address.toLowerCase()}`;

  try {
    // 获取 confirmed_nonce（链上下一个可用的 nonce）
    const confirmedNonceStr = await redis.get(confirmedKey);
    const confirmedNonce = confirmedNonceStr ? parseInt(confirmedNonceStr) : null;

    // 检查 pending_nonce 是否存在
    const pendingNonceStr = await redis.get(pendingKey);
    
    if (!pendingNonceStr) {
      // 第一次使用，从链上同步
      const chainNonce = await getTransactionCount(address, 'latest');
      await redis.set(pendingKey, chainNonce);
      await redis.set(confirmedKey, chainNonce);
      console.log(`🆕 初始化 nonce: pending=${chainNonce}, confirmed=${chainNonce}`);
      return chainNonce;
    }

    const pendingNonce = parseInt(pendingNonceStr);

    // 关键修复：如果 pending_nonce < confirmed_nonce，说明 Redis 数据过期，需要重置
    if (confirmedNonce !== null && pendingNonce < confirmedNonce) {
      console.log(`⚠️ pending_nonce(${pendingNonce}) < confirmed_nonce(${confirmedNonce})，重置 pending_nonce`);
      // 重置 pending_nonce 为 confirmed_nonce，然后递增
      await redis.set(pendingKey, confirmedNonce);
      const nextNonce = await redis.incr(pendingKey);
      const allocatedNonce = nextNonce - 1;
      console.log(`🔢 分配 nonce: ${allocatedNonce}，pending_nonce 已更新为: ${nextNonce}`);
      return allocatedNonce;
    }

    // 原子递增 pending_nonce（支持并发）
    const nextNonce = await redis.incr(pendingKey);
    const allocatedNonce = nextNonce - 1;
    
    console.log(`🔢 分配 nonce: ${allocatedNonce}`);
    return allocatedNonce;
  } catch (error) {
    console.error('❌ 获取 nonce 失败，使用链上降级方案:', error);
    const chainNonce = await getTransactionCount(address, 'latest');
    return chainNonce;
  }
}

/**
 * 重置 nonce（用于错误恢复）
 */
export async function resetNonce(address: string): Promise<void> {
  const redis = getRedisCluster();
  const key = `nonce:${address.toLowerCase()}`;
  
  try {
    const chainNonce = await getTransactionCount(address, 'pending');
    
    await redis.set(key, chainNonce);
    console.log(`✅ Nonce 已重置: ${address} -> ${chainNonce}`);
  } catch (error) {
    console.error('❌ 重置 nonce 失败:', error);
    throw error;
  }
}

/**
 * 获取当前 nonce（不递增）
 */
export async function getCurrentNonce(address: string): Promise<number> {
  const redis = getRedisCluster();
  const key = `nonce:${address.toLowerCase()}`;
  
  try {
    const nonce = await redis.get(key);
    
    if (nonce === null) {
      // 如果 Redis 中没有，从链上获取
      const chainNonce = await getTransactionCount(address, 'pending');
      await redis.set(key, chainNonce);
      return chainNonce;
    }
    
    return parseInt(nonce);
  } catch (error) {
    console.error('❌ 获取当前 nonce 失败:', error);
    
    // 降级方案
    return await getTransactionCount(address, 'pending');
  }
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis(): Promise<void> {
  if (redisCluster) {
    await redisCluster.quit();
    redisCluster = null;
    console.log('✅ Redis 连接已关闭');
  }
}
