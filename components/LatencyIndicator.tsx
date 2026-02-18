"use client";

import { useEffect, useState } from "react";

type LatencyIndicatorProps = {
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  offlineValueClassName?: string;
  showLabel?: boolean;
  label?: string;
};

export default function LatencyIndicator({
  className = "flex items-center gap-2",
  labelClassName = "text-neutral-600",
  valueClassName = "text-red-500 font-bold",
  offlineValueClassName = "text-neutral-500 font-bold",
  showLabel = true,
  label = "LATENCY:",
}: LatencyIndicatorProps) {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    let isActive = true;
    let isPolling = false;

    const checkLatency = async () => {
      if (!isActive || isPolling) return;
      isPolling = true;

      const startedAt = Date.now();

      try {
        const response = await fetch("/api/telemetry/pulse", {
          method: "GET",
          cache: "no-store",
          headers: {
            "cache-control": "no-cache",
          },
        });

        if (!response.ok) {
          throw new Error(`Pulse request failed: ${response.status}`);
        }

        setLatencyMs(Math.max(0, Date.now() - startedAt));
        setIsOffline(false);
      } catch {
        setLatencyMs(null);
        setIsOffline(true);
      } finally {
        isPolling = false;
      }
    };

    void checkLatency();
    const intervalId = window.setInterval(() => {
      void checkLatency();
    }, 5_000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const value = latencyMs == null ? "--ms" : `${latencyMs}ms`;
  const valueClass = isOffline || latencyMs == null ? offlineValueClassName : valueClassName;

  return (
    <div className={className}>
      {showLabel ? <span className={labelClassName}>{label}</span> : null}
      <span className={valueClass}>{value}</span>
    </div>
  );
}
