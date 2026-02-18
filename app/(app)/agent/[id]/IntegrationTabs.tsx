"use client";

import { useMemo, useState } from "react";

type SdkTab = "node" | "python";

type IntegrationTabsProps = {
  agentId: string;
  initialTab?: SdkTab;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");
const APP_BASE_URL = normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL?.trim() || "https://ghostprotocol.cc");

const tabButtonClass = (isActive: boolean): string =>
  `border px-3 py-2 text-xs uppercase tracking-[0.14em] transition ${isActive
    ? "border-neutral-700 bg-neutral-800 text-neutral-200"
    : "border-neutral-800 bg-neutral-950 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
  }`;

export default function IntegrationTabs({ agentId, initialTab = "node" }: IntegrationTabsProps) {
  const [activeTab, setActiveTab] = useState<SdkTab>(initialTab);

  const nodeSnippet = useMemo(
    () => `import { GhostAgent } from "@ghost/sdk";

const apiKey = "sk_live_your_api_key";

(async () => {
  const sdk = new GhostAgent({
    baseUrl: "${APP_BASE_URL}",
    privateKey: "YOUR_PRIVATE_KEY",
    serviceSlug: "agent-${agentId}",
  });

  const result = await sdk.connect(apiKey);
  if (!result.connected) {
    throw new Error("Gateway authorization failed.");
  }

  console.log("Connected to:", result.endpoint);
  console.log("Service slug:", "agent-${agentId}");
})();`,
    [agentId],
  );

  const pythonSnippet = useMemo(
    () => `from ghostgate import GhostGate

gate = GhostGate(
    api_key="sk_live_your_api_key",
    private_key="0xyour_private_key",
    base_url="${APP_BASE_URL}",
)

@gate.guard(cost=1, service="agent-${agentId}", method="POST")
def run_agent():
    return {"ok": True}`,
    [agentId],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={tabButtonClass(activeTab === "node")}
          onClick={() => setActiveTab("node")}
        >
          Node.js
        </button>
        <button
          type="button"
          className={tabButtonClass(activeTab === "python")}
          onClick={() => setActiveTab("python")}
        >
          Python
        </button>
      </div>

      {activeTab === "node" ? (
        <div className="space-y-3">
          <div className="border border-neutral-900 bg-neutral-900 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Install</p>
            <code className="text-sm text-neutral-300 font-mono">npm install @ghost/sdk</code>
          </div>
          <div className="border border-neutral-900 bg-neutral-900 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">TypeScript</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
              <code>{nodeSnippet}</code>
            </pre>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="border border-neutral-900 bg-neutral-900 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Install</p>
            <code className="text-sm text-neutral-300 font-mono">pip install ghost-gate</code>
          </div>
          <div className="border border-neutral-900 bg-neutral-900 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-neutral-500 font-bold">Python</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-neutral-300 font-mono">
              <code>{pythonSnippet}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
