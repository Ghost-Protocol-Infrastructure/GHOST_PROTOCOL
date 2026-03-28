"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_OFFERING_RAILS,
  AGENT_OFFERING_TARGET_KINDS,
  type AgentOfferingRailValue,
  type AgentOfferingTargetKindValue,
  type CanonicalOfferingPrice,
} from "@/lib/agent-offerings-shared";
import {
  buildMerchantGatewayAuthMessage,
  createMerchantGatewayAuthPayload,
  MERCHANT_GATEWAY_AUTH_MAX_AGE_SECONDS,
} from "@/lib/agent-gateway-auth";
import {
  clearCachedAgentOfferingReadAuth,
  loadCachedAgentOfferingReadAuth,
  saveCachedAgentOfferingReadAuth,
  type CachedAgentOfferingReadAuth,
} from "@/lib/agent-offerings-read-auth";

type AgentOfferingItem = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  consumerCommand: string;
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  targetLabel: string;
  targetDescription: string;
  priceHint: string | null;
  etaHint: string | null;
  isActive: boolean;
  sortOrder: number;
  canonicalPricing: CanonicalOfferingPrice | null;
  createdAt: string;
  updatedAt: string;
};

type AgentOfferingsPanelProps = {
  agentId: string | null;
  ownerAddress: string | null;
  actorAddress?: string;
  publicProfileHref: string | null;
  serviceSlug: string | null;
  gatewayConfigured: boolean;
  signMessage: (input: { message: string }) => Promise<string>;
};

type OfferingFormState = {
  title: string;
  description: string;
  consumerCommand: string;
  rail: AgentOfferingRailValue;
  targetKind: AgentOfferingTargetKindValue;
  targetRef: string;
  priceHint: string;
  etaHint: string;
  isActive: boolean;
};

const DEFAULT_FORM_STATE: OfferingFormState = {
  title: "",
  description: "",
  consumerCommand: "",
  rail: "EXPRESS",
  targetKind: "SERVICE_SLUG",
  targetRef: "",
  priceHint: "",
  etaHint: "",
  isActive: true,
};

const getDefaultTargetKindForRail = (rail: AgentOfferingRailValue): AgentOfferingTargetKindValue =>
  rail === "GHOSTWIRE" ? "GHOSTWIRE_INTENT" : "SERVICE_SLUG";

const getPlaceholderCommand = (rail: AgentOfferingRailValue): string => {
  switch (rail) {
    case "X402":
      return "Analyze this wallet and summarize the biggest risks";
    case "EXPRESS":
      return "Create a meme-style short video about <topic>";
    case "GHOSTWIRE":
      return "Generate a quote for a higher-trust escrow job";
    default:
      return "Describe the request consumers should use";
  }
};

const getTargetHelper = (targetKind: AgentOfferingTargetKindValue, serviceSlug: string | null): string => {
  switch (targetKind) {
    case "SERVICE_SLUG":
      return serviceSlug ? `SERVICE_SLUG must match ${serviceSlug}` : "SERVICE_SLUG must match the configured gateway slug.";
    case "MCP_TOOL":
      return "MCP_TOOL is merchant-authored freeform text in V1.";
    case "GHOSTWIRE_INTENT":
      return "GHOSTWIRE_INTENT is informational-only in V1, not a templated executable binding.";
    default:
      return "";
  }
};

const getPriceGuidancePlaceholder = (rail: AgentOfferingRailValue): string => {
  switch (rail) {
    case "EXPRESS":
      return "Starts at 5 credits";
    case "X402":
      return "Charged at the live x402 payment requirement";
    case "GHOSTWIRE":
      return "Quoted after scope review";
    default:
      return "Add merchant guidance";
  }
};

const getPriceGuidanceLabel = (rail: AgentOfferingRailValue): string => (rail === "EXPRESS" ? "Price Guidance" : "Merchant Guidance");

