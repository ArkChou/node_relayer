import { getRedisCluster, acquireNonce } from "./nonce.js";
import { getTransactionCount, sendTransaction } from "./rpcWrapper.js";
import { getTxFromCache, deleteTxFromCache, deleteConfirmedTxCache, incrementTxRetryCount, saveTxToCache } from "./txCache.js";
import { getRelayerWallet } from "./provider.js";
import { ethers } from "ethers";

const MONITOR_INTERVAL = 10000; // 6秒检查一次
const LEADER_LOCK_TTL = 15; // 主节点锁 15 秒过期
const LEADER_LOCK_KEY = 'nonce_monitor_leader';

let monitorInterval: NodeJS.Timeout | null = null;
let lastConfirmedNonce: number | null = null;
// 记录失败的 nonce 和失败时间，避免无限重试
const failedNonces = new Map<number, number>(); // nonce -> 失败时间戳
const FAILED_NONCE_COOLDOWN = 60000; // 60秒冷却期

/**
 * 启动 Nonce 监控任务（主节点选举）
 */
export function startNonceMonitor(relayerAddress: string): void {
  if (monitorInterval) {
    console.log('⚠️ Nonce 监控任务已在运行');
    return;
  }

  console.log('🚀 启动 Nonce 监控任务...');
  
  monitorInterval = setInterval(async () => {
    try {
      await runMonitorTask(relayerAddress);
    } catch (error) {
      console.error('❌ Nonce 监控任务执行失败:', error);
    }
  }, MONITOR_INTERVAL);
}

/**
 * 停止 Nonce 监控任务
 */
export function stopNonceMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('🛑 Nonce 监控任务已停止');
  }
}

/**
 * 执行监控任务（尝试获取主节点锁）
 */
async function runMonitorTask(relayerAddress: string): Promise<void> {
  const redis = getRedisCluster();
  
  // 尝试获取主节点锁（SET NX EX）
  const lockAcquired = await redis.set(
    LEADER_LOCK_KEY,
    process.pid.toString(),
    'EX',
    LEADER_LOCK_TTL,
    'NX'
  );

  if (!lockAcquired) {
    // 未获取到锁，说明其他节点是主节点
    return;
  }

  console.log('👑 当前节点是主节点，执行监控任务...');

  try {
    // 1. 同步 confirmed_nonce
    await syncConfirmedNonce(relayerAddress);

    // 2. 检查并重发卡住的交易
    await checkAndResendStuckTransaction(relayerAddress);

    // 3. 清理已确认的交易缓存
    await cleanupConfirmedTransactions(relayerAddress);
  } catch (error) {
    console.error('❌ 监控任务执行失败:', error);
  }
}

/**
 * 同步链上已确认的 nonce
 */
async function syncConfirmedNonce(address: string): Promise<void> {
  const redis = getRedisCluster();
  const confirmedKey = `confirmed_nonce:${address.toLowerCase()}`;

  // 获取链上最新的 confirmed nonce（使用 'latest' 只统计已确认的交易）
  const chainNonce = await getTransactionCount(address, 'latest');
  
  // 更新 Redis
  await redis.set(confirmedKey, chainNonce);
  
  console.log(`🔄 同步 confirmed_nonce: ${chainNonce}`);
}

/**
 * 检查并重发卡住的交易
 */
async function checkAndResendStuckTransaction(address: string): Promise<void> {
  const redis = getRedisCluster();
  const confirmedKey = `confirmed_nonce:${address.toLowerCase()}`;
  const pendingKey = `pending_nonce:${address.toLowerCase()}`;

  const confirmedNonceStr = await redis.get(confirmedKey);
  const pendingNonceStr = await redis.get(pendingKey);

  if (!confirmedNonceStr || !pendingNonceStr) {
    return;
  }

  const confirmedNonce = parseInt(confirmedNonceStr);
  const pendingNonce = parseInt(pendingNonceStr);

  // 检查是否有卡住的交易
  if (pendingNonce <= confirmedNonce) {
    // 没有待确认的交易
    lastConfirmedNonce = confirmedNonce;
    return;
  }

  // 检查 confirmed_nonce 是否卡住（6秒没变化）
  if (lastConfirmedNonce !== null && lastConfirmedNonce === confirmedNonce) {
    console.log(`⚠️ 检测到交易卡住: confirmed=${confirmedNonce}, pending=${pendingNonce}`);
    
    // confirmed_nonce 本身就是下一个应该发送的 nonce（getTransactionCount 返回的是下一个可用 nonce）
    // 所以卡住的 nonce 就是 confirmedNonce，不是 confirmedNonce + 1
    const stuckNonce = confirmedNonce;
    await resendTransaction(address, stuckNonce);
  }

  lastConfirmedNonce = confirmedNonce;
}

