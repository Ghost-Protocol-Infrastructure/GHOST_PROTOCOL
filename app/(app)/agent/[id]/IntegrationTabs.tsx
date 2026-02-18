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
  `border px-3 py-2 text-xs uppercase tracking-[0.14em] transition ${
    isActive
      ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-200"
      : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200"
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
          <div className="border border-slate-700 bg-slate-950 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Install</p>
            <code className="text-sm text-cyan-300">npm install @ghost/sdk</code>
          </div>
          <div className="border border-slate-700 bg-slate-950 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">TypeScript</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-cyan-300">
              <code>{nodeSnippet}</code>
            </pre>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="border border-slate-700 bg-slate-950 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Install</p>
            <code className="text-sm text-cyan-300">pip install ghost-gate</code>
          </div>
          <div className="border border-slate-700 bg-slate-950 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Python</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-cyan-300">
              <code>{pythonSnippet}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
