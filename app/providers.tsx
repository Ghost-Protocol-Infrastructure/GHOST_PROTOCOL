'use client';

import { RainbowKitProvider, darkTheme, getDefaultConfig } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const megaeth: Chain = {
    id: 1337702,
    name: 'MegaETH',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
        default: { http: ['https://mainnet.megaeth.com/rpc'] },
    },
};

const walletConnectProjectId =
    process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? 'YOUR_WALLETCONNECT_PROJECT_ID';

const config = getDefaultConfig({
    appName: 'GhostRank',
    projectId: walletConnectProjectId,
    chains: [baseSepolia, base, megaeth],
    ssr: true,
});

const queryClient = new QueryClient();

export default function Providers({ children }: { children: React.ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider
                    theme={darkTheme({
                        accentColor: '#8b5cf6',
                        accentColorForeground: 'white',
                        borderRadius: 'small',
                        fontStack: 'system',
                    })}
                >
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