/**
 * 重发卡住的交易
 */
async function resendTransaction(address: string, nonce: number): Promise<void> {
  const cachedTx = await getTxFromCache(address, nonce);
  
  if (!cachedTx) {
    console.log(`⚠️ 未找到 nonce=${nonce} 的交易缓存，直接自转占用此 nonce`);
    await selfTransferToSkipNonce(address, nonce, null);
    return;
  }

  // 检查交易发送时间，只有超过 6 秒才认为卡住
  const now = Date.now();
  const txAge = now - cachedTx.timestamp;
  const minWaitTime = 6000; // 6 秒
  
  if (txAge < minWaitTime) {
    const remainingTime = Math.ceil((minWaitTime - txAge) / 1000);
    console.log(`⏳ nonce=${nonce} 的交易刚发送 ${Math.floor(txAge / 1000)} 秒，还需等待 ${remainingTime} 秒`);
    return;
  }

  console.log(`⚠️ nonce=${nonce} 的交易已发送 ${Math.floor(txAge / 1000)} 秒，认为卡住，准备重发`);

  // 检查重试次数
  if (cachedTx.retryCount >= 1) {
    console.log(`❌ nonce=${nonce} 已重发过，使用自转占用此 nonce`);
    await selfTransferToSkipNonce(address, nonce, cachedTx);
    return;
  }

  // 提高 20% gas 重发
  const newMaxFeePerGas = (BigInt(cachedTx.originalMaxFeePerGas) * 120n) / 100n;
  const newMaxPriorityFeePerGas = (BigInt(cachedTx.originalMaxPriorityFeePerGas) * 120n) / 100n;

  console.log(`🔄 重发交易: nonce=${nonce}, gas 提升 20%`);
  console.log(`   原始 maxFeePerGas: ${cachedTx.originalMaxFeePerGas}`);
  console.log(`   新的 maxFeePerGas: ${newMaxFeePerGas.toString()}`);

  try {
    const wallet = getRelayerWallet();
    const tx = await sendTransaction(wallet, {
      to: cachedTx.to,
      value: cachedTx.value,
      data: cachedTx.data,
      gasLimit: BigInt(cachedTx.gasLimit),
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      nonce: nonce
    });

    console.log(`✅ 交易重发成功: txHash=${tx.hash}`);
    
    // 更新重试次数
    await incrementTxRetryCount(address, nonce);
  } catch (error: any) {
    console.error(`❌ 交易重发失败: ${error.message}`);
  }
}

/**
 * 自转占用 nonce（当重发失败时）
 */
