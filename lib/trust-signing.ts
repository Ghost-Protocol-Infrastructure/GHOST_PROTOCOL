import { privateKeyToAccount } from "viem/accounts";
import { getAddress, hexToBytes, keccak256, recoverMessageAddress, stringToHex, type Address } from "viem";
import type { PortableTrustPayload } from "@/lib/trust-artifact";
import {
  PORTABLE_TRUST_HASH_ALGORITHM,
  PORTABLE_TRUST_SIGNATURE_SCHEME,
  type PortableTrustVerification,
} from "@/lib/trust-artifact";

export type PortableTrustIssuerConfig = {
  issuerAddress: string;
  privateKey: `0x${string}`;
};

const normalizePrivateKey = (value: string | undefined): `0x${string}` | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
};

const normalizeAddress = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return getAddress(trimmed as Address).toLowerCase();
  } catch {
    return null;
  }
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        const nextValue = sortKeysDeep((value as Record<string, unknown>)[key]);
        if (nextValue !== undefined) {
          acc[key] = nextValue;
        }
        return acc;
      }, {});
  }
  return value;
};

export const canonicalizePortableTrustPayload = (payload: PortableTrustPayload): string =>
  JSON.stringify(sortKeysDeep(payload), (_, current) => (typeof current === "bigint" ? current.toString() : current));

export const hashPortableTrustPayload = (payload: PortableTrustPayload): `0x${string}` =>
  keccak256(stringToHex(canonicalizePortableTrustPayload(payload)));

export const normalizePortableTrustPayload = <TPayload extends PortableTrustPayload>(payload: TPayload): TPayload =>
  JSON.parse(canonicalizePortableTrustPayload(payload)) as TPayload;

export const resolvePortableTrustIssuerConfig = (): PortableTrustIssuerConfig => {
  const privateKey = normalizePrivateKey(process.env.GHOST_TRUST_ISSUER_PRIVATE_KEY);
  if (!privateKey) {
    throw new Error("GHOST_TRUST_ISSUER_PRIVATE_KEY is missing or invalid.");
  }

  const account = privateKeyToAccount(privateKey);
  const derivedAddress = account.address.toLowerCase();
  const configuredAddress = normalizeAddress(process.env.GHOST_TRUST_ISSUER_ADDRESS);

  if (configuredAddress && configuredAddress !== derivedAddress) {
    throw new Error("GHOST_TRUST_ISSUER_ADDRESS does not match GHOST_TRUST_ISSUER_PRIVATE_KEY.");
  }

  return {
    issuerAddress: configuredAddress ?? derivedAddress,
    privateKey,
  };
};

export const isPortableTrustEnabled = (): boolean =>
  process.env.PORTABLE_TRUST_ENABLED?.trim().toLowerCase() === "true";

export const isPortableTrustSubsystemAvailable = (): boolean => {
  if (!isPortableTrustEnabled()) return false;
  try {
    resolvePortableTrustIssuerConfig();
    return true;
  } catch {
    return false;
  }
};

export const signPortableTrustPayload = async (input: {
  payload: PortableTrustPayload;
  privateKey: `0x${string}`;
}): Promise<PortableTrustVerification> => {
  const account = privateKeyToAccount(input.privateKey);
  const artifactHash = hashPortableTrustPayload(input.payload);
  const signature = await account.signMessage({
    message: {
      raw: hexToBytes(artifactHash),
    },
  });

  return {
    artifactHash,
    signature,
  };
};

export const verifyPortableTrustPayloadSignature = async (input: {
  payload: PortableTrustPayload;
  artifactHash?: `0x${string}` | null;
  signature: `0x${string}`;
  issuerAddress: string;
}): Promise<boolean> => {
  const computedArtifactHash = hashPortableTrustPayload(input.payload);
  if (input.artifactHash && input.artifactHash.toLowerCase() !== computedArtifactHash.toLowerCase()) {
    return false;
  }

  try {
    const recoveredAddress = await recoverMessageAddress({
      message: {
        raw: hexToBytes(computedArtifactHash),
      },
      signature: input.signature,
    });

    return recoveredAddress.toLowerCase() === normalizeAddress(input.issuerAddress);
  } catch {
    return false;
  }
};

export const getPortableTrustVerificationMetadata = () => ({
  hashAlgorithm: PORTABLE_TRUST_HASH_ALGORITHM,
  signatureScheme: PORTABLE_TRUST_SIGNATURE_SCHEME,
});
