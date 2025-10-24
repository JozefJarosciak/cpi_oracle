'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SessionAccount } from '@/components/SessionAccount';
import { MarketControls } from '@/components/MarketControls';
import { OracleDisplay } from '@/components/OracleDisplay';
import { PositionDisplay } from '@/components/PositionDisplay';

export default function Home() {
  const { connected } = useWallet();

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="terminal-border p-6 mb-6">
          <pre className="ascii-art text-xs mb-4">
{`
 ██████╗ ████████╗ ██████╗    ██████╗ ██████╗ ███████╗██████╗ ██╗ ██████╗████████╗
 ██╔══██╗╚══██╔══╝██╔════╝    ██╔══██╗██╔══██╗██╔════╝██╔══██╗██║██╔════╝╚══██╔══╝
 ██████╔╝   ██║   ██║         ██████╔╝██████╔╝█████╗  ██║  ██║██║██║        ██║
 ██╔══██╗   ██║   ██║         ██╔═══╝ ██╔══██╗██╔══╝  ██║  ██║██║██║        ██║
 ██████╔╝   ██║   ╚██████╗    ██║     ██║  ██║███████╗██████╔╝██║╚██████╗   ██║
 ╚═════╝    ╚═╝    ╚═════╝    ╚═╝     ╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝ ╚═════╝   ╚═╝
                     ███╗   ███╗ █████╗ ██████╗ ██╗  ██╗███████╗████████╗
                     ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝██╔════╝╚══██╔══╝
                     ██╔████╔██║███████║██████╔╝█████╔╝ █████╗     ██║
                     ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ██╔══╝     ██║
                     ██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗███████╗   ██║
                     ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝
`}
          </pre>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-xl terminal-glow">PREDICTION MARKET TERMINAL v1.0</h1>
              <p className="text-terminal-dim mt-1">BINARY OPTIONS | BITCOIN PRICE | SOLANA NETWORK</p>
            </div>
            <WalletMultiButton className="terminal-button" />
          </div>
        </div>

        {/* Main Content */}
        {!connected ? (
          <div className="terminal-panel text-center py-12">
            <p className="text-xl mb-4 terminal-glow">{'>'} CONNECT WALLET TO BEGIN</p>
            <p className="text-terminal-dim">BACKPACK | PHANTOM | SOLFLARE | SUPPORTED</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Oracle & Market Controls */}
            <div className="lg:col-span-1 space-y-6">
              <OracleDisplay />
              <MarketControls />
            </div>

            {/* Middle Column - Session Account */}
            <div className="lg:col-span-1">
              <SessionAccount />
            </div>

            {/* Right Column - Position Display */}
            <div className="lg:col-span-1">
              <PositionDisplay />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-8 text-center text-terminal-dim text-xs">
          <p>SYSTEM STATUS: <span className="status-online">ONLINE</span> | NETWORK: SOLANA | ORACLE: CPI</p>
          <p className="mt-1">© 2025 PREDICTION MARKET TERMINAL | ALL RIGHTS RESERVED</p>
        </div>
      </div>
    </main>
  );
}
