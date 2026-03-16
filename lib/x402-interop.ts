export const GHOST_GATE_X402_DEFAULT_SCHEME = "ghost-eip712-credit-v1" as const;
export const X402_DEMO_SERVICE = "x402-demo" as const;
export const X402_DEMO_COST = 1n;

export const isX402DemoService = (service: string | null | undefined): boolean =>
  service?.trim().toLowerCase() === X402_DEMO_SERVICE;

export const isX402EnabledForService = (
  service: string | null | undefined,
  globallyEnabled: boolean,
): boolean => globallyEnabled || isX402DemoService(service);
