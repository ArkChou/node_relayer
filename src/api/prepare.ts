import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import { contractNetworks, tokenInfo, feeConfig, RPC_URLS } from "../config/config.js";
import { getProvider, getRelayerWallet } from "../utils/provider.js";
import { estimateGas } from "../utils/rpcWrapper.js";

dotenv.config();

async function prepareConfig(params:{
        safeAddress: string;
        to: string;           
        value: string;       
        data: string;        
    }
) {
    const protocolKit = await (Safe as any).init({
            provider: RPC_URLS[0],
            signer: process.env.PRIVATE_KEY!,
            safeAddress: params.safeAddress
        });
    
    // 创建 Safe 交易
    const safeTransaction = await protocolKit.createTransaction({
        transactions: [{
            to: params.to,
            value: params.value,
            data: params.data,
            operation: 0  // 0 = Call, 1 = DelegateCall
        }]
    });
    
    // 计算交易哈希（供前端签名）
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);

    // 返回给前端（将 BigInt 转换为字符串）
    return {
        safeTxHash,  // 前端用这个签名
        safeTransaction: {
            to: safeTransaction.data.to,
            value: safeTransaction.data.value.toString(),
            data: safeTransaction.data.data,
            operation: safeTransaction.data.operation,
            safeTxGas: safeTransaction.data.safeTxGas.toString(),
            baseGas: safeTransaction.data.baseGas.toString(),
            gasPrice: safeTransaction.data.gasPrice.toString(),
            gasToken: safeTransaction.data.gasToken,
            refundReceiver: safeTransaction.data.refundReceiver,
            nonce: safeTransaction.data.nonce.toString()
        }
    };
}


// 准备交易并收取 ERC20 gas 费
async function prepareConfigWithFee(params: {
    safeAddress: string;
    to: string;
    value: string;
    data: string;
}) {
    const provider = getProvider();

    const protocolKit = await (Safe as any).init({
        provider: RPC_URLS[0],
        signer: process.env.PRIVATE_KEY!,
        safeAddress: params.safeAddress
    });

    // 创建 Safe 交易
    const safeTransaction = await protocolKit.createTransaction({
        transactions: [{
            to: params.to,
            value: params.value,
            data: params.data,
            operation: 0
        }]
    });
    // 估算 gas 消耗（使用 rpcWrapper，带超时和自动切换）
    const estimatedGasResult = await estimateGas({
        to: params.to,
        value: params.value,
        data: params.data,
        from: params.safeAddress
    });

    // 设置 gas 费参数（使用配置）
    const safeTxGas = (estimatedGasResult * BigInt(Math.floor(feeConfig.GAS_BUFFER * 100))) / 100n;
    const baseGas = feeConfig.BASE_GAS;
    const totalGas = safeTxGas + baseGas;

    // 计算 gasPrice：使用配置的默认费用
    // gasPrice = totalFee / totalGas
    const totalFee = ethers.parseUnits(feeConfig.DEFAULT_FEE, 18);
    const gasPrice = totalFee / totalGas;

    safeTransaction.data.safeTxGas = safeTxGas;
    safeTransaction.data.baseGas = baseGas;
    safeTransaction.data.gasPrice = gasPrice.toString();
    safeTransaction.data.gasToken = tokenInfo.GAS_TOKEN;
    safeTransaction.data.refundReceiver = tokenInfo.RELAYER_ADDRESS;

    // 计算交易哈希
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);

    // 计算预计费用（供前端展示）
    const estimatedFee = totalGas * gasPrice;

    return {
        safeTxHash,
        estimatedFee: ethers.formatUnits(estimatedFee, 18), // 格式化为可读的数字，如 "0.1"
        estimatedFeeWei: estimatedFee.toString(), // 原始 wei 值
        gasTokenAddress: tokenInfo.GAS_TOKEN,
        safeTransaction: {
            to: safeTransaction.data.to,
            value: safeTransaction.data.value.toString(),
            data: safeTransaction.data.data,
            operation: safeTransaction.data.operation,
            safeTxGas: safeTransaction.data.safeTxGas.toString(),
            baseGas: safeTransaction.data.baseGas.toString(),
            gasPrice: safeTransaction.data.gasPrice.toString(),
            gasToken: safeTransaction.data.gasToken,
            refundReceiver: safeTransaction.data.refundReceiver,
            nonce: safeTransaction.data.nonce.toString()
        }
    };
}
const configModule = {
    prepareConfig,
    prepareConfigWithFee
};

export default configModule;