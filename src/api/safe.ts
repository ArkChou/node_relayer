import { ethers } from "ethers";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import { contractNetworks } from "../config/config.js";

dotenv.config();

//传入用户EOA地址获取SafeAddress地址
async function getSafeAddress(userAddress: string) {

    const protocolKit = await (Safe as any).init({
        provider: process.env.URL!,
        signer: process.env.PRIVATE_KEY!,
        predictedSafe: {
            safeAccountConfig: {
                owners: [userAddress],
                threshold: 1
            }
        },
        contractNetworks
    });

    const safeAddress = await protocolKit.getAddress();
    return safeAddress;
}

// 判断 Safe 钱包是否已部署
async function isSafeDeployed(safeAddress: string): Promise<boolean> {
    const provider = new ethers.JsonRpcProvider(process.env.URL);
    
    // 检查该地址是否有合约代码
    const code = await provider.getCode(safeAddress);
    
    // 如果有代码（不是 "0x"），说明已部署
    return code !== "0x";
}

// 为前端准备部署账户交易数据（返回给前端，前端可以预览）
async function prepareDeploymentTx(eoaAddress: string) {
    const protocolKit = await (Safe as any).init({
        provider: process.env.URL!,
        signer: process.env.PRIVATE_KEY!,
        predictedSafe: {
            safeAccountConfig: {
                owners: [eoaAddress],
                threshold: 1
            }
        },
        contractNetworks
    });

    const safeAddress = await protocolKit.getAddress();
    const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();

    // 返回交易数据给前端
    return {
        safeAddress,
        transaction: {
            to: deploymentTransaction.to,
            data: deploymentTransaction.data,
            value: deploymentTransaction.value || "0x0",
            chainId: Number(process.env.CHAIN_ID)
        }
    };
}

// Relayer 代付 gas 部署 Safe
async function deploySafeByRelayer(params: {
    userAddress: string;
}) {
    const provider = new ethers.JsonRpcProvider(process.env.URL);
    const relayerWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    console.log("🚀 Relayer 开始部署 Safe...");
    console.log("Relayer 地址:", relayerWallet.address);
    console.log("用户地址:", params.userAddress);

    // 初始化 Safe Protocol Kit（预测模式）
    const protocolKit = await (Safe as any).init({
        provider: process.env.URL!,
        signer: process.env.PRIVATE_KEY!,
        predictedSafe: {
            safeAccountConfig: {
                owners: [params.userAddress],
                threshold: 1
            }
        },
        contractNetworks
    });

    const [safeAddress, deploymentTransaction] =await Promise.all([
        protocolKit.getAddress(),
        protocolKit.createSafeDeploymentTransaction()
    ]);

    const [estimatedGas, feeData] = await Promise.all([
        provider.estimateGas({
            to: deploymentTransaction.to,
            value: deploymentTransaction.value || "0",
            data: deploymentTransaction.data,
            from: relayerWallet.address
        }),
        provider.getFeeData()
    ])
    // 加 50% buffer
    const gasLimit = (estimatedGas * 150n) / 100n;

    const baseGasPrice = feeData.gasPrice || 1000000000n; 
    const gasPrice = (baseGasPrice * 120n) / 100n; 


    // Relayer 发送交易（代付 gas）
    const tx = await relayerWallet.sendTransaction({
        to: deploymentTransaction.to,
        value: deploymentTransaction.value || "0",
        data: deploymentTransaction.data,
        gasLimit: gasLimit,
        gasPrice: gasPrice  // 使用调整后的 gas price
    });

    console.log("交易已发送，txHash:", tx.hash);

    return {
        txHash: tx.hash,
        safeAddress: safeAddress
    };
}

const safeModule = {
    getSafeAddress,
    isSafeDeployed,
    prepareDeploymentTx,
    deploySafeByRelayer
};

export default safeModule;
