'use client';

import { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { getProgram, findAmmPda, findPositionPda } from '@/lib/program';
import { loadSessionAccount } from '@/lib/sessionAccount';

interface Position {
  yesShares: number;
  noShares: number;
  totalValue: number;
}

export function PositionDisplay() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [position, setPosition] = useState<Position | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const session = loadSessionAccount();
    if (session) {
      setSessionAddress(session.keypair.publicKey.toBase58());
    }
  }, []);

  useEffect(() => {
    if (sessionAddress) {
      fetchPosition();
      const interval = setInterval(fetchPosition, 3000);
      return () => clearInterval(interval);
    }
  }, [sessionAddress, wallet.connected]);

  const fetchPosition = async () => {
    if (!wallet.publicKey || !sessionAddress) return;

    try {
      const [ammPda] = findAmmPda();
      const session = loadSessionAccount();
      if (!session) return;

      const [positionPda] = findPositionPda(ammPda, session.keypair.publicKey);
      const accountInfo = await connection.getAccountInfo(positionPda);

      if (!accountInfo) {
        setPosition(null);
        return;
      }

      // Parse position data (simplified - adjust based on actual structure)
      // This is a placeholder
      setPosition({
        yesShares: 0,
        noShares: 0,
        totalValue: 0,
      });
    } catch (err: any) {
      console.error('Failed to fetch position:', err);
    }
  };

  const formatShares = (shares: number) => {
    return (shares / 1_000_000).toFixed(4);
  };

  return (
    <div className="terminal-panel">
      <h2 className="terminal-panel-title">{'>'} YOUR POSITION</h2>

      {!sessionAddress ? (
        <div className="text-center py-6 text-terminal-dim">
          CREATE SESSION ACCOUNT FIRST
        </div>
      ) : !position ? (
        <div className="text-center py-6 text-terminal-dim">
          NO POSITION YET
          <div className="mt-4 text-xs">
            <p>Initialize your position to start trading.</p>
            <p className="mt-2 text-terminal-text">Coming soon: Trade interface</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Position Summary */}
          <div className="border border-terminal-dim p-3">
            <div className="text-xs text-terminal-bright mb-3">HOLDINGS</div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-terminal-dim">YES SHARES:</span>
                <span className="terminal-glow">{formatShares(position.yesShares)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-terminal-dim">NO SHARES:</span>
                <span className="terminal-glow">{formatShares(position.noShares)}</span>
              </div>
              <div className="border-t border-terminal-dim pt-2 mt-2">
                <div className="flex justify-between text-terminal-bright">
                  <span>TOTAL VALUE:</span>
                  <span>${(position.totalValue / 1_000_000).toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Session Info */}
          <div className="border border-terminal-dim p-3">
            <div className="text-xs text-terminal-bright mb-2">SESSION</div>
            <div className="text-[10px] font-mono break-all text-terminal-dim">
              {sessionAddress}
            </div>
          </div>

          {/* Coming Soon */}
          <div className="text-xs text-center text-terminal-dim border border-terminal-dim p-3">
            <p className="terminal-glow">TRADE INTERFACE</p>
            <p className="mt-1">Coming in next iteration...</p>
            <p className="mt-2">For now, use CLI tools to trade:</p>
            <code className="text-[10px] block mt-1">
              node app/trade.js ...
            </code>
          </div>
        </div>
      )}
    </div>
  );
}
