'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function Navbar() {
    return (
        <nav className="flex justify-between items-center border-b border-violet-500/20 pb-6">
            <div className="flex items-center gap-3">
                <div className="relative">
                    <div className="absolute -inset-1 bg-violet-500/20 blur-sm rounded-full"></div>
                    <div className="relative h-3 w-3 bg-violet-500 rounded-full animate-pulse shadow-[0_0_10px_#8b5cf6] will-change-[opacity]"></div>
                </div>
                <div className="relative inline-flex">
                    <div className="absolute inset-0 bg-violet-500/30" aria-hidden="true"></div>
                    <div className="absolute inset-0 text-3xl font-bold font-mono text-white tracking-tighter blur-sm opacity-50" aria-hidden="true">ghost_rank</div>
                    <div className="relative text-3xl font-bold font-mono text-transparent bg-clip-text bg-gradient-to-r from-violet-300 via-white to-violet-300 tracking-tighter">
                        ghost_rank
                    </div>
                </div>
                <div className="px-1.5 py-0.5 rounded-sm bg-violet-900/50 border border-violet-500/40 text-[9px] text-violet-300 font-mono tracking-widest">
                    v1.0.4-beta
                </div>
            </div>

            <ConnectButton />
        </nav>
    );
}
