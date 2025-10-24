'use client';

import { useState, useEffect } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { ORACLE_STATE, ORACLE_PROGRAM_ID } from '@/lib/constants';

interface OracleData {
  param1: number;
  param2: number;
  param3: number;
  timestamp1: number;
  timestamp2: number;
  timestamp3: number;
  median: number;
  age: number;
}

export function OracleDisplay() {
  const { connection } = useConnection();
  const [oracleData, setOracleData] = useState<OracleData | null>(null);
  const [error, setError] = useState<string>('');
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    fetchOracleData();
    const interval = setInterval(fetchOracleData, 5000); // Update every 5s
    return () => clearInterval(interval);
  }, []);

  const fetchOracleData = async () => {
    try {
      const accountInfo = await connection.getAccountInfo(ORACLE_STATE);
      if (!accountInfo) {
        setError('Oracle account not found');
        return;
      }

      // Parse oracle account data based on the oracle program structure
      // Assuming triplet structure: [param1: u64, ts1: i64, param2: u64, ts2: i64, param3: u64, ts3: i64]
      const data = accountInfo.data;

      // Skip discriminator if exists (8 bytes for Anchor programs)
      const offset = data.length > 100 ? 8 : 0;

      const param1 = Number(data.readBigUInt64LE(offset));
      const timestamp1 = Number(data.readBigInt64LE(offset + 8));
      const param2 = Number(data.readBigUInt64LE(offset + 16));
      const timestamp2 = Number(data.readBigInt64LE(offset + 24));
      const param3 = Number(data.readBigUInt64LE(offset + 32));
      const timestamp3 = Number(data.readBigInt64LE(offset + 40));

      // Calculate median
      const values = [param1, param2, param3].sort((a, b) => a - b);
      const median = values[1];

      // Calculate age (use most recent timestamp)
      const maxTimestamp = Math.max(timestamp1, timestamp2, timestamp3);
      const now = Math.floor(Date.now() / 1000);
      const age = now - maxTimestamp;

      setOracleData({
        param1,
        param2,
        param3,
        timestamp1,
        timestamp2,
        timestamp3,
        median,
        age,
      });
      setLastUpdate(new Date());
      setError('');
    } catch (err: any) {
      console.error('Failed to fetch oracle data:', err);
      setError(`Failed to fetch: ${err.message}`);
    }
  };

  const formatPrice = (priceE6: number) => {
    return `$${(priceE6 / 1_000_000).toFixed(2)}`;
  };

  const formatTimestamp = (ts: number) => {
    return new Date(ts * 1000).toLocaleTimeString();
  };

  const getAgeStatus = (age: number) => {
    if (age < 30) return 'status-online';
    if (age < 90) return 'text-yellow-400';
    return 'text-red-500';
  };

  return (
    <div className="terminal-panel">
      <h2 className="terminal-panel-title">{'>'} ORACLE: BTC PRICE</h2>

      {error && (
        <div className="text-red-500 text-xs border border-red-500 p-2 mb-3">
          {error}
        </div>
      )}

      {oracleData ? (
        <div className="space-y-3">
          {/* Current Price */}
          <div className="border-2 border-terminal-bright p-4 text-center">
            <div className="text-xs text-terminal-dim mb-1">MEDIAN PRICE</div>
            <div className="text-3xl terminal-glow font-bold">
              {formatPrice(oracleData.median)}
            </div>
            <div className={`text-xs mt-2 ${getAgeStatus(oracleData.age)}`}>
              AGE: {oracleData.age}s
              {oracleData.age > 90 && ' ⚠ STALE'}
            </div>
          </div>

          {/* Triplet Data */}
          <div className="border border-terminal-dim p-3">
            <div className="text-xs text-terminal-bright mb-2">ORACLE TRIPLET</div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-terminal-dim">PRICE 1</div>
                <div>{formatPrice(oracleData.param1)}</div>
                <div className="text-terminal-dim text-[10px]">
                  {formatTimestamp(oracleData.timestamp1)}
                </div>
              </div>
              <div>
                <div className="text-terminal-dim">PRICE 2</div>
                <div>{formatPrice(oracleData.param2)}</div>
                <div className="text-terminal-dim text-[10px]">
                  {formatTimestamp(oracleData.timestamp2)}
                </div>
              </div>
              <div>
                <div className="text-terminal-dim">PRICE 3</div>
                <div>{formatPrice(oracleData.param3)}</div>
                <div className="text-terminal-dim text-[10px]">
                  {formatTimestamp(oracleData.timestamp3)}
                </div>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="text-xs text-terminal-dim text-center">
            LAST UPDATE: {lastUpdate.toLocaleTimeString()}
            <br />
            ORACLE: {ORACLE_STATE.toBase58().slice(0, 8)}...
          </div>
        </div>
      ) : (
        <div className="text-center py-6 text-terminal-dim">
          LOADING ORACLE DATA...
        </div>
      )}
    </div>
  );
}
