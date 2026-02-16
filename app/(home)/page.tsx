'use client';

import React from 'react';
import { Shield, ChevronRight, Activity, Lock } from 'lucide-react';

const HomePage = () => {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-400 font-mono selection:bg-red-900 selection:text-white overflow-x-hidden">
      <div className="fixed top-0 left-0 w-full z-50 border-b border-neutral-900 bg-neutral-950/90 backdrop-blur-sm h-12 flex items-center px-4 justify-between text-xs tracking-widest uppercase">
        <div className="flex items-center gap-4">
          <span className="text-neutral-100 font-bold flex items-center gap-2">
            <div className="w-2 h-2 bg-red-600 animate-pulse" />
            GHOST_PROTOCOL
          </span>
          <span className="hidden md:inline text-neutral-600">
            {"// INDEXING_V.1.0.4"}
          </span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-neutral-600">LATENCY:</span>
            <span className="text-red-500 font-bold">09ms</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-neutral-600">STATUS:</span>
            <span className="text-neutral-100">OPERATIONAL</span>
          </div>
        </div>
      </div>

      <main className="pt-32 pb-20 px-6 max-w-7xl mx-auto relative border-l border-r border-neutral-900 min-h-screen flex flex-col justify-center">
        <div className="absolute top-20 right-0 w-1/2 h-full opacity-10 pointer-events-none overflow-hidden">
          <div className="w-full h-full bg-gradient-to-b from-neutral-800 to-transparent transform -skew-x-12 translate-x-20" />
        </div>

        <div className="relative z-10">
          <div className="mb-6 inline-block px-3 py-1 border border-red-900/30 bg-red-950/10 text-red-500 text-xs font-bold tracking-[0.2em]">
            SYSTEM_OVERRIDE_INITIATED
          </div>

          <h1 className="text-5xl md:text-8xl font-black text-neutral-100 leading-[0.9] tracking-tighter mb-8 uppercase">
            The Shadow
            <br />
            Infrastructure
            <br />
            <span className="text-neutral-600">For The Agentic</span>
            <br />
            Economy.
          </h1>

          <p className="max-w-2xl text-lg md:text-xl text-neutral-500 leading-relaxed mb-12 border-l-2 border-red-600 pl-6">
            We are killing the arcade. The era of neon nostalgia is over.
            We build the heavy rails for autonomous capital.
            Cold. Expensive. Dangerous.
          </p>

          <div className="flex flex-col md:flex-row gap-4">
            <a
              href="/rank"
              className="group relative px-8 py-4 bg-neutral-100 text-neutral-950 font-bold text-sm tracking-widest uppercase hover:bg-red-600 hover:text-white transition-colors duration-200"
            >
              Enter_Terminal
            </a>
            <a
              href="https://github.com/Ghost-Protocol-Infrastructure"
              target="_blank"
              rel="noreferrer"
              className="px-8 py-4 border border-neutral-800 text-neutral-400 font-bold text-sm tracking-widest uppercase hover:border-neutral-100 hover:text-neutral-100 transition-colors duration-200 flex items-center gap-2"
            >
              <GithubIcon className="w-4 h-4" />
              Source_Code
            </a>
          </div>
        </div>

        <div className="absolute bottom-10 left-0 w-full border-t border-b border-neutral-900 py-2 overflow-hidden bg-neutral-950">
          <div className="whitespace-nowrap text-[10px] text-neutral-700 font-bold tracking-widest animate-marquee inline-block">
            {"// INDEXING MEGAETH AGENTS // REPUTATION LAYER ACTIVE // SETTLEMENT RAIL ONLINE // BLOCK_TIME: 10MS // TX_VOLUME: 4.2M ETH // AGENT_ID_2049 VERIFIED // INDEXING MEGAETH AGENTS // REPUTATION LAYER ACTIVE //"}
          </div>
        </div>
      </main>

      <section className="border-t border-neutral-900 bg-neutral-950">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 min-h-[600px]">
          <div className="col-span-1 lg:col-span-7 p-8 md:p-16 border-r border-neutral-900 flex flex-col justify-center">
            <h2 className="text-3xl font-bold text-neutral-100 mb-8 uppercase flex items-center gap-3">
              <Shield className="w-6 h-6 text-red-600" />
              The Manifesto
            </h2>
            <div className="space-y-8 text-neutral-400 text-sm leading-7">
              <p>
                <strong className="text-neutral-200 block mb-2">{"// 01. THE DEATH OF THE ARCADE"}</strong>
                We declare the end of the &quot;Neon Era.&quot; The magenta sunsets and cyan grids were for tourists. We are not players. We are the Architects.
              </p>
              <p>
                <strong className="text-neutral-200 block mb-2">{"// 02. ENTER CYPHER_CORE"}</strong>
                Our aesthetic is not a vibe; it is a weight. We embrace the Void Black, Tungsten Grey, and Bone White. The visual language of heavy financial infrastructure.
              </p>
              <p>
                <strong className="text-neutral-200 block mb-2">{"// 03. THE PHILOSOPHY OF MASS"}</strong>
                Ghost Protocol is the Shadow Layer. We are the impenetrable geometry that sits beneath the market. Not the flashing lights, but the engine block itself.
              </p>
            </div>
          </div>

          <div className="col-span-1 lg:col-span-5 grid grid-rows-2">
            <div className="border-b border-neutral-900 p-8 md:p-12 hover:bg-neutral-900/30 transition-colors group cursor-pointer">
              <div className="flex justify-between items-start mb-6">
                <Activity className="w-8 h-8 text-neutral-600 group-hover:text-neutral-100 transition-colors" />
                <span className="text-[10px] border border-neutral-800 px-2 py-1 text-neutral-500">
                  DISCOVERY
                </span>
              </div>
              <h3 className="text-2xl font-bold text-neutral-100 mb-2">GhostRank</h3>
              <p className="text-neutral-500 text-sm mb-6">
                The Reputation Layer. A decentralized leaderboard indexing performance, uptime, and yield. The Bloomberg Terminal for Agents.
              </p>
              <div className="flex items-center gap-2 text-red-600 text-xs font-bold uppercase tracking-wider group-hover:gap-4 transition-all">
                Access_Terminal <ChevronRight className="w-4 h-4" />
              </div>
            </div>

            <div className="p-8 md:p-12 hover:bg-neutral-900/30 transition-colors group cursor-pointer">
              <div className="flex justify-between items-start mb-6">
                <Lock className="w-8 h-8 text-neutral-600 group-hover:text-neutral-100 transition-colors" />
                <span className="text-[10px] border border-neutral-800 px-2 py-1 text-neutral-500">
                  SETTLEMENT
                </span>
              </div>
              <h3 className="text-2xl font-bold text-neutral-100 mb-2">GhostGate</h3>
              <p className="text-neutral-500 text-sm mb-6">
                The Permissionless Rail. A monetization SDK gating API access behind crypto payments. The Stripe for the Machine Economy.
              </p>
              <div className="flex items-center gap-2 text-neutral-400 text-xs font-bold uppercase tracking-wider group-hover:text-neutral-100 group-hover:gap-4 transition-all">
                Coming_Soon <ChevronRight className="w-4 h-4" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-neutral-900 bg-neutral-950 py-12 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-end gap-8">
          <div>
            <div className="text-xs text-neutral-600 mb-4 font-bold tracking-widest">
              GHOST_PROTOCOL_INFRASTRUCTURE
            </div>
            <div className="text-[10px] text-neutral-700 max-w-sm leading-relaxed">
              Indexing ERC-8004 registries on MegaETH & Base.
              <br />
              All systems nominal. No warranties implied.
              <br />
              © 2026 Ghost Protocol.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-12 text-xs tracking-wider uppercase">
            <div className="flex flex-col gap-3">
              <span className="text-neutral-500 font-bold mb-1">Network</span>
              <a href="#" className="hover:text-red-500 transition-colors">Base (L2)</a>
              <a href="#" className="hover:text-red-500 transition-colors">MegaETH</a>
            </div>
            <div className="flex flex-col gap-3">
              <span className="text-neutral-500 font-bold mb-1">Uplink</span>
              <a href="https://twitter.com/GhostProtocol_0" target="_blank" rel="noreferrer" className="hover:text-red-500 transition-colors">Twitter_X</a>
              <a href="https://github.com/Ghost-Protocol-Infrastructure" target="_blank" rel="noreferrer" className="hover:text-red-500 transition-colors">Github</a>
            </div>
          </div>
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-marquee {
          animation: marquee 30s linear infinite;
        }
      `}} />
    </div>
  );
};

const GithubIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

export default HomePage;