async function selfTransferToSkipNonce(
  address: string,
  nonce: number,
  cachedTx: any | null
): Promise<void> {
  console.log(`🔄 执行自转占用 nonce=${nonce}`);

  const wallet = getRelayerWallet();
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;

  // 获取初始 gas 价格
  if (cachedTx) {
    // 有缓存，使用原始 gas * 1.5
    maxFeePerGas = (BigInt(cachedTx.originalMaxFeePerGas) * 150n) / 100n;
    maxPriorityFeePerGas = (BigInt(cachedTx.originalMaxPriorityFeePerGas) * 150n) / 100n;
    console.log(`📊 使用缓存的 gas (x1.5):`);
    console.log(`   原始 maxFeePerGas: ${cachedTx.originalMaxFeePerGas}`);
    console.log(`   新的 maxFeePerGas: ${maxFeePerGas.toString()}`);
  } else {
    // 无缓存，直接使用一个较高的 gas（3 Gwei），避免从链上低 gas 开始导致多次失败
    // 因为如果 mempool 中已经有交易，链上 gas 会很低，导致替换失败
    maxFeePerGas = 3000000000n; // 3 Gwei
    maxPriorityFeePerGas = 500000000n; // 0.5 Gwei
    console.log(`📊 无缓存，使用较高的初始 gas（避免 underpriced）:`);
    console.log(`   初始 maxFeePerGas: ${maxFeePerGas.toString()} (3 Gwei)`);
    console.log(`   初始 maxPriorityFeePerGas: ${maxPriorityFeePerGas.toString()} (0.5 Gwei)`);
  }

  try {
    console.log(`📤 发送自转交易，参数:`);
    console.log(`   to: ${address}`);
    console.log(`   value: 0`);
    console.log(`   nonce: ${nonce}`);
    console.log(`   gasLimit: 21000`);
    console.log(`   maxFeePerGas: ${maxFeePerGas.toString()}`);
    console.log(`   maxPriorityFeePerGas: ${maxPriorityFeePerGas.toString()}`);

    const tx = await sendTransaction(wallet, {
      to: address, // 给自己转账
      value: "0",
      data: "0x",
      gasLimit: 21000n,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFeePerGas,
      nonce: nonce
    });

    console.log(`✅ 自转交易已发送: txHash=${tx.hash}`);
    console.log(`   查看交易: https://sepolia.basescan.org/tx/${tx.hash}`);
    
    // 如果有原交易缓存，用新 nonce 重新发送原交易
    if (cachedTx) {
      console.log(`🔄 自转成功，准备用新 nonce 重新发送原交易...`);
      await resendWithNewNonce(address, cachedTx);
      // 删除旧的交易缓存
      await deleteTxFromCache(address, nonce);
    }
  } catch (error: any) {
    // 如果是 "already known" 或 "replacement fee too low" 错误，说明交易已经在 mempool 中但未确认
    // 需要提高 gas 替换交易
    const isAlreadyKnown = error.message && error.message.includes('already known');
    const isReplacementUnderpriced = error.message && (error.message.includes('replacement fee too low') || error.message.includes('replacement transaction underpriced'));
    
    if (isAlreadyKnown || isReplacementUnderpriced) {
      if (isAlreadyKnown) {
        console.log(`⚠️ nonce=${nonce} 的交易在 mempool 中但未确认，提高 gas 替换交易`);
      } else {
        console.log(`⚠️ nonce=${nonce} 的替换交易 gas 太低，继续提高 gas`);
      }
      
      // 递归提高 gas，最多尝试 3 次
      await tryReplaceWithHigherGas(wallet, address, nonce, maxFeePerGas, maxPriorityFeePerGas, cachedTx, 1, 3);
    } else {
      console.error(`❌ 自转失败: ${error.message}`);
    }
  }
}

/**
 * 递归提高 gas 替换交易
 */
