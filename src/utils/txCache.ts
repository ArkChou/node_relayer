import { getRedisCluster } from "./nonce.js";

export interface CachedTransaction {
  nonce: number;
  to: string;
  value: string;
  data: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  timestamp: number;
  retryCount: number;
  originalMaxFeePerGas: string;
  originalMaxPriorityFeePerGas: string;
}

/**
 * 保存交易到缓存
 */
export async function saveTxToCache(
  address: string,
  nonce: number,
  tx: Omit<CachedTransaction, 'timestamp' | 'retryCount' | 'originalMaxFeePerGas' | 'originalMaxPriorityFeePerGas'>
): Promise<void> {
  const redis = getRedisCluster();
  const key = `tx_cache:${address.toLowerCase()}:${nonce}`;
  
  const cachedTx: CachedTransaction = {
    ...tx,
    timestamp: Date.now(),
    retryCount: 0,
    originalMaxFeePerGas: tx.maxFeePerGas,
    originalMaxPriorityFeePerGas: tx.maxPriorityFeePerGas
  };
  
  // 设置 24 小时过期时间
  await redis.set(key, JSON.stringify(cachedTx), 'EX', 24 * 60 * 60);
  console.log(`💾 交易已缓存: nonce=${nonce}, to=${tx.to}`);
}

/**
 * 获取缓存的交易
 */
export async function getTxFromCache(
  address: string,
  nonce: number
): Promise<CachedTransaction | null> {
  const redis = getRedisCluster();
  const key = `tx_cache:${address.toLowerCase()}:${nonce}`;
  
  const data = await redis.get(key);
  if (!data) {
    return null;
  }
  
  return JSON.parse(data) as CachedTransaction;
}

/**
 * 删除缓存的交易
 */
export async function deleteTxFromCache(
  address: string,
  nonce: number
): Promise<void> {
  const redis = getRedisCluster();
  const key = `tx_cache:${address.toLowerCase()}:${nonce}`;
  await redis.del(key);
}

/**
 * 批量删除已确认的交易缓存
 */
export async function deleteConfirmedTxCache(
  address: string,
  confirmedNonce: number
): Promise<void> {
  const redis = getRedisCluster();
  const pattern = `tx_cache:${address.toLowerCase()}:*`;
  
  const keys = await redis.keys(pattern);
  const toDelete: string[] = [];
  
  for (const key of keys) {
    const nonce = parseInt(key.split(':')[2]);
    if (nonce <= confirmedNonce) {
      toDelete.push(key);
    }
  }
  
  if (toDelete.length > 0) {
    // Redis Cluster 不支持批量删除不同 slot 的 key，需要逐个删除
    for (const key of toDelete) {
      await redis.del(key);
    }
    console.log(`🗑️ 已删除 ${toDelete.length} 个已确认交易的缓存`);
  }
}

/**
 * 更新交易重试次数
 */
export async function incrementTxRetryCount(
  address: string,
  nonce: number
): Promise<void> {
  const tx = await getTxFromCache(address, nonce);
  if (tx) {
    tx.retryCount++;
    const redis = getRedisCluster();
    const key = `tx_cache:${address.toLowerCase()}:${nonce}`;
    await redis.set(key, JSON.stringify(tx));
  }
}
