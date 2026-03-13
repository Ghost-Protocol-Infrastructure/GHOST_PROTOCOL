export const resolveGhostWireDeliverableLocator = (metadataUri: string | null | undefined): string | null => {
  const trimmed = metadataUri?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const buildGhostWireDeliverableSummary = (input: {
  jobId: string;
  metadataUri: string | null | undefined;
  contractState: string;
}) => {
  const locatorUrl = resolveGhostWireDeliverableLocator(input.metadataUri);
  const completed = input.contractState === "COMPLETED";

  return {
    available: Boolean(locatorUrl && completed),
    locatorUrl,
    mode: locatorUrl ? "merchant_locator" : "none",
    state: completed && locatorUrl ? "READY" : locatorUrl ? "PENDING" : "UNCONFIGURED",
  } as const;
};
