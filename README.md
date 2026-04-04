# Ghost Protocol

Building the Shadow Infrastructure for the Machine Economy.

## Links

- Website: `https://ghostprotocol.cc`
- Developer Portal: [`docs/developer-portal/README.md`](docs/developer-portal/README.md)
- Platform How-To: [`docs/platform-how-to.md`](docs/platform-how-to.md)
- Node Merchant Quickstart: [`docs/developer-portal/quickstart-node.md`](docs/developer-portal/quickstart-node.md)
- Python Merchant Quickstart: [`docs/developer-portal/quickstart-python.md`](docs/developer-portal/quickstart-python.md)
- Onboarding and Configuration: [`docs/developer-portal/onboarding-and-configuration.md`](docs/developer-portal/onboarding-and-configuration.md)
- Fulfillment Operator Runbook: [`docs/fulfillment-operator-runbook.md`](docs/fulfillment-operator-runbook.md)

## What This Repo Contains

- Agent ranking and indexing pipeline
- GhostGate Express + open `x402` monetization rails, settlement reporting, and SDKs
- Config-first HTTP monetization kit and MCP payment-aware proxy surfaces
- Direct GhostWire escrow APIs, SDKs, and reconciliation tooling
- Merchant fulfillment routes and operator tooling
- Merchant dashboard and developer onboarding surfaces

## Quick Start

If you want to use Ghost Protocol, start here:

1. New merchant, Node.js:
   - [`docs/developer-portal/quickstart-node.md`](docs/developer-portal/quickstart-node.md)
2. New merchant, Python:
   - [`docs/developer-portal/quickstart-python.md`](docs/developer-portal/quickstart-python.md)
3. Need the broader merchant + consumer flow:
   - [`docs/platform-how-to.md`](docs/platform-how-to.md)
4. Need rail choice, pricing policy, offerings, and settlement details:
   - [`docs/developer-portal/onboarding-and-configuration.md`](docs/developer-portal/onboarding-and-configuration.md)
5. Already live and operating traffic:
   - [`docs/fulfillment-operator-runbook.md`](docs/fulfillment-operator-runbook.md)

## Local Development

- Local app: `npm run dev`
- Data/index refresh: `npm run index:db`
- Telemetry signal ingestion: `npm run ingest:telemetry`
- Legacy scoring: `npm run score`
- V2 scoring pipeline: `npm run score:v2`

## Notes

- The public repo homepage remains the canonical product URL: `https://ghostprotocol.cc`
- GitHub only supports a single homepage link in the repo About panel, so developer docs are exposed here in the root README.
