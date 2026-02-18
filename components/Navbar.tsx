'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import LatencyIndicator from './LatencyIndicator';
import GhostLogo from './GhostLogo';

export default function Navbar() {
    return (
        <nav className="flex justify-between items-center border-b border-neutral-900 pb-6">
            <div className="flex items-center gap-3">
                <GhostLogo className="h-5 w-5" />
                <div className="relative inline-flex">
                    <div className="text-sm tracking-[0.2em] text-neutral-100 md:text-base font-bold">
                        ghost_rank // REPUTATION LEADERBOARD
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4">
                <LatencyIndicator
                    labelClassName="text-neutral-600 text-[10px] tracking-[0.16em]"
                    valueClassName="text-red-500 font-bold text-[10px] tracking-[0.16em]"
                    offlineValueClassName="text-neutral-500 font-bold text-[10px] tracking-[0.16em]"
                />
                <ConnectButton showBalance={false} chainStatus="icon" accountStatus={{
                    smallScreen: 'avatar',
                    largeScreen: 'full',
                }} />
            </div>
        </nav>
    );
}
