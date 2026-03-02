"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import GhostLogo from "@/components/GhostLogo";
import LatencyIndicator from "@/components/LatencyIndicator";

type TerminalHeaderProps = {
  title: string;
  className?: string;
};

export default function TerminalHeader({ title, className = "" }: TerminalHeaderProps) {
  const rootClassName = `mb-12 flex flex-col gap-4 border-b border-neutral-900 pb-3 md:flex-row md:items-center md:justify-between ${className}`.trim();

  return (
    <header className={rootClassName}>
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <GhostLogo className="h-5 w-5 shrink-0" />
          <h1 className="text-sm leading-tight tracking-[0.2em] text-neutral-100 md:text-base font-bold">
            {title}
          </h1>
        </div>
        <nav className="flex items-center gap-5 pl-8 -mt-0.5">
          <Link
            href="/"
            className="text-[10px] font-regular tracking-[0.2em] text-neutral-500 transition hover:text-red-500"
          >
            /home
          </Link>
          <Link
            href="/rank"
            className="text-[10px] font-regular tracking-[0.2em] text-neutral-500 transition hover:text-red-500"
          >
            /rank
          </Link>
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <LatencyIndicator
          labelClassName="text-neutral-600 text-[10px] tracking-[0.16em]"
          valueClassName="text-red-500 font-bold text-[10px] tracking-[0.16em]"
          offlineValueClassName="text-neutral-500 font-bold text-[10px] tracking-[0.16em]"
        />
        <ConnectButton showBalance={false} chainStatus="icon" accountStatus="full" />
      </div>
    </header>
  );
}
