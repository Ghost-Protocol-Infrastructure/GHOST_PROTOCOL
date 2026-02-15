import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";

const ARTIFACT_PATH = path.join(process.cwd(), "artifacts", "contracts", "GhostVault.sol", "GhostVault.json");

const normalizePrivateKey = (raw) => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
};

async function loadVaultArtifact() {
  const artifactRaw = await readFile(ARTIFACT_PATH, "utf8");
  const artifact = JSON.parse(artifactRaw);
  if (!artifact?.abi || !artifact?.bytecode) {
    throw new Error(`Invalid artifact at ${ARTIFACT_PATH}. Run: npx hardhat compile`);
  }
  return artifact;
}

async function main() {
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org";
  const treasuryWallet = process.env.TREASURY_WALLET?.trim();
  const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY);

  if (!treasuryWallet || !ethers.isAddress(treasuryWallet)) {
    throw new Error("TREASURY_WALLET is missing or invalid.");
  }

  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required for deployment.");
  }

  const artifact = await loadVaultArtifact();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(privateKey, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

  console.log(`Deploying GhostVault from ${deployer.address}...`);
  console.log(`Treasury wallet: ${treasuryWallet}`);

  const contract = await factory.deploy(treasuryWallet);
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
