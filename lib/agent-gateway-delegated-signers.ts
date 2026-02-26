import { type AgentGatewayDelegatedSigner, type AgentGatewayDelegatedSignerStatus } from "@prisma/client";

export const AGENT_GATEWAY_MAX_ACTIVE_DELEGATED_SIGNERS = 2;

const LABEL_MAX_LEN = 64;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export type AgentGatewayDelegatedSignerResponse = {
  id: string;
  signerAddress: string;
  status: AgentGatewayDelegatedSignerStatus;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export const normalizeDelegatedSignerLabel = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > LABEL_MAX_LEN) return null;
  if (!PRINTABLE_ASCII.test(trimmed)) return null;
  return trimmed;
};

export const toDelegatedSignerResponse = (
  signer: Pick<AgentGatewayDelegatedSigner, "id" | "signerAddress" | "status" | "label" | "createdAt" | "revokedAt">,
): AgentGatewayDelegatedSignerResponse => ({
  id: signer.id,
  signerAddress: signer.signerAddress.toLowerCase(),
  status: signer.status,
  label: signer.label ?? null,
  createdAt: signer.createdAt.toISOString(),
  revokedAt: signer.revokedAt?.toISOString() ?? null,
});