const getPriceGuidanceHelper = (rail: AgentOfferingRailValue): string => {
  switch (rail) {
    case "EXPRESS":
      return "Express can show canonical Ghost credit pricing when service pricing is configured.";
    case "X402":
      return "x402 does not use Ghost credit pricing. Add merchant guidance only if it helps the buyer.";
    case "GHOSTWIRE":
      return "GhostWire pricing is quote-based in V1. Use guidance text, not a hard canonical price.";
    default:
      return "";
  }
};

const buildErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const describeRail = (rail: AgentOfferingRailValue): string => {
  switch (rail) {
    case "X402":
      return "x402";
    case "EXPRESS":
      return "Express";
    case "GHOSTWIRE":
      return "GhostWire";
    default:
      return rail;
  }
};

const getOfferingPricingPrimary = (offering: AgentOfferingItem): string => {
  if (offering.canonicalPricing) return offering.canonicalPricing.primaryDisplay;
  if (offering.priceHint) return offering.priceHint;
  if (offering.rail === "X402") return "See live x402 payment requirement";
  if (offering.rail === "GHOSTWIRE") return "Quoted per job scope";
  return "Merchant guidance only";
};

const getOfferingPricingLabel = (offering: AgentOfferingItem): string =>
  offering.canonicalPricing ? "Canonical Price" : offering.rail === "EXPRESS" ? "Price Guidance" : "Merchant Guidance";

const toInitialFormState = (serviceSlug: string | null): OfferingFormState => ({
  ...DEFAULT_FORM_STATE,
  targetRef: serviceSlug ?? "",
});

