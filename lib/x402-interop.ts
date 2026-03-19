export const X402_SUPPORTED_SCHEMES = ["exact"] as const;
export const X402_RANK_ELIGIBLE_ASSETS = ["USDC"] as const;
export const X402_REPORTING_MODE = "merchant-signed" as const;
export const X402_NOTES = "Use merchant-side signed settlement reporting for GhostRank credit." as const;

export type X402SupportedScheme = (typeof X402_SUPPORTED_SCHEMES)[number];
export type X402RankEligibleAsset = (typeof X402_RANK_ELIGIBLE_ASSETS)[number];

export type X402Metadata = {
  supported: boolean;
  rankEligible: boolean;
  reportingMode: typeof X402_REPORTING_MODE;
  supportedSchemes: X402SupportedScheme[];
  rankEligibleAssets: X402RankEligibleAsset[];
  notes: string;
};

const normalizeUpper = (value: string | null | undefined): string => value?.trim().toUpperCase() ?? "";
const normalizeLower = (value: string | null | undefined): string => value?.trim().toLowerCase() ?? "";

export const isSupportedX402Scheme = (value: string | null | undefined): value is X402SupportedScheme =>
  X402_SUPPORTED_SCHEMES.includes(normalizeLower(value) as X402SupportedScheme);

export const isRankEligibleX402Asset = (value: string | null | undefined): value is X402RankEligibleAsset =>
  X402_RANK_ELIGIBLE_ASSETS.includes(normalizeUpper(value) as X402RankEligibleAsset);

export const buildX402Metadata = (): X402Metadata => ({
  supported: true,
  rankEligible: true,
  reportingMode: X402_REPORTING_MODE,
  supportedSchemes: [...X402_SUPPORTED_SCHEMES],
  rankEligibleAssets: [...X402_RANK_ELIGIBLE_ASSETS],
  notes: X402_NOTES,
});