async function tryReplaceWithHigherGas(
  wallet: any,
  address: string,
  nonce: number,
  currentMaxFeePerGas: bigint,
  currentMaxPriorityFeePerGas: bigint,
  cachedTx: any | null,
  attempt: number,
  maxAttempts: number
): Promise<void> {
  if (attempt > maxAttempts) {
    console.log(`⚠️ 已达到最大尝试次数 (${maxAttempts})，停止替换交易`);
    console.log(`⚠️ nonce=${nonce} 的交易可能需要手动处理或等待原交易确认`);
    return;
  }

  // 提高 110% gas（Base 网络要求至少 10% 提升，我们用 110% 确保成功）
  let newMaxFeePerGas = currentMaxFeePerGas * 110n / 100n + 1n; // +1 wei 确保满足要求
  let newMaxPriorityFeePerGas = currentMaxPriorityFeePerGas * 110n / 100n + 1n;

  // 确保最小 gas 价格（防止 gas 太低）
  const minMaxFeePerGas = 2000000000n; // 2 Gwei
  const minMaxPriorityFeePerGas = 1000000000n; // 1 Gwei
  
  if (newMaxFeePerGas < minMaxFeePerGas) {
    newMaxFeePerGas = minMaxFeePerGas;
  }
  if (newMaxPriorityFeePerGas < minMaxPriorityFeePerGas) {
    newMaxPriorityFeePerGas = minMaxPriorityFeePerGas;
  }

  console.log(`🔄 第 ${attempt} 次尝试替换交易:`);
  console.log(`   原始 maxFeePerGas: ${currentMaxFeePerGas.toString()}`);
  console.log(`   新的 maxFeePerGas: ${newMaxFeePerGas.toString()} (提高 100%)`);
  console.log(`   新的 maxPriorityFeePerGas: ${newMaxPriorityFeePerGas.toString()}`);

  try {
    const { sendTransaction } = await import('./rpcWrapper.js');
    const replaceTx = await sendTransaction(wallet, {
      to: address,
      value: "0",
      data: "0x",
      gasLimit: 21000n,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      nonce: nonce
    });

    console.log(`✅ 替换交易已发送: txHash=${replaceTx.hash}`);
    console.log(`   查看交易: https://sepolia.basescan.org/tx/${replaceTx.hash}`);
    
    // 如果有原交易缓存，用新 nonce 重新发送原交易
    if (cachedTx) {
      console.log(`🔄 替换成功，准备用新 nonce 重新发送原交易...`);
      await resendWithNewNonce(address, cachedTx);
      // 删除旧的交易缓存
      const { deleteTxFromCache } = await import('./txCache.js');
      await deleteTxFromCache(address, nonce);
    }
  } catch (replaceError: any) {
    console.error(`❌ 第 ${attempt} 次替换交易失败: ${replaceError.message}`);
    
    // 如果还是 "already known" 或 "replacement underpriced"，继续提高 gas
    const isStillAlreadyKnown = replaceError.message && replaceError.message.includes('already known');
    const isStillUnderpriced = replaceError.message && (replaceError.message.includes('replacement fee too low') || replaceError.message.includes('replacement transaction underpriced'));
    
    if (isStillAlreadyKnown || isStillUnderpriced) {
      console.log(`⚠️ 继续提高 gas 重试...`);
      // 递归调用，继续提高 gas
      await tryReplaceWithHigherGas(wallet, address, nonce, newMaxFeePerGas, newMaxPriorityFeePerGas, cachedTx, attempt + 1, maxAttempts);
    } else {
      console.error(`❌ 替换交易遇到其他错误，停止重试`);
    }
  }
}

/**
 * 用新 nonce 重新发送原交易
 */
async function resendWithNewNonce(address: string, cachedTx: any): Promise<void> {
  try {
    // 调用 acquireNonce 获取新的 nonce（这会自动更新 pending_nonce）
    const newNonce = await acquireNonce(address);
    console.log(`📝 获取新 nonce: ${newNonce}`);
    
    const wallet = getRelayerWallet();
    
    // 使用原始交易的 gas 参数重新发送
    const tx = await sendTransaction(wallet, {
      to: cachedTx.to,
      value: cachedTx.value,
      data: cachedTx.data,
      gasLimit: BigInt(cachedTx.gasLimit),
      maxFeePerGas: BigInt(cachedTx.originalMaxFeePerGas),
      maxPriorityFeePerGas: BigInt(cachedTx.originalMaxPriorityFeePerGas),
      nonce: newNonce
    });
    
    console.log(`✅ 原交易已用新 nonce=${newNonce} 重新发送: txHash=${tx.hash}`);
    console.log(`   查看交易: https://sepolia.basescan.org/tx/${tx.hash}`);
    
    // 保存新的交易缓存
    await saveTxToCache(address, newNonce, {
      nonce: newNonce,
      to: cachedTx.to,
      value: cachedTx.value,
      data: cachedTx.data,
      gasLimit: cachedTx.gasLimit,
      maxFeePerGas: cachedTx.originalMaxFeePerGas,
      maxPriorityFeePerGas: cachedTx.originalMaxPriorityFeePerGas
    });
  } catch (error: any) {
    console.error(`❌ 用新 nonce 重新发送原交易失败: ${error.message}`);
  }
}

/**
 * 清理已确认的交易缓存
 */
async function cleanupConfirmedTransactions(address: string): Promise<void> {
  const redis = getRedisCluster();
  const confirmedKey = `confirmed_nonce:${address.toLowerCase()}`;
  
  const confirmedNonceStr = await redis.get(confirmedKey);
  if (!confirmedNonceStr) {
    return;
  }

  const confirmedNonce = parseInt(confirmedNonceStr);
  
  // 删除 nonce <= confirmedNonce 的所有交易缓存
  await deleteConfirmedTxCache(address, confirmedNonce);
}
