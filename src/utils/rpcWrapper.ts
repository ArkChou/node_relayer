import { ethers } from "ethers";
import { getRpcHealthPool } from "./rpcHealthPool.js";
import { getProvider } from "./provider.js";

const RPC_TIMEOUT = 10000; // 3 秒超时

/**
 * 包装 RPC 调用，添加超时和自动切换
 */
async function wrapRpcCall<T>(
  operation: string,
  call: () => Promise<T>,
  retryCount = 0,
  maxRetries = 3
): Promise<T> {
  try {
    // 添加超时
    const result = await Promise.race([
      call(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${operation} 超时`)), RPC_TIMEOUT)
      ),
    ]);

    return result;
  } catch (error: any) {
    console.error(`❌ ${operation} 失败:`, error.message);

    // 以下是业务错误，不是 RPC 问题，直接抛出不重试，不标记 RPC 不健康
    const businessErrors = [
      'already known',                      // 交易已在 mempool 中
      'replacement fee too low',            // gas 价格不够高
      'replacement transaction underpriced', // gas 价格不够高
      'nonce too low',                      // nonce 已被使用
      'nonce has already been used',        // nonce 已被使用
      'GS026',                              // Safe 合约签名验证错误
      'GS025',                              // Safe 合约签名验证错误
      'execution reverted'                  // 合约执行失败（通常是业务逻辑错误）
    ];

    const isBusinessError = businessErrors.some(errMsg => 
      error.message && error.message.includes(errMsg)
    );

    if (isBusinessError) {
      // 业务错误，直接抛出，不标记 RPC 不健康
      throw error;
    }

    // 标记当前 RPC 为不健康（只有真正的网络/RPC 错误才标记）
    try {
      const healthPool = getRpcHealthPool();
      healthPool.markCurrentUnhealthy(`${operation} 失败: ${error.message}`);
    } catch (e) {
      // 健康池未初始化，忽略
    }

    // 如果还有重试次数，切换 RPC 后重试
    if (retryCount < maxRetries) {
      console.log(`🔄 重试 ${operation} (${retryCount + 1}/${maxRetries})...`);
      // 重新获取 provider（会自动切换到下一个健康的 RPC）
      return wrapRpcCall(operation, call, retryCount + 1, maxRetries);
    }

    // 重试次数用尽，抛出网络异常
    throw new Error('网络异常');
  }
}

/**
 * 获取交易数量（nonce）
 */
export async function getTransactionCount(
  address: string,
  blockTag: string = "pending"
): Promise<number> {
  return wrapRpcCall("getTransactionCount", async () => {
    const provider = getProvider();
    return await provider.getTransactionCount(address, blockTag);
  });
}

/**
 * 估算 Gas
 */
export async function estimateGas(
  transaction: ethers.TransactionRequest
): Promise<bigint> {
  return wrapRpcCall("estimateGas", async () => {
    const provider = getProvider();
    return await provider.estimateGas(transaction);
  });
}

/**
 * 获取 Gas Price
 */
export async function getFeeData(): Promise<ethers.FeeData> {
  return wrapRpcCall("getFeeData", async () => {
    const provider = getProvider();
    return await provider.getFeeData();
  });
}

/**
 * 获取合约代码
 */
export async function getCode(address: string): Promise<string> {
  return wrapRpcCall("getCode", async () => {
    const provider = getProvider();
    return await provider.getCode(address);
  });
}

/**
 * 获取区块号
 */
export async function getBlockNumber(): Promise<number> {
  return wrapRpcCall("getBlockNumber", async () => {
    const provider = getProvider();
    return await provider.getBlockNumber();
  });
}

/**
 * 发送交易
 */
export async function sendTransaction(
  wallet: ethers.Wallet,
  transaction: ethers.TransactionRequest
): Promise<ethers.TransactionResponse> {
  try {
    return await wrapRpcCall("sendTransaction", async () => {
      return await wallet.sendTransaction(transaction);
    });
  } catch (error: any) {
    // 如果是 "already known" 错误，说明交易已在 mempool 中，视为发送成功
    if (error.message && error.message.includes('already known')) {
      console.log('⚠️ 交易已在 mempool 中，视为发送成功');
      
      // 计算交易哈希（前端需要这个来查询状态）
      const signedTx = await wallet.signTransaction(transaction);
      const txHash = ethers.keccak256(signedTx);
      
      console.log(`✅ 交易哈希: ${txHash}`);
      
      // 返回基本的 TransactionResponse（前端主要需要 hash）
      return {
        hash: txHash,
        nonce: transaction.nonce as number,
        from: wallet.address,
        to: transaction.to as string,
        value: transaction.value || 0n,
        data: transaction.data as string,
        wait: async () => {
          // 前端可以调用 wait() 等待确认
          const provider = getProvider();
          return await provider.waitForTransaction(txHash);
        }
      } as ethers.TransactionResponse;
    }
    
    // 其他错误继续抛出
    throw error;
  }
}

/**
 * 获取账户的 pending nonce（包括 mempool 中的交易）
 */
export async function getPendingNonce(address: string): Promise<number> {
  return wrapRpcCall('getPendingNonce', async () => {
    const provider = getProvider();
    return await provider.getTransactionCount(address, 'pending');
  });
}
