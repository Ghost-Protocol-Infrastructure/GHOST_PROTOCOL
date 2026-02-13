'use client';

import { useState, useMemo } from 'react';
import { GhostAgent } from '../types/ghost';
import { Search, ChevronUp, ChevronDown, Trophy } from 'lucide-react';

interface Props {
    initialAgents: GhostAgent[];
}

type SortKey = 'rank' | 'reputationScore' | 'totalEarningsEth' | 'uptimePct';

export default function GhostList({ initialAgents }: Props) {
    const [searchQuery, setSearchQuery] = useState('');
    const [sortKey, setSortKey] = useState<SortKey>('rank');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

    const filteredAgents = useMemo(() => {
        return initialAgents.filter(agent => {
            const lowerQuery = searchQuery.toLowerCase();
            return agent.agentAddress.toLowerCase().includes(lowerQuery) ||
                agent.reputationScore.toString().includes(lowerQuery);
        });
    }, [initialAgents, searchQuery]);

    const sortedAgents = useMemo(() => {
        return [...filteredAgents].sort((a, b) => {
            let aValue: number | string = a[sortKey];
            let bValue: number | string = b[sortKey];

            if (sortKey === 'totalEarningsEth') {
                aValue = parseFloat(a.totalEarningsEth);
                bValue = parseFloat(b.totalEarningsEth);
            }

            if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    }, [filteredAgents, sortKey, sortOrder]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortOrder('desc');
        }
    };

    const SortIcon = ({ column }: { column: SortKey }) => {
        if (sortKey !== column) return <div className="w-3 h-3 opacity-0 group-hover:opacity-30" />;
        return sortOrder === 'asc' ? <ChevronUp className="w-3 h-3 text-violet-400" /> : <ChevronDown className="w-3 h-3 text-violet-400" />;
    };

    return (
        <div className="space-y-6">
            {/* Search Bar */}
            <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-violet-500/50 group-focus-within:text-violet-400 transition-colors" />
                </div>
                <input
                    type="text"
                    placeholder="search_agent_id_or_score..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="block w-full pl-10 pr-3 py-3 border border-violet-500/20 rounded-lg leading-5 bg-slate-950/80 text-violet-100 placeholder-violet-500/30 focus:outline-none focus:bg-slate-950 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 sm:text-sm transition-colors shadow-lg backdrop-blur-sm transform-gpu font-mono"
                />
            </div>

            {/* Neon Terminal Card */}
            <div className="relative bg-slate-950/80 backdrop-blur-md transform-gpu border border-violet-500/30 rounded-lg overflow-hidden shadow-[0_0_40px_-10px_rgba(139,92,246,0.3)]">
                {/* Decorative Top Bar */}
                <div className="h-1 w-full bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-600 opacity-50"></div>

                {/* Header */}
                <div className="grid grid-cols-12 gap-0 border-b border-violet-500/30 bg-violet-950/10 text-xs font-regular tracking-widest text-violet-300">
                    <div
                        onClick={() => handleSort('rank')}
                        className="col-span-1 py-3 px-4 border-r border-violet-500/20 flex items-center gap-2 cursor-pointer transition-colors"
                    >
                        RANK <SortIcon column="rank" />
                    </div>
                    <div className="col-span-1 py-3 px-4 border-r border-violet-500/20">
                        STATUS
                    </div>
                    <div className="col-span-4 py-3 px-4 border-r border-violet-500/20">
                        AGENT ID
                    </div>
                    <div
                        onClick={() => handleSort('reputationScore')}
                        className="col-span-2 py-3 px-4 border-r border-violet-500/20 cursor-pointer transition-colors flex items-center gap-2"
                    >
                        REPUTATION <SortIcon column="reputationScore" />
                    </div>
                    <div
                        onClick={() => handleSort('totalEarningsEth')}
                        className="col-span-2 py-3 px-4 border-r border-violet-500/20 cursor-pointer transition-colors flex items-center gap-2"
                    >
                        24H YIELD <SortIcon column="totalEarningsEth" />
                    </div>
                    <div
                        onClick={() => handleSort('uptimePct')}
                        className="col-span-2 py-3 px-4 flex justify-end cursor-pointer transition-colors items-center gap-2"
                    >
                        UPTIME <SortIcon column="uptimePct" />
                    </div>
                </div>

                {/* Rows */}
                <div className="divide-y divide-violet-500/10">
                    {sortedAgents.map((agent) => (
                        <div
                            key={agent.agentAddress}
                            className="grid grid-cols-12 gap-0 items-center hover:bg-violet-500/10 group text-sm"
                        >
                            {/* Rank */}
                            <div className="col-span-1 py-3 px-4 border-r border-violet-500/10 font-regular font-mono">
                                <span
                                    className={`${agent.rank === 1 ? 'text-violet-200' :
                                        agent.rank <= 3 ? 'text-violet-300' :
                                            'text-slate-500'
                                        }`}
                                    style={agent.rank === 1 ? { textShadow: '0 0 10px rgba(167,139,250,0.8)' } : undefined}
                                >
                                    {String(agent.rank).padStart(2, '0')}
                                </span>
                            </div>

                            {/* Status Indicator (using uptime as pseudo-status) */}
                            <div className="col-span-1 py-3 px-4 border-r border-violet-500/10 flex justify-center">
                                <div className={`w-2 h-2 rounded-sm ${agent.rank <= 3 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-700'}`}></div>
                            </div>

                            {/* Address */}
                            <div className="col-span-4 py-3 px-4 border-r border-violet-500/10 font-mono text-slate-300 truncate group-hover:text-violet-200">
                                {agent.agentAddress}
                            </div>

                            {/* Score */}
                            <div className="col-span-2 py-3 px-4 border-r border-violet-500/10 font-mono">
                                <span className={`${agent.reputationScore > 90 ? 'text-emerald-400' :
                                    agent.reputationScore < 50 ? 'text-rose-500' :
                                        'text-slate-400'
                                    }`}>
                                    {agent.reputationScore}
                                </span>
                            </div>

                            {/* Yield */}
                            <div className="col-span-2 py-3 px-4 border-r border-violet-500/10 font-mono text-slate-400">
                                <span className="bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded-sm text-xs border border-emerald-500/20">
                                    Ξ {agent.totalEarningsEth}
                                </span>
                            </div>

                            {/* Uptime */}
                            <div className="col-span-2 py-3 px-4 font-mono text-right text-slate-500">
                                {agent.uptimePct}%
                            </div>
                        </div>
                    ))}
                </div>

                {sortedAgents.length === 0 && (
                    <div className="p-12 text-center text-violet-500/50 text-sm tracking-widest font-mono border-t border-violet-500/10">
                        &gt; system_alert: no_signatures_found
                    </div>
                )}
            </div>
        </div>
    );
}
