'use client';

import { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getProgram, findAmmPda, findVaultPda, findPositionPda } from '@/lib/program';
import { loadSessionAccount } from '@/lib/sessionAccount';
import { ORACLE_STATE, ORACLE_PROGRAM_ID, LAMPORTS_PER_E6 } from '@/lib/constants';
import { BN } from '@coral-xyz/anchor';

interface MarketState {
  isOpen: boolean;
  isStopped: boolean;
  isSettled: boolean;
  b: number;
  qYes: number;
  qNo: number;
  vaultE6: number;
  startPriceE6?: number;
}

export function MarketControls() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [marketState, setMarketState] = useState<MarketState | null>(null);
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');

  // Market init params
  const [initB, setInitB] = useState('500');
  const [initFee, setInitFee] = useState('25');

  useEffect(() => {
    fetchMarketState();
    const interval = setInterval(fetchMarketState, 3000);
    return () => clearInterval(interval);
  }, [wallet.connected]);

  const fetchMarketState = async () => {
    if (!wallet.publicKey) return;

    try {
      const [ammPda] = findAmmPda();
      const accountInfo = await connection.getAccountInfo(ammPda);

      if (!accountInfo) {
        setMarketState(null);
        return;
      }

      // Parse market state (simplified - adjust based on actual account structure)
      // This is a placeholder - you'll need to properly deserialize using Anchor
      const data = accountInfo.data;

      setMarketState({
        isOpen: true,
        isStopped: false,
        isSettled: false,
        b: 500,
        qYes: 0,
        qNo: 0,
        vaultE6: 0,
      });
    } catch (err: any) {
      console.error('Failed to fetch market state:', err);
    }
  };

  const handleInitMarket = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError('Wallet not connected');
      return;
    }

    const session = loadSessionAccount();
    if (!session) {
      setError('No session account. Create one first.');
      return;
    }

    setLoading('init');
    setError('');

    try {
      const b = parseInt(initB);
      const feeBps = parseInt(initFee);

      if (isNaN(b) || isNaN(feeBps)) {
        throw new Error('Invalid parameters');
      }

      const program = getProgram(connection, wallet as any);
      const [ammPda] = findAmmPda();
      const [vaultPda] = findVaultPda(ammPda);

      // Initialize market with session account as payer
      const tx = await program.methods
        .initAmm(new BN(b), feeBps)
        .accounts({
          amm: ammPda,
          vaultSol: vaultPda,
          admin: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log('Market initialized:', tx);
      await fetchMarketState();
    } catch (err: any) {
      setError(`Init failed: ${err.message}`);
    } finally {
      setLoading('');
    }
  };

  const handleSnapshotStart = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError('Wallet not connected');
      return;
    }

    setLoading('snapshot');
    setError('');

    try {
      const program = getProgram(connection, wallet as any);
      const [ammPda] = findAmmPda();

      const tx = await program.methods
        .snapshotStart()
        .accounts({
          amm: ammPda,
          oracleState: ORACLE_STATE,
          oracleProgram: ORACLE_PROGRAM_ID,
          admin: wallet.publicKey,
        })
        .rpc();

      console.log('Snapshot taken:', tx);
      await fetchMarketState();
    } catch (err: any) {
      setError(`Snapshot failed: ${err.message}`);
    } finally {
      setLoading('');
    }
  };

  const handleStopMarket = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError('Wallet not connected');
      return;
    }

    setLoading('stop');
    setError('');

    try {
      const program = getProgram(connection, wallet as any);
      const [ammPda] = findAmmPda();

      const tx = await program.methods
        .stopMarket()
        .accounts({
          amm: ammPda,
          admin: wallet.publicKey,
        })
        .rpc();

      console.log('Market stopped:', tx);
      await fetchMarketState();
    } catch (err: any) {
      setError(`Stop failed: ${err.message}`);
    } finally {
      setLoading('');
    }
  };

  const handleSettleOracle = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError('Wallet not connected');
      return;
    }

    setLoading('settle');
    setError('');

    try {
      const program = getProgram(connection, wallet as any);
      const [ammPda] = findAmmPda();

      const tx = await program.methods
        .settleByOracle()
        .accounts({
          amm: ammPda,
          oracleState: ORACLE_STATE,
          oracleProgram: ORACLE_PROGRAM_ID,
          admin: wallet.publicKey,
        })
        .rpc();

      console.log('Market settled:', tx);
      await fetchMarketState();
    } catch (err: any) {
      setError(`Settle failed: ${err.message}`);
    } finally {
      setLoading('');
    }
  };

  return (
    <div className="terminal-panel">
      <h2 className="terminal-panel-title">{'>'} MARKET CONTROLS</h2>

      {!marketState ? (
        <div className="space-y-4">
          <div className="text-terminal-dim text-sm mb-3">
            NO MARKET FOUND - INITIALIZE NEW MARKET
          </div>

          <div className="border border-terminal-dim p-3">
            <div className="text-xs text-terminal-bright mb-2">PARAMETERS</div>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-terminal-dim">Liquidity (b):</label>
                <input
                  type="number"
                  value={initB}
                  onChange={(e) => setInitB(e.target.value)}
                  className="terminal-input w-full mt-1"
                  placeholder="500"
                />
              </div>
              <div>
                <label className="text-xs text-terminal-dim">Fee (bps):</label>
                <input
                  type="number"
                  value={initFee}
                  onChange={(e) => setInitFee(e.target.value)}
                  className="terminal-input w-full mt-1"
                  placeholder="25"
                />
              </div>
            </div>
          </div>

          <button
            onClick={handleInitMarket}
            disabled={!!loading}
            className="terminal-button w-full"
          >
            {loading === 'init' ? 'INITIALIZING...' : '['} INITIALIZE MARKET {']'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Market Status */}
          <div className="border border-terminal-dim p-3">
            <div className="text-xs text-terminal-bright mb-2">STATUS</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-terminal-dim">STATE:</span>{' '}
                <span className={marketState.isSettled ? 'text-red-500' : marketState.isStopped ? 'text-yellow-400' : 'status-online'}>
                  {marketState.isSettled ? 'SETTLED' : marketState.isStopped ? 'STOPPED' : 'ACTIVE'}
                </span>
              </div>
              <div>
                <span className="text-terminal-dim">LIQUIDITY:</span> {marketState.b}
              </div>
              <div>
                <span className="text-terminal-dim">YES SHARES:</span> {(marketState.qYes / 1_000_000).toFixed(2)}
              </div>
              <div>
                <span className="text-terminal-dim">NO SHARES:</span> {(marketState.qNo / 1_000_000).toFixed(2)}
              </div>
            </div>
            {marketState.startPriceE6 && (
              <div className="mt-2 text-xs">
                <span className="text-terminal-dim">START PRICE:</span>{' '}
                ${(marketState.startPriceE6 / 1_000_000).toFixed(2)}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="space-y-2">
            <button
              onClick={handleSnapshotStart}
              disabled={!!loading || marketState.isStopped}
              className="terminal-button w-full text-sm"
            >
              {loading === 'snapshot' ? 'TAKING SNAPSHOT...' : '['} SNAPSHOT START PRICE {']'}
            </button>

            <button
              onClick={handleStopMarket}
              disabled={!!loading || marketState.isStopped || marketState.isSettled}
              className="terminal-button w-full text-sm"
            >
              {loading === 'stop' ? 'STOPPING...' : '['} STOP MARKET {']'}
            </button>

            <button
              onClick={handleSettleOracle}
              disabled={!!loading || !marketState.isStopped || marketState.isSettled}
              className="terminal-button w-full text-sm"
            >
              {loading === 'settle' ? 'SETTLING...' : '['} RESOLVE BY ORACLE {']'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-red-500 text-xs border border-red-500 p-2 mt-3">
          ERROR: {error}
        </div>
      )}
    </div>
  );
}