export default function AgentOfferingsPanel({
  agentId,
  ownerAddress,
  actorAddress,
  publicProfileHref,
  serviceSlug,
  gatewayConfigured,
  signMessage,
}: AgentOfferingsPanelProps) {
  const [offerings, setOfferings] = useState<AgentOfferingItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<OfferingFormState>(() => toInitialFormState(serviceSlug));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [pendingReorderId, setPendingReorderId] = useState<string | null>(null);
  const cachedReadAuthRef = useRef<CachedAgentOfferingReadAuth | null>(null);

  useEffect(() => {
    setFormState(toInitialFormState(serviceSlug));
    setEditingOfferingId(null);
    setNotice(null);
    cachedReadAuthRef.current = null;
    if (typeof window !== "undefined" && agentId && ownerAddress && actorAddress && serviceSlug) {
      const cached = loadCachedAgentOfferingReadAuth(window.sessionStorage, {
        agentId,
        ownerAddress,
        actorAddress,
        serviceSlug,
      });
      if (cached) {
        cachedReadAuthRef.current = cached;
      }
    }
  }, [actorAddress, ownerAddress, serviceSlug, agentId]);

  const buildSignedAuth = useCallback(
    async (options?: { cacheForRead?: boolean; reuseReadAuth?: boolean }) => {
      if (!agentId || !ownerAddress || !actorAddress || !serviceSlug) {
        throw new Error("Connect the owner wallet and configure GhostGate before managing offerings.");
      }

      if (options?.reuseReadAuth) {
        const cached =
          cachedReadAuthRef.current ??
          (typeof window !== "undefined"
            ? loadCachedAgentOfferingReadAuth(window.sessionStorage, {
              agentId,
              ownerAddress,
              actorAddress,
              serviceSlug,
            })
            : null);
        if (
          cached &&
          cached.agentId === agentId &&
          cached.ownerAddress === ownerAddress &&
          cached.actorAddress === actorAddress.toLowerCase() &&
          cached.serviceSlug === serviceSlug &&
          cached.expiresAtMs > Date.now()
        ) {
          return {
            authPayload: cached.authPayload,
            authSignature: cached.authSignature,
            actorAddress: cached.actorAddress,
          };
        }
      }

      const authPayload = createMerchantGatewayAuthPayload({
        action: "offerings_manage",
        agentId,
        ownerAddress,
        actorAddress: actorAddress.toLowerCase(),
        serviceSlug,
        nonce: crypto.randomUUID().replace(/-/g, ""),
      });
      const authSignature = await signMessage({
        message: buildMerchantGatewayAuthMessage(authPayload),
      });

      if (options?.cacheForRead) {
        const cached: CachedAgentOfferingReadAuth = {
          agentId,
          ownerAddress,
          actorAddress: actorAddress.toLowerCase(),
          serviceSlug,
          authPayload,
          authSignature,
          expiresAtMs: authPayload.issuedAt * 1000 + (MERCHANT_GATEWAY_AUTH_MAX_AGE_SECONDS - 30) * 1000,
        };
        cachedReadAuthRef.current = cached;
        if (typeof window !== "undefined") {
          saveCachedAgentOfferingReadAuth(window.sessionStorage, cached);
        }
      }

      return {
        authPayload,
        authSignature,
        actorAddress: actorAddress.toLowerCase(),
      };
    },
    [actorAddress, agentId, ownerAddress, serviceSlug, signMessage],
  );

  const loadOfferings = useCallback(async () => {
    if (!agentId) {
      setOfferings([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const canReadDrafts = Boolean(ownerAddress && actorAddress && serviceSlug);
      const params = new URLSearchParams({ agentId });
      const headers: Record<string, string> = {
        "cache-control": "no-store",
      };
      if (canReadDrafts) {
        const signed = await buildSignedAuth({
          cacheForRead: true,
          reuseReadAuth: true,
        });
        params.set("includeInactive", "1");
        headers["x-ghost-offerings-owner-address"] = ownerAddress!;
        headers["x-ghost-offerings-actor-address"] = signed.actorAddress;
        headers["x-ghost-offerings-auth-payload"] = JSON.stringify(signed.authPayload);
        headers["x-ghost-offerings-auth-signature"] = signed.authSignature;
      }
      const response = await fetch(`/api/agent-offerings?${params.toString()}`, {
        cache: "no-store",
        headers,
      });
      const payload = (await response.json()) as { error?: string; items?: AgentOfferingItem[] };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load offerings.");
      }
      setOfferings(Array.isArray(payload.items) ? payload.items : []);
    } catch (loadError) {
      setOfferings([]);
      setError(buildErrorMessage(loadError, "Failed to load offerings."));
    } finally {
      setIsLoading(false);
    }
  }, [actorAddress, agentId, buildSignedAuth, ownerAddress, serviceSlug]);

  useEffect(() => {
    if (typeof window === "undefined" || !agentId || !ownerAddress || !actorAddress || !serviceSlug) return;
    const cached = cachedReadAuthRef.current;
    if (cached && cached.expiresAtMs > Date.now()) return;
    clearCachedAgentOfferingReadAuth(window.sessionStorage, {
      agentId,
      ownerAddress,
      actorAddress,
      serviceSlug,
    });
  }, [actorAddress, agentId, ownerAddress, serviceSlug]);

  useEffect(() => {
    void loadOfferings();
  }, [loadOfferings]);

  const canMutate = Boolean(agentId && ownerAddress && actorAddress && serviceSlug && gatewayConfigured);
  const currentEditingOffering = useMemo(
    () => offerings.find((offering) => offering.id === editingOfferingId) ?? null,
    [editingOfferingId, offerings],
  );

  const resetForm = useCallback(() => {
    setEditingOfferingId(null);
    setFormState(toInitialFormState(serviceSlug));
  }, [serviceSlug]);

  const handleRailChange = (rail: AgentOfferingRailValue) => {
    setFormState((current) => {
      const targetKind = getDefaultTargetKindForRail(rail);
      return {
        ...current,
        rail,
        targetKind,
        targetRef: targetKind === "SERVICE_SLUG" ? serviceSlug ?? "" : current.targetRef,
      };
    });
  };

  const handleTargetKindChange = (targetKind: AgentOfferingTargetKindValue) => {
    setFormState((current) => ({
      ...current,
      targetKind,
      targetRef: targetKind === "SERVICE_SLUG" ? serviceSlug ?? "" : current.targetRef,
    }));
  };

  const handleSubmit = async () => {
    if (!agentId || !ownerAddress) return;

    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const signed = await buildSignedAuth();
      const response = await fetch(editingOfferingId ? `/api/agent-offerings/${editingOfferingId}` : "/api/agent-offerings", {
        method: editingOfferingId ? "PATCH" : "POST",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          ...(editingOfferingId ? {} : { agentId }),
          ownerAddress,
          actorAddress: signed.actorAddress,
          authPayload: signed.authPayload,
          authSignature: signed.authSignature,
          title: formState.title,
          description: formState.description,
          consumerCommand: formState.consumerCommand,
          rail: formState.rail,
          targetKind: formState.targetKind,
          targetRef: formState.targetRef,
          priceHint: formState.priceHint || null,
          etaHint: formState.etaHint || null,
          isActive: formState.isActive,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to save offering.");
      }
      await loadOfferings();
      resetForm();
      setNotice(editingOfferingId ? "Offering updated." : "Offering created.");
    } catch (submitError) {
      setError(buildErrorMessage(submitError, "Failed to save offering."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (offering: AgentOfferingItem) => {
    setEditingOfferingId(offering.id);
    setFormState({
      title: offering.title,
      description: offering.description,
      consumerCommand: offering.consumerCommand,
      rail: offering.rail,
      targetKind: offering.targetKind,
      targetRef: offering.targetRef,
      priceHint: offering.priceHint ?? "",
      etaHint: offering.etaHint ?? "",
      isActive: offering.isActive,
    });
    setNotice(null);
    setError(null);
  };

  const handleDelete = async (offering: AgentOfferingItem) => {
    if (!ownerAddress) return;
    const confirmed = window.confirm(`Delete offering "${offering.title}"?`);
    if (!confirmed) return;

    setPendingDeleteId(offering.id);
    setError(null);
    setNotice(null);
    try {
      const signed = await buildSignedAuth();
      const response = await fetch(`/api/agent-offerings/${offering.id}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          ownerAddress,
          actorAddress: signed.actorAddress,
          authPayload: signed.authPayload,
          authSignature: signed.authSignature,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to delete offering.");
      }
      await loadOfferings();
      if (editingOfferingId === offering.id) {
        resetForm();
      }
      setNotice("Offering deleted.");
    } catch (deleteError) {
      setError(buildErrorMessage(deleteError, "Failed to delete offering."));
    } finally {
      setPendingDeleteId(null);
    }
  };

  const handleToggle = async (offering: AgentOfferingItem) => {
    if (!ownerAddress) return;
    setPendingToggleId(offering.id);
    setError(null);
    setNotice(null);
    try {
      const signed = await buildSignedAuth();
      const response = await fetch(`/api/agent-offerings/${offering.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          ownerAddress,
          actorAddress: signed.actorAddress,
          authPayload: signed.authPayload,
          authSignature: signed.authSignature,
          isActive: !offering.isActive,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to update offering visibility.");
      }
      await loadOfferings();
      setNotice(offering.isActive ? "Offering moved to draft." : "Offering published.");
    } catch (toggleError) {
      setError(buildErrorMessage(toggleError, "Failed to update offering visibility."));
    } finally {
      setPendingToggleId(null);
    }
  };

  const handleReorder = async (offeringId: string, direction: -1 | 1) => {
    if (!agentId || !ownerAddress) return;
    const currentIndex = offerings.findIndex((entry) => entry.id === offeringId);
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= offerings.length) return;

    const reordered = [...offerings];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, moved);

    setPendingReorderId(offeringId);
    setError(null);
    setNotice(null);
    try {
      const signed = await buildSignedAuth();
      const response = await fetch("/api/agent-offerings/reorder", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          agentId,
          ownerAddress,
          actorAddress: signed.actorAddress,
          authPayload: signed.authPayload,
          authSignature: signed.authSignature,
          orderedIds: reordered.map((entry) => entry.id),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to reorder offerings.");
      }
      await loadOfferings();
      setNotice("Offering order updated.");
    } catch (reorderError) {
      setError(buildErrorMessage(reorderError, "Failed to reorder offerings."));
    } finally {
      setPendingReorderId(null);
    }
  };

  return (
    <div className="mt-4 border border-neutral-900 bg-neutral-900 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Agent Offerings</p>
          <p className="mt-1 max-w-2xl text-xs text-neutral-600">
            Define the public services this agent offers. These listings appear on the public agent profile and tell
            consumers what to request through GhostGate.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {publicProfileHref && (
            <a
              href={publicProfileHref}
              className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100"
            >
              View Public Profile -&gt;
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              resetForm();
              setNotice(null);
              setError(null);
            }}
            className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100"
          >
            + Add Offering
          </button>
        </div>
      </div>

      {!gatewayConfigured && (
        <div className="mt-4 border border-amber-900/40 bg-amber-950/10 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-amber-300 font-bold">GhostGate activation required</p>
          <p className="mt-2 text-xs text-neutral-400">
            Offerings validate ownership and service targets against the selected agent&apos;s live gateway config. Save
            gateway config first, then add offerings.
          </p>
        </div>
      )}

      {!actorAddress && (
        <div className="mt-4 border border-neutral-800 bg-neutral-950 px-3 py-3">
          <p className="text-xs text-neutral-500">
            Connect the owner wallet to create, edit, publish, delete, or reorder offerings.
          </p>
        </div>
      )}

      <div className="mt-4 border border-neutral-800 bg-neutral-950 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-500 font-bold">
            {editingOfferingId ? "Edit Offering" : "New Offering"}
          </p>
          {editingOfferingId && currentEditingOffering && (
            <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-600 font-bold">
              Editing {currentEditingOffering.title}
            </span>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            Offering Title
            <input
              value={formState.title}
              onChange={(event) => setFormState((current) => ({ ...current, title: event.target.value }))}
              placeholder="Wallet Risk Review"
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            />
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            Rail
            <select
              value={formState.rail}
              onChange={(event) => handleRailChange(event.target.value as AgentOfferingRailValue)}
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            >
              {AGENT_OFFERING_RAILS.map((rail) => (
                <option key={rail} value={rail}>
                  {rail}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold lg:col-span-2">
            Description
            <textarea
              value={formState.description}
              onChange={(event) => setFormState((current) => ({ ...current, description: event.target.value }))}
              rows={3}
              placeholder="Explain what the agent does, what the consumer gets back, and when this offering makes sense."
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            />
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold lg:col-span-2">
            Consumer Command
            <textarea
              value={formState.consumerCommand}
              onChange={(event) => setFormState((current) => ({ ...current, consumerCommand: event.target.value }))}
              rows={3}
              placeholder={getPlaceholderCommand(formState.rail)}
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none font-mono text-sm"
            />
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            Target Type
            <select
              value={formState.targetKind}
              onChange={(event) => handleTargetKindChange(event.target.value as AgentOfferingTargetKindValue)}
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            >
              {AGENT_OFFERING_TARGET_KINDS.map((targetKind) => (
                <option
                  key={targetKind}
                  value={targetKind}
                  disabled={formState.rail === "GHOSTWIRE" ? targetKind !== "GHOSTWIRE_INTENT" : targetKind === "GHOSTWIRE_INTENT"}
                >
                  {targetKind}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            Target Reference
            <input
              value={formState.targetRef}
              onChange={(event) => setFormState((current) => ({ ...current, targetRef: event.target.value }))}
              placeholder={formState.targetKind === "SERVICE_SLUG" ? serviceSlug ?? "agent-18755" : formState.targetKind === "MCP_TOOL" ? "lucien_short_video" : "music-video-custom"}
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none font-mono"
            />
            <p className="mt-2 text-[11px] normal-case tracking-normal text-neutral-600">
              {getTargetHelper(formState.targetKind, serviceSlug)}
            </p>
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            {getPriceGuidanceLabel(formState.rail)}
            <input
              value={formState.priceHint}
              onChange={(event) => setFormState((current) => ({ ...current, priceHint: event.target.value }))}
              placeholder={getPriceGuidancePlaceholder(formState.rail)}
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            />
            <p className="mt-2 text-[11px] normal-case tracking-normal text-neutral-600">
              {getPriceGuidanceHelper(formState.rail)}
            </p>
          </label>
          <label className="block text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">
            ETA
            <input
              value={formState.etaHint}
              onChange={(event) => setFormState((current) => ({ ...current, etaHint: event.target.value }))}
              placeholder="~5 min"
              className="mt-2 w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-white outline-none focus:border-red-600 rounded-none"
            />
          </label>
          <label className="inline-flex items-center gap-3 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold lg:col-span-2">
            <input
              type="checkbox"
              checked={formState.isActive}
              onChange={(event) => setFormState((current) => ({ ...current, isActive: event.target.checked }))}
              className="h-4 w-4 border-neutral-700 bg-neutral-950 text-red-600"
            />
            Published
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canMutate || isSubmitting}
            className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? "Saving..." : editingOfferingId ? "Update Offering" : "Create Offering"}
          </button>
          {(editingOfferingId || formState.title || formState.description || formState.consumerCommand) && (
            <button
              type="button"
              onClick={resetForm}
              className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs uppercase tracking-[0.16em] text-neutral-500 transition hover:border-neutral-700 hover:text-neutral-300"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {notice && <p className="mt-4 text-xs text-emerald-300">{notice}</p>}
      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}

      {isLoading ? (
        <p className="mt-4 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Loading offerings...</p>
      ) : offerings.length === 0 ? (
        <div className="mt-4 border border-neutral-800 bg-neutral-950 p-4">
          <p className="text-xs text-neutral-500">
            No offerings yet. Add a public listing so consumers can see what this agent sells, how to request it, and
            which Ghost rail it uses.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {offerings.map((offering, index) => (
            <div key={offering.id} className="border border-neutral-800 bg-neutral-950 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm uppercase tracking-[0.14em] text-neutral-200 font-bold">{offering.title}</p>
                    <span className="border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-neutral-400 font-bold">
                      {describeRail(offering.rail)}
                    </span>
                    {!offering.isActive && (
                      <span className="border border-amber-700/60 bg-amber-950/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-amber-300 font-bold">
                        Draft
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-neutral-400">{offering.description}</p>
                </div>
                <div className="text-left sm:text-right">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-600 font-bold">
                    {getOfferingPricingLabel(offering)}
                  </p>
                  <p className="mt-1 text-[11px] text-neutral-300">{getOfferingPricingPrimary(offering)}</p>
                  {offering.canonicalPricing && offering.priceHint && (
                    <p className="mt-1 text-[11px] text-neutral-500">Merchant guidance: {offering.priceHint}</p>
                  )}
                  {offering.etaHint && <p className="mt-1 text-[11px] text-neutral-500">ETA {offering.etaHint}</p>}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="border border-neutral-900 bg-neutral-900 p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600 font-bold">Consumer Command</p>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[12px] text-neutral-200 font-mono">
                    <code>{offering.consumerCommand}</code>
                  </pre>
                </div>
                <div className="border border-neutral-900 bg-neutral-900 p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-600 font-bold">{offering.targetLabel}</p>
                  <p className="mt-2 break-all text-[12px] text-neutral-300 font-mono">{offering.targetRef}</p>
                  <p className="mt-1 text-[11px] text-neutral-600">{offering.targetDescription}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(offering)}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggle(offering)}
                  disabled={!canMutate || pendingToggleId === offering.id}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingToggleId === offering.id ? "Saving..." : offering.isActive ? "Move to Draft" : "Publish"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(offering)}
                  disabled={!canMutate || pendingDeleteId === offering.id}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingDeleteId === offering.id ? "Deleting..." : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleReorder(offering.id, -1)}
                  disabled={!canMutate || index === 0 || pendingReorderId === offering.id}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Move Up
                </button>
                <button
                  type="button"
                  onClick={() => void handleReorder(offering.id, 1)}
                  disabled={!canMutate || index === offerings.length - 1 || pendingReorderId === offering.id}
                  className="inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Move Down
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
