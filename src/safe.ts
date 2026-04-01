import { ethers } from "ethers";
import Safe, { SafeAccountConfig } from "@safe-global/protocol-kit";
import dotenv from "dotenv";

dotenv.config();

//传入用户EOA地址获取SafeAddress地址
async function getSafeAddress(userAddress: string) {
    const protocolKit = await Safe.init({
        provider: process.env.RPC_URL,
        signer: process.env.PRIVATE_KEY,
        safeAddress: userAddress
    })

    const safeAddress = await protocolKit.getAddress()
    return safeAddress
}