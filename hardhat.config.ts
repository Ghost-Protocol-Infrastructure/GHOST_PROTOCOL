import { config as loadEnv } from "dotenv";
import { defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

loadEnv();

const BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";

const privateKey = process.env.PRIVATE_KEY?.trim();
const normalizedPrivateKey = privateKey
  ? privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`
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
