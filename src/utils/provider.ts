import { ethers } from "ethers";
import dotenv from "dotenv";
import { getRpcHealthPool } from "./rpcHealthPool.js";
import { RPC_URLS } from "../config/config.js";

dotenv.config();

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;
let currentUrl: string | null = null;

const RPC_TIMEOUT = 10000; // 10 秒超时

/**
 * 获取全局复用的 Provider 实例（从健康池获取）
 */
export function getProvider(): ethers.JsonRpcProvider {
  try {
    const healthPool = getRpcHealthPool();
    const newUrl = healthPool.getCurrentUrl();
    
    // 如果 URL 变化了，重新创建 provider 和 wallet
    if (!_provider || currentUrl !== newUrl) {
      currentUrl = newUrl;
      _provider = new ethers.JsonRpcProvider(currentUrl);
      _wallet = null; // 重置 wallet，下次调用时会用新 provider 创建
      console.log(`🔄 使用 RPC: ${currentUrl}`);
    }
    
    return _provider;
  } catch (error) {
    // 如果健康池未初始化，降级使用第一个 RPC
    if (!_provider) {
      _provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
    }
    return _provider;
  }
}

/**
 * 获取全局复用的 Relayer 钱包实例
 */
export function getRelayerWallet(): ethers.Wallet {
  if (!_wallet) {
    _wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, getProvider());
  }
  return _wallet;
}