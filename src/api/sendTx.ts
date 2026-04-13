import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import { contractNetworks, RPC_URLS } from "../config/config.js";
import { SafeTransactionData } from "../interface/interface.js";
import { getProvider, getRelayerWallet } from "../utils/provider.js";
import { acquireNonce } from "../utils/nonce.js";
import { estimateGas, getFeeData, sendTransaction } from "../utils/rpcWrapper.js";
import { saveTxToCache } from "../utils/txCache.js";
import { cache, CACHE_TTL } from "../utils/cache.js";
import logger from "../utils/logger.js";
import { NotOwnerError, InvalidSignatureError, GasEstimationError } from "../utils/errors.js";

dotenv.config();

// 执行 Safe 交易（Relayer 代付 gas）
async function executeSafeTransaction(params: {
    safeAddress: string;
    safeTransaction: SafeTransactionData;  // 类型安全的交易数据
    signature: string;     // 用户签名
    userAddress: string;   // 用户地址（签名者）
    safeTxHash?: string;   // 前端计算的 safeTxHash（可选，用于对比）
}) {
    const relayerWallet = getRelayerWallet();
    
    // 初始化 Safe Protocol Kit
    const protocolKit = await (Safe as any).init({
        provider: RPC_URLS[0],
        signer: process.env.PRIVATE_KEY!,
        safeAddress: params.safeAddress
    });

    // 检查 Safe 的 owners（使用缓存）
    const ownersCacheKey = `safe_owners:${params.safeAddress.toLowerCase()}`;
    let owners: string[] = cache.get<string[]>(ownersCacheKey) || [];
    
    if (owners.length === 0) {
        owners = await protocolKit.getOwners();
        cache.set(ownersCacheKey, owners, CACHE_TTL.SAFE_OWNERS);
        logger.debug('🔍 从 RPC 获取 Safe owners', { safeAddress: params.safeAddress });
    } else {
        logger.debug('✅ 使用缓存的 Safe owners', { safeAddress: params.safeAddress });
    }
    
    const isOwner = owners.some((owner: string) => owner.toLowerCase() === params.userAddress.toLowerCase())
    
    if (!isOwner) {
        throw new NotOwnerError(params.userAddress, owners);
    }

    // 重建 SafeTransaction 对象（使用前端传来的完整数据，包括 gas 费参数）
    const safeTransaction = await protocolKit.createTransaction({
        transactions: [{
            to: params.safeTransaction.to,
            value: params.safeTransaction.value,
            data: params.safeTransaction.data,
            operation: params.safeTransaction.operation
        }]
    });

    // 如果有 gas 费参数，必须设置（否则 safeTxHash 会不匹配）
    if (params.safeTransaction.gasToken && params.safeTransaction.gasToken !== ethers.ZeroAddress) {
        safeTransaction.data.safeTxGas = params.safeTransaction.safeTxGas;
        safeTransaction.data.baseGas = params.safeTransaction.baseGas;
        safeTransaction.data.gasPrice = params.safeTransaction.gasPrice;
        safeTransaction.data.gasToken = params.safeTransaction.gasToken;
        safeTransaction.data.refundReceiver = params.safeTransaction.refundReceiver;
    }
    
    // 确保 nonce 一致
    safeTransaction.data.nonce = params.safeTransaction.nonce;

    // 验证交易哈希
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    
    // 调试日志
    logger.debug('🔍 后端交易参数', {
        safeAddress: params.safeAddress,
        to: params.safeTransaction.to,
        value: params.safeTransaction.value,
        nonce: params.safeTransaction.nonce,
        safeTxHashMatch: params.safeTxHash === safeTxHash
    });
    
    // 解析签名
    const r = params.signature.slice(0, 66);
    const s = '0x' + params.signature.slice(66, 130);
    const v = parseInt(params.signature.slice(130, 132), 16);
    
    logger.debug('解析签名', { r, s, v });
    
    // 验证签名（直接使用原始签名）
    const originalSignature = r + s.slice(2) + v.toString(16).padStart(2, '0');
    const recoveredAddress = ethers.recoverAddress(safeTxHash, originalSignature);
    
    logger.debug('签名验证', { recoveredAddress, userAddress: params.userAddress });
    
    if (recoveredAddress.toLowerCase() !== params.userAddress.toLowerCase()) {
        throw new InvalidSignatureError(`恢复的地址 ${recoveredAddress} 与用户地址 ${params.userAddress} 不匹配`);
    }
    
    // 🔧 修复：直接使用 Safe 合约的 execTransaction 编码，不通过 addSignature
    // Safe 合约的 execTransaction 函数签名：
    // execTransaction(address to, uint256 value, bytes data, uint8 operation, 
    //                 uint256 safeTxGas, uint256 baseGas, uint256 gasPrice,
    //                 address gasToken, address refundReceiver, bytes signatures)
    
    const safeInterface = new ethers.Interface([
        'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) external payable returns (bool success)'
    ]);
    
    const encodedTx = safeInterface.encodeFunctionData('execTransaction', [
        params.safeTransaction.to,
        params.safeTransaction.value,
        params.safeTransaction.data,
        params.safeTransaction.operation,
        params.safeTransaction.safeTxGas,
        params.safeTransaction.baseGas,
        params.safeTransaction.gasPrice,
        params.safeTransaction.gasToken,
        params.safeTransaction.refundReceiver,
        originalSignature  // 直接传递原始签名
    ]);
    
    // 先并行获取 Gas 估算和 Gas Price（可能失败，不消耗 nonce）
    // Gas Price 使用缓存
    const gasPriceCacheKey = 'gas_price';
    let feeDataResult = cache.get<any>(gasPriceCacheKey);
    
    const estimateGasPromise = estimateGas({
        to: params.safeAddress,
        data: encodedTx,
        from: relayerWallet.address
    });
    
    let getFeeDataPromise: Promise<any>;
    if (!feeDataResult) {
        logger.debug('🔍 从 RPC 获取 Gas Price');
        getFeeDataPromise = getFeeData().then(data => {
            cache.set(gasPriceCacheKey, data, CACHE_TTL.GAS_PRICE);
            return data;
        });
    } else {
        logger.debug('✅ 使用缓存的 Gas Price');
        getFeeDataPromise = Promise.resolve(feeDataResult);
    }
    
    const [estimatedGasResult, feeDataResultFinal] = await Promise.all([
        estimateGasPromise,
        getFeeDataPromise
    ]);
    
    feeDataResult = feeDataResultFinal;
    
    // Gas 估算成功后，再获取 nonce（避免 estimateGas 失败时造成 nonce 空洞）
    const nonce = await acquireNonce(relayerWallet.address);
    
    // Gas 参数放大 1.2 倍（确保交易成功）
    const gasLimit = Math.floor(Number(estimatedGasResult) * 1.2);
    const maxFeePerGas = feeDataResult.maxFeePerGas 
        ? Math.floor(Number(feeDataResult.maxFeePerGas) * 1.2).toString()
        : undefined;
    const maxPriorityFeePerGas = feeDataResult.maxPriorityFeePerGas 
        ? Math.floor(Number(feeDataResult.maxPriorityFeePerGas) * 1.2).toString()
        : undefined;
    
    // 发送交易（使用 rpcWrapper 的 sendTransaction，带超时和自动切换）
    const tx = await sendTransaction(relayerWallet, {
        to: params.safeAddress,
        value: "0",
        data: encodedTx,
        nonce: nonce,
        gasLimit: gasLimit,
        maxFeePerGas: maxFeePerGas ? BigInt(maxFeePerGas) : undefined,
        maxPriorityFeePerGas: maxPriorityFeePerGas ? BigInt(maxPriorityFeePerGas) : undefined,
    });
    
    logger.info('✅ 交易已发送', { txHash: tx.hash, nonce });
    
    // 交易发送成功后才保存到缓存（用于重发）
    await saveTxToCache(relayerWallet.address, nonce, {
        nonce: nonce,
        to: params.safeAddress,
        value: "0",
        data: encodedTx,
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFeePerGas || "0",
        maxPriorityFeePerGas: maxPriorityFeePerGas || "0"
    });
    
    return {
        txHash: tx.hash,
        status: 'pending'
    };
}


const transferModule = {
    executeSafeTransaction,
};

export default transferModule;
