import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";
import { parseEther, type Address } from "viem";

const DEPLOY_CONFIRMATIONS = 5;
const PRICE_PER_CREDIT = parseEther("0.00001");
const PLATFORM_FEE_BPS = 500n;
const CONTRACTS_FILE_PATH = path.join(process.cwd(), "lib", "contracts.json");

type ContractsRecord = Record<string, string>;
type ViemHelpers = {
  getWalletClients: () => Promise<Array<{ account: { address: Address } }>>;
  deployContract: (
    contractName: string,
    constructorArgs?: unknown[],
    deployContractConfig?: { confirmations?: number },
  ) => Promise<{ address: Address }>;
};

const isLocalNetwork = (networkName: string): boolean => {
  return networkName === "localhost" || networkName.startsWith("hardhat");
};

const ensureRequiredEnv = (networkName: string): void => {
  if (!isLocalNetwork(networkName) && !process.env.PRIVATE_KEY?.trim()) {
    throw new Error("Missing PRIVATE_KEY in .env.");
  }

  if (!isLocalNetwork(networkName) && !process.env.BASESCAN_API_KEY?.trim()) {
    throw new Error("Missing BASESCAN_API_KEY in .env.");
  }
};

const readContractsFile = async (): Promise<ContractsRecord> => {
  try {
    const raw = await readFile(CONTRACTS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ContractsRecord;
    }

    throw new Error("lib/contracts.json must contain a JSON object.");
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") return {};
    throw error;
  }
};

const writeContractsFile = async (address: Address): Promise<void> => {
  const existing = await readContractsFile();
  const next: ContractsRecord = {
    ...existing,
    GhostCredits: address,
  };

  await mkdir(path.dirname(CONTRACTS_FILE_PATH), { recursive: true });
  await writeFile(CONTRACTS_FILE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

const runVerification = async (address: Address, constructorArguments: unknown[]): Promise<void> => {
  const hreWithRun = hre as unknown as {
    run?: (taskName: string, taskArguments?: Record<string, unknown>) => Promise<unknown>;
  };

  if (!hreWithRun.run) {
    throw new Error("Hardhat runtime does not expose run().");
  }

  try {
    await hreWithRun.run("verify:verify", {
      address,
      constructorArguments,
    });
    return;
  } catch (legacyTaskError) {
    const message =
      legacyTaskError instanceof Error ? legacyTaskError.message : String(legacyTaskError);

    // Hardhat v3 uses "verify" task. Keep this fallback for compatibility.
    if (!message.toLowerCase().includes("task") || !message.toLowerCase().includes("verify:verify")) {
      throw legacyTaskError;
    }
  }

  await hreWithRun.run("verify", {
    address,
    constructorArguments,
  });
};

const deployGhostCredits = async (
  viem: ViemHelpers,
  networkName: string,
): Promise<{
  address: Address;
  constructorArguments: unknown[];
}> => {
  const confirmations = isLocalNetwork(networkName) ? 1 : DEPLOY_CONFIRMATIONS;
  const [deployer] = await viem.getWalletClients();

  if (!deployer) {
    throw new Error("No deployer wallet available. Check PRIVATE_KEY in .env.");
  }

  const primaryConstructorArguments: unknown[] = [PRICE_PER_CREDIT, PLATFORM_FEE_BPS];
  const fallbackConstructorArguments: unknown[] = [PRICE_PER_CREDIT, deployer.account.address];

  try {
    const contract = await viem.deployContract("GhostCredits", primaryConstructorArguments, {
      confirmations,
    });

    return {
      address: contract.address,
      constructorArguments: primaryConstructorArguments,
    };
  } catch (primaryError) {
    console.warn(
      "Primary constructor [pricePerCredit, platformFeeBps] failed. Retrying legacy constructor [pricePerCredit, owner].",
    );
    console.warn(`Primary deploy error: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);

    const contract = await viem.deployContract("GhostCredits", fallbackConstructorArguments, {
      confirmations,
    });

    return {
      address: contract.address,
      constructorArguments: fallbackConstructorArguments,
    };
  }
};

async function main(): Promise<void> {
  const connection = await hre.network.connect();
  const hreWithViem = hre as unknown as { viem?: ViemHelpers };
  const networkName = connection.networkName;
  ensureRequiredEnv(networkName);

  console.log(`Deploying GhostCredits to ${networkName}...`);
  console.log(`pricePerCredit (wei): ${PRICE_PER_CREDIT.toString()}`);
  console.log(`platformFeeBps: ${PLATFORM_FEE_BPS.toString()}`);

  const confirmationsToWait = isLocalNetwork(networkName) ? 1 : DEPLOY_CONFIRMATIONS;
  console.log(`Waiting for ${confirmationsToWait} confirmation(s)...`);

  const viem = hreWithViem.viem ?? connection.viem;
  const { address, constructorArguments } = await deployGhostCredits(viem, networkName);

  console.log(`GhostCredits deployed at: ${address}`);
  await writeContractsFile(address);
  console.log(`Address written to: ${CONTRACTS_FILE_PATH}`);

  if (!isLocalNetwork(networkName)) {
    try {
      await runVerification(address, constructorArguments);
      console.log("Verification complete.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already verified")) {
        console.log("Contract is already verified.");
        return;
      }
      throw error;
    }
  } else {
    console.log("Skipping verification on local network.");
  }
}

main().catch((error) => {
  console.error("Deployment failed:");
  console.error(error);
  process.exit(1);
});
