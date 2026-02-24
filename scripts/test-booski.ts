import { GhostAgent } from "../sdks/node/index";

const SERVICE_SLUG = "agent-18755";
const DEFAULT_BASE_URL = "http://localhost:3000";

async function main() {
  const privateKey = process.env.GHOST_SIGNER_PRIVATE_KEY as `0x${string}` | undefined;
  const apiKey = process.env.GHOST_API_KEY;
  const baseUrl = (process.env.GHOST_GATE_BASE_URL ?? DEFAULT_BASE_URL).trim();

  if (!privateKey) {
    throw new Error("Missing GHOST_SIGNER_PRIVATE_KEY in terminal env.");
  }
  if (!apiKey) {
    throw new Error("Missing GHOST_API_KEY in terminal env (placeholder is fine for local test).");
  }

  const sdk = new GhostAgent({
    baseUrl,
    privateKey,
    serviceSlug: SERVICE_SLUG,
    creditCost: 1,
  });

  const result = await sdk.connect(apiKey);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
