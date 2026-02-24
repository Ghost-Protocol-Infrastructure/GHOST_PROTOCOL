import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { type Address, recoverMessageAddress } from "viem";
import {
  buildMerchantGatewayAuthMessage,
  MERCHANT_GATEWAY_AUTH_MAX_AGE_SECONDS,
  normalizeMerchantGatewayAuthPayload,
  type MerchantGatewayAuthAction,
  type MerchantGatewayAuthPayload,
} from "@/lib/agent-gateway-auth";

type VerifyMerchantGatewaySignedWriteInput = {
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  authPayload: unknown;
  authSignature: string;
  nowMs?: number;
};

type VerifyMerchantGatewaySignedWriteResult =
  | { ok: true; authPayload: MerchantGatewayAuthPayload; signer: string }
  | { ok: false; status: number; error: string; code?: string };

const normalizeSignature = (value: unknown): `0x${string}` | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]+$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
};

const consumeMerchantGatewayAuthNonce = async (input: {
  signer: string;
  action: MerchantGatewayAuthAction;
  agentId: string;
  nonce: string;
  issuedAt: number;
  signature: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string; code: string }> => {
  try {
    await prisma.accessNonce.create({
      data: {
        signer: input.signer,
        service: `merchant_gateway:${input.action}:agent-${input.agentId}`,
        nonce: input.nonce,
        payloadTimestamp: BigInt(input.issuedAt),
        signature: input.signature,
      },
    });
    return { ok: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: false, status: 409, code: "REPLAY", error: "Merchant auth nonce already used." };
    }
    throw error;
  }
};

export const verifyMerchantGatewaySignedWrite = async (
  input: VerifyMerchantGatewaySignedWriteInput,
): Promise<VerifyMerchantGatewaySignedWriteResult> => {
  const parsedPayload = normalizeMerchantGatewayAuthPayload(input.authPayload);
  if (!parsedPayload) {
    return { ok: false, status: 400, code: "BAD_AUTH_PAYLOAD", error: "authPayload is invalid." };
  }

  const signature = normalizeSignature(input.authSignature);
  if (!signature) {
    return { ok: false, status: 400, code: "BAD_AUTH_SIGNATURE", error: "authSignature is invalid." };
  }

  if (parsedPayload.action !== input.action) {
    return { ok: false, status: 400, code: "AUTH_ACTION_MISMATCH", error: "authPayload.action mismatch." };
  }
  if (parsedPayload.agentId !== input.agentId) {
    return { ok: false, status: 400, code: "AUTH_AGENT_MISMATCH", error: "authPayload.agentId mismatch." };
  }
  if (parsedPayload.serviceSlug !== input.serviceSlug) {
    return { ok: false, status: 400, code: "AUTH_SERVICE_MISMATCH", error: "authPayload.serviceSlug mismatch." };
  }
  if (parsedPayload.ownerAddress !== input.ownerAddress) {
    return { ok: false, status: 400, code: "AUTH_OWNER_MISMATCH", error: "authPayload.ownerAddress mismatch." };
  }
  if (parsedPayload.actorAddress !== input.actorAddress) {
    return { ok: false, status: 400, code: "AUTH_ACTOR_MISMATCH", error: "authPayload.actorAddress mismatch." };
  }

  const nowMs = input.nowMs ?? Date.now();
  const ageSeconds = Math.floor(nowMs / 1000) - parsedPayload.issuedAt;
  if (ageSeconds < -30 || ageSeconds > MERCHANT_GATEWAY_AUTH_MAX_AGE_SECONDS) {
    return {
      ok: false,
      status: 401,
      code: "AUTH_EXPIRED",
      error: `authPayload expired or not yet valid (age=${ageSeconds}s).`,
    };
  }

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: buildMerchantGatewayAuthMessage(parsedPayload),
      signature,
    });
  } catch {
    return { ok: false, status: 401, code: "AUTH_RECOVER_FAILED", error: "Failed to recover signer from authSignature." };
  }

  const signer = recovered.toLowerCase();
  if (signer !== input.actorAddress || signer !== input.ownerAddress) {
    return {
      ok: false,
      status: 403,
      code: "AUTH_SIGNER_MISMATCH",
      error: "authSignature signer must match the merchant owner wallet.",
    };
  }

  const nonceResult = await consumeMerchantGatewayAuthNonce({
    signer,
    action: input.action,
    agentId: input.agentId,
    nonce: parsedPayload.nonce,
    issuedAt: parsedPayload.issuedAt,
    signature,
  });
  if (!nonceResult.ok) {
    return nonceResult;
  }

  return { ok: true, authPayload: parsedPayload, signer };
};
