import "dotenv/config";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const GATE_URL = "http://localhost:3000/api/gate/weather";

const DOMAIN = {
  name: "GhostGate",
  version: "1",
  chainId: 8453,
} as const;

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const SERVICE = "weather";
const NONCE = "123";

const getPrivateKey = (): Hex => {
  const privateKey = process.env.PRIVATE_KEY?.trim();

  if (!privateKey || privateKey === "YOUR_PRIVATE_KEY_HERE") {
    throw new Error("PRIVATE_KEY is missing or still set to placeholder in .env.");
  }

  const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string (0x + 64 hex chars).");
  }

  return normalized as Hex;
};

const readBodySafely = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

async function main(): Promise<void> {
  try {
    console.log("🤖 Agent: Booting GhostGate simulation...");

    const privateKey = getPrivateKey();
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });

    console.log(`🤖 Agent: Using wallet ${account.address}`);

    console.log("🚪 Gate (Step 1): Free attempt without ticket...");
    const freeAttempt = await fetch(GATE_URL);
    const freeBody = await readBodySafely(freeAttempt);
    console.log(`🚪 Gate (Step 1): Status ${freeAttempt.status}`);
    console.log("🚪 Gate (Step 1): Body", freeBody);

    console.log("🎟️ Ticket (Step 2): Signing EIP-712 access payload...");
    const timestamp = Math.floor(Date.now() / 1000);
    const signedMessage = {
      service: SERVICE,
      timestamp: BigInt(timestamp),
      nonce: NONCE,
    } as const;
    const payloadForHeader = {
      service: SERVICE,
      timestamp,
      nonce: NONCE,
    } as const;

    const signature = await walletClient.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Access",
      message: signedMessage,
    });
    console.log("🎟️ Ticket (Step 2): Signature ready.");

    console.log("🚪 Gate (Step 3): Paid attempt with signed ticket...");
    const paidAttempt = await fetch(GATE_URL, {
      headers: {
        "X-Ghost-Sig": signature,
        "X-Ghost-Payload": JSON.stringify(payloadForHeader),
      },
    });
    const paidBody = await readBodySafely(paidAttempt);

    console.log(`🚪 Gate (Step 3): Status ${paidAttempt.status}`);
    console.log("🚪 Gate (Step 3): Body", paidBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("🤖 Agent Error:", message);
    process.exit(1);
  }
}

void main();
