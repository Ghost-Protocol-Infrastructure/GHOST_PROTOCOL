import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { ethers } from "ethers";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const ARTIFACT_PATH = path.join(process.cwd(), "artifacts", "contracts", "GhostVault.sol", "GhostVault.json");
const DEFAULT_INITIAL_MAX_TVL_WEI = ethers.parseEther("5");
const DEFAULT_CREDIT_PRICE_WEI = 10_000_000_000_000n;
const NETWORKS = {
  "base-mainnet": {
    rpcUrl:
      process.env.BASE_MAINNET_RPC_URL?.trim() ||
      process.env.BASE_RPC_URL?.trim() ||
      "https://mainnet.base.org",
    chainId: 8453n,
    label: "Base Mainnet",
  },
  "base-sepolia": {
    rpcUrl:
      process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
      "https://sepolia.base.org",
    chainId: 84532n,
    label: "Base Sepolia",
  },
};

const normalizePrivateKey = (raw) => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
};

const parsePositiveBigIntEnv = (raw, fallback, name) => {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer string.`);
  }

  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    throw new Error(`${name} must be greater than zero.`);
  }

  return parsed;
};

async function loadVaultArtifact() {
  const artifactRaw = await readFile(ARTIFACT_PATH, "utf8");
  const artifact = JSON.parse(artifactRaw);
  if (!artifact?.abi || !artifact?.bytecode) {
    throw new Error(`Invalid artifact at ${ARTIFACT_PATH}. Run: npx hardhat compile`);
  }
  return artifact;
}

const parseNetworkName = () => {
  const networkArg = process.argv.find((arg) => arg.startsWith("--network="));
  const networkName = networkArg
    ? networkArg.slice("--network=".length).trim()
    : process.env.GHOST_VAULT_DEPLOY_NETWORK?.trim();

  if (!networkName) {
    throw new Error("Deployment network is required. Use --network=base-sepolia or --network=base-mainnet.");
  }

  if (!(networkName in NETWORKS)) {
    throw new Error(`Unsupported deployment network: ${networkName}`);
  }

  return networkName;
};

async function main() {
  const networkName = parseNetworkName();
  const selectedNetwork = NETWORKS[networkName];
  const treasuryWallet = process.env.TREASURY_WALLET?.trim();
  const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY);
  const initialMaxTVL = parsePositiveBigIntEnv(
    process.env.GHOST_VAULT_INITIAL_MAX_TVL_WEI,
    DEFAULT_INITIAL_MAX_TVL_WEI,
    "GHOST_VAULT_INITIAL_MAX_TVL_WEI",
  );
  const creditPriceWei = parsePositiveBigIntEnv(
    process.env.GHOST_CREDIT_PRICE_WEI,
    DEFAULT_CREDIT_PRICE_WEI,
    "GHOST_CREDIT_PRICE_WEI",
  );

  if (!treasuryWallet || !ethers.isAddress(treasuryWallet)) {
    throw new Error("TREASURY_WALLET is missing or invalid.");
  }

  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required for deployment.");
  }

  const artifact = await loadVaultArtifact();

  const provider = new ethers.JsonRpcProvider(selectedNetwork.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== selectedNetwork.chainId) {
    throw new Error(
      `RPC chainId mismatch for ${selectedNetwork.label}. Expected ${selectedNetwork.chainId.toString()}, received ${network.chainId.toString()}.`,
    );
  }

  const deployer = new ethers.Wallet(privateKey, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

  console.log(`Deployment network: ${selectedNetwork.label} (${selectedNetwork.chainId.toString()})`);
  console.log(`Deploying GhostVault from ${deployer.address}...`);
  console.log(`Treasury wallet: ${treasuryWallet}`);
  console.log(`Initial maxTVL (wei): ${initialMaxTVL.toString()}`);
  console.log(`Credit price (wei): ${creditPriceWei.toString()}`);

  const contract = await factory.deploy(treasuryWallet, initialMaxTVL, creditPriceWei);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const txHash = contract.deploymentTransaction()?.hash;

  console.log(`GhostVault deployed at: ${address}`);
  if (txHash) console.log(`Deployment tx: ${txHash}`);
}

main().catch((error) => {
  console.error("Failed to deploy GhostVault:", error);
  process.exitCode = 1;
});
