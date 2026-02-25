"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const AGENT_PROFILE_REFRESH_INTERVAL_MS = 15_000;

type AgentProfileAutoRefreshProps = {
  agentId: string;
};

export default function AgentProfileAutoRefresh({ agentId }: AgentProfileAutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    let inFlight = false;

    const refresh = async () => {
      if (!active || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

      inFlight = true;
      try {
        router.refresh();
      } finally {
        inFlight = false;
      }
    };

    const intervalHandle = window.setInterval(() => {
      void refresh();
    }, AGENT_PROFILE_REFRESH_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalHandle);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [agentId, router]);

  return null;
}
