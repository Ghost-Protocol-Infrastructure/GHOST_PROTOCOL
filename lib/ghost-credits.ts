import { getAddress, type Abi, type Address } from "viem";

const FALLBACK_GHOST_CREDITS_ADDRESS = "0xe968393bd003331db6d62deb614d2b073c9c151c";

const resolveGhostCreditsAddress = (rawAddress: string | undefined): Address => {
  if (rawAddress) {
    try {
      return getAddress(rawAddress);
    } catch {
      // Fallback to known deployed address when env var is malformed.
    }
  }

  return getAddress(FALLBACK_GHOST_CREDITS_ADDRESS);
};

export const GHOST_CREDITS_ADDRESS: Address = resolveGhostCreditsAddress(
  process.env.NEXT_PUBLIC_GHOST_CREDITS_ADDRESS,
);

export const GHOST_CREDITS_ABI = [
  {
    type: "function",
    name: "buyCredits",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "credits",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "event",
    name: "CreditsPurchased",
    anonymous: false,
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;
