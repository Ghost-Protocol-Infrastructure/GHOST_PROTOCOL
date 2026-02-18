'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function Navbar() {
    return (
        <nav className="flex justify-between items-center border-b border-neutral-900 pb-6">
            <div className="flex items-center gap-3">
                <div className="relative">
                    <div className="h-3 w-3 bg-red-600 rounded-none animate-pulse"></div>
                </div>
                <div className="relative inline-flex">
                    <div className="text-sm tracking-[0.2em] text-neutral-100 md:text-base font-bold">
                        ghost_rank // REPUTATION LEADERBOARD
                    </div>
                </div>
            </div>

            <ConnectButton showBalance={false} chainStatus="icon" accountStatus={{
                smallScreen: 'avatar',
                largeScreen: 'full',
            }} />
        </nav>
    );
}
