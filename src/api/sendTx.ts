import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import { contractNetworks } from "../config/config.js";

dotenv.config();

// 执行 Safe 交易（Relayer 代付 gas）
async function executeSafeTransaction(params: {
    safeAddress: string;
    safeTransaction: any;  // 前端返回的 safeTransaction
    signature: string;     // 用户签名
    userAddress: string;   // 用户地址（签名者）
}) {
    const provider = new ethers.JsonRpcProvider(process.env.URL);
    const relayerWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    // 初始化 Safe Protocol Kit
    const protocolKit = await (Safe as any).init({
        provider: process.env.URL!,
        signer: process.env.PRIVATE_KEY!,
        safeAddress: params.safeAddress
    });

    // 检查 Safe 的 owners
    const owners = await protocolKit.getOwners();
    const isOwner = owners.some((owner: string) => owner.toLowerCase() === params.userAddress.toLowerCase())
    
    if (!isOwner) {
        throw new Error(`用户 ${params.userAddress} 不是 Safe 的 owner。Safe 的 owners: ${owners.join(', ')}`);
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
    // 验证签名
    const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(safeTxHash),
        params.signature
    );
    
    if (recoveredAddress.toLowerCase() !== params.userAddress.toLowerCase()) {
        throw new Error(`签名验证失败：恢复的地址 ${recoveredAddress} 与用户地址 ${params.userAddress} 不匹配`);
    }

    // Safe 签名格式调整
    // 对于 eth_sign (EIP-191)，Safe 需要 v + 4
    // 原因：Safe 使用不同的签名类型来区分 eth_sign 和 EIP-712
    const r = params.signature.slice(0, 66);  // 0x + 64 chars
    const s = '0x' + params.signature.slice(66, 130);  // 64 chars
    const v = parseInt(params.signature.slice(130, 132), 16);  // 2 chars
    
    // Safe 对于 eth_sign，需要 v + 4 (27 -> 31, 28 -> 32)
    const adjustedV = v + 4;
    const adjustedSignature = r + s.slice(2) + adjustedV.toString(16).padStart(2, '0');
    
    // 添加用户签名
    await safeTransaction.addSignature({
        signer: params.userAddress,
        data: adjustedSignature
    });

    // 执行交易（Relayer 代付 gas）
    const executeTxResponse = await protocolKit.executeTransaction(safeTransaction);

    return {
        txHash: executeTxResponse.hash,
        status: 'pending'
    };
}


const transferModule = {
    executeSafeTransaction,
};

export default transferModule;
