import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import { contractNetworks } from "../config/config.js";

dotenv.config();

async function prepareConfig(params:{
        safeAddress: string;
        to: string;           
        value: string;       
        data: string;        
    }
) {
    const protocolKit = await (Safe as any).init({
            provider: process.env.URL!,
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

    // 返回给前端
    return {
        safeTxHash,  // 前端用这个签名
        safeTransaction: {
            to: safeTransaction.data.to,
            value: safeTransaction.data.value,
            data: safeTransaction.data.data,
            operation: safeTransaction.data.operation,
            safeTxGas: safeTransaction.data.safeTxGas,
            baseGas: safeTransaction.data.baseGas,
            gasPrice: safeTransaction.data.gasPrice,
            gasToken: safeTransaction.data.gasToken,
            refundReceiver: safeTransaction.data.refundReceiver,
            nonce: safeTransaction.data.nonce
        }
    };
}

const configModule = {
    prepareConfig
};

export default configModule;