import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { ethers } from "ethers";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const ARTIFACT_PATH = path.join(process.cwd(), "artifacts", "contracts", "AgenticCommerce.sol", "AgenticCommerce.json");
const NETWORKS = {
  "base-mainnet": {
    rpcUrl: process.env.BASE_MAINNET_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
    chainId: 8453n,
    label: "Base Mainnet",
  },
  "base-sepolia": {
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org",
    chainId: 84532n,
    label: "Base Sepolia",
  },
};

const DEFAULT_USDC = {
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const normalizePrivateKey = (raw) => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDeploymentSnapshot(contract, attempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [livePaymentToken, livePlatformFeeBp, liveTreasury] = await Promise.all([
        contract.paymentToken(),
        contract.platformFeeBP(),
        contract.platformTreasury(),
      ]);
      return {
        paymentToken: livePaymentToken,
        platformFeeBP: livePlatformFeeBp.toString(),
        platformTreasury: liveTreasury,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `Post-deploy readback attempt ${attempt}/${attempts} failed. Retrying in ${delayMs}ms...`,
          error?.shortMessage ?? error?.message ?? error,
        );
        await sleep(delayMs);
        continue;
      }
    }
  }

  throw lastError ?? new Error("Post-deploy readback failed without error details.");
}

async function loadArtifact() {
  const artifactRaw = await readFile(ARTIFACT_PATH, "utf8");
  const artifact = JSON.parse(artifactRaw);
  if (!artifact?.abi || !artifact?.bytecode) {
    throw new Error(`Invalid artifact at ${ARTIFACT_PATH}. Run: npm run contracts:compile`);
  }
  return artifact;
}

const parseNetworkName = () => {
  const networkArg = process.argv.find((arg) => arg.startsWith("--network="));
  const networkName = networkArg ? networkArg.slice("--network=".length).trim() : process.env.GHOSTWIRE_DEPLOY_NETWORK?.trim();
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
  const paymentToken = (
    process.env[`GHOSTWIRE_USDC_${networkName === "base-mainnet" ? "MAINNET" : "TESTNET"}_ADDRESS`]?.trim() ||
    DEFAULT_USDC[networkName]
  );
  const privateKey =
    normalizePrivateKey(process.env.GHOSTWIRE_DEPLOYER_PRIVATE_KEY) ||
    normalizePrivateKey(process.env.PRIVATE_KEY);

  if (!treasuryWallet || !ethers.isAddress(treasuryWallet)) {
    throw new Error("TREASURY_WALLET is missing or invalid.");
  }
  if (!paymentToken || !ethers.isAddress(paymentToken)) {
    throw new Error("GhostWire payment token address is missing or invalid.");
  }
  if (!privateKey) {
    throw new Error("GHOSTWIRE_DEPLOYER_PRIVATE_KEY or PRIVATE_KEY is required for deployment.");
  }

  const artifact = await loadArtifact();
  const provider = new ethers.JsonRpcProvider(selectedNetwork.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== selectedNetwork.chainId) {
    throw new Error(
      `RPC chainId mismatch for ${selectedNetwork.label}. Expected ${selectedNetwork.chainId.toString()}, received ${network.chainId.toString()}.`,
    );
  }

  const deployer = new ethers.Wallet(privateKey, provider);
  const deployerBalance = await provider.getBalance(deployer.address);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

  console.log(`Deployment network: ${selectedNetwork.label} (${selectedNetwork.chainId.toString()})`);
  console.log(`Deploying AgenticCommerce from ${deployer.address}...`);
  console.log(`Deployer balance: ${ethers.formatEther(deployerBalance)} ETH`);
  console.log(`Payment token: ${paymentToken}`);
  console.log(`Treasury wallet: ${treasuryWallet}`);

  const deploymentTx = await factory.getDeployTransaction(paymentToken, treasuryWallet);
  const estimatedGas = await provider.estimateGas({
    from: deployer.address,
    data: deploymentTx.data,
  });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const estimatedCostWei = estimatedGas * gasPrice;
  console.log(`Estimated gas: ${estimatedGas.toString()}`);
  console.log(`Estimated cost: ${ethers.formatEther(estimatedCostWei)} ETH`);

  const contract = await factory.deploy(paymentToken, treasuryWallet);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const txHash = contract.deploymentTransaction()?.hash;

  console.log(`AgenticCommerce deployed at: ${address}`);
  if (txHash) console.log(`Deployment tx: ${txHash}`);

  const liveState = await readDeploymentSnapshot(contract);
  console.log(
    JSON.stringify(
      {
        contractAddress: address,
        ...liveState,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to deploy AgenticCommerce:", error);
  process.exitCode = 1;
});
