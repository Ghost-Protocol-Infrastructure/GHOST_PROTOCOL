import { config as loadEnv } from "dotenv";
import { defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

loadEnv();

const BASE_RPC_URL = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";

const rawPrivateKey = process.env.PRIVATE_KEY?.trim();
const normalizedPrivateKey = rawPrivateKey
  ? rawPrivateKey.startsWith("0x")
    ? rawPrivateKey
    : `0x${rawPrivateKey}`
  : undefined;

const basescanApiKey = process.env.BASESCAN_API_KEY?.trim() ?? "";

export default defineConfig({
  plugins: [hardhatViem, hardhatVerify],
  solidity: {
    version: "0.8.20",
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    baseMainnet: {
      type: "http",
      chainType: "l1",
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts: normalizedPrivateKey ? [normalizedPrivateKey] : [],
    },
    baseSepolia: {
      type: "http",
      chainType: "l1",
      url: BASE_SEPOLIA_RPC_URL,
      chainId: 84532,
      accounts: normalizedPrivateKey ? [normalizedPrivateKey] : [],
    },
  },
  verify: {
    etherscan: {
      apiKey: basescanApiKey,
      enabled: basescanApiKey.length > 0,
    },
  },
});
