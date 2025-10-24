'use client';

import { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import {
  getOrCreateSessionAccount,
  loadSessionAccount,
  deleteSessionAccount,
  hasSessionAccount,
} from '@/lib/sessionAccount';
import { LAMPORTS_PER_E6, E6 } from '@/lib/constants';

export function SessionAccount() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [sessionExists, setSessionExists] = useState(false);
  const [sessionPubkey, setSessionPubkey] = useState<string>('');
  const [sessionBalance, setSessionBalance] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState<string>('1.0');
  const [withdrawAmount, setWithdrawAmount] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  // Check if session exists on mount
  useEffect(() => {
    const exists = hasSessionAccount();
    setSessionExists(exists);
    if (exists) {
      const session = loadSessionAccount();
      if (session) {
        setSessionPubkey(session.keypair.publicKey.toBase58());
        fetchBalance(session.keypair.publicKey.toBase58());
      }
    }
  }, []);

  // Poll balance
  useEffect(() => {
    if (!sessionPubkey) return;

    const interval = setInterval(() => {
      fetchBalance(sessionPubkey);
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionPubkey]);

  const fetchBalance = async (pubkey: string) => {
    try {
      const balance = await connection.getBalance(
        new (await import('@solana/web3.js')).PublicKey(pubkey)
      );
      setSessionBalance(balance);
    } catch (err) {
      console.error('Failed to fetch balance:', err);
    }
  };

  const handleCreateSession = () => {
    try {
      setError('');
      const session = getOrCreateSessionAccount();
      setSessionPubkey(session.keypair.publicKey.toBase58());
      setSessionExists(true);
      fetchBalance(session.keypair.publicKey.toBase58());
    } catch (err: any) {
      setError(`Failed to create session: ${err.message}`);
    }
  };

  const handleDeposit = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError('Wallet not connected');
      return;
    }

    if (!sessionPubkey) {
      setError('No session account');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const amount = parseFloat(depositAmount);
      if (isNaN(amount) || amount <= 0) {
        throw new Error('Invalid amount');
      }

      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      const { PublicKey } = await import('@solana/web3.js');

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(sessionPubkey),
          lamports,
        })
      );

      transaction.feePayer = wallet.publicKey;
      transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signed = await wallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(signature, 'confirmed');

      await fetchBalance(sessionPubkey);
      setDepositAmount('1.0');
    } catch (err: any) {
      setError(`Deposit failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!wallet.publicKey) {
      setError('Wallet not connected');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const session = loadSessionAccount();
      if (!session) {
        throw new Error('No session account loaded');
      }

      const amount = withdrawAmount === 'all'
        ? sessionBalance
        : Math.floor(parseFloat(withdrawAmount) * LAMPORTS_PER_SOL);

      if (isNaN(amount) || amount <= 0) {
        throw new Error('Invalid amount');
      }

      // Leave some lamports for rent
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const withdrawLamports = Math.min(amount, sessionBalance - rentExempt);

      if (withdrawLamports <= 0) {
        throw new Error('Insufficient balance');
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: session.keypair.publicKey,
          toPubkey: wallet.publicKey,
          lamports: withdrawLamports,
        })
      );

      transaction.feePayer = session.keypair.publicKey;
      transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      // Sign with session keypair
      transaction.sign(session.keypair);

      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature, 'confirmed');

      await fetchBalance(sessionPubkey);
      setWithdrawAmount('');
    } catch (err: any) {
      setError(`Withdraw failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSession = () => {
    if (confirm('Are you sure you want to delete this session? Withdraw all funds first!')) {
      deleteSessionAccount();
      setSessionExists(false);
      setSessionPubkey('');
      setSessionBalance(0);
    }
  };

  const formatBalance = (lamports: number) => {
    return (lamports / LAMPORTS_PER_SOL).toFixed(4);
  };

  return (
    <div className="terminal-panel">
      <h2 className="terminal-panel-title">{'>'} SESSION ACCOUNT</h2>

      {!sessionExists ? (
        <div className="text-center py-6">
          <p className="text-terminal-dim mb-4">NO SESSION ACCOUNT DETECTED</p>
          <button onClick={handleCreateSession} className="terminal-button">
            {'['} CREATE SESSION {']'}
          </button>
          <p className="text-xs text-terminal-dim mt-3">
            Session accounts allow gasless trading.<br />
            Keypair stored in browser only.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Session Info */}
          <div className="border border-terminal-dim p-3">
            <div className="text-xs mb-2">
              <span className="text-terminal-dim">ADDRESS:</span>
            </div>
            <div className="text-xs font-mono break-all mb-3">
              {sessionPubkey}
            </div>
            <div className="text-lg terminal-glow">
              BALANCE: {formatBalance(sessionBalance)} SOL
            </div>
            <div className="text-xs text-terminal-dim mt-1">
              ≈ {((sessionBalance / LAMPORTS_PER_SOL) * (LAMPORTS_PER_E6 / E6)).toFixed(2)} USD
            </div>
          </div>

          {/* Deposit */}
          <div className="border border-terminal-dim p-3">
            <div className="text-terminal-bright mb-2">{'>'} DEPOSIT SOL</div>
            <div className="flex gap-2">
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="Amount (SOL)"
                className="terminal-input flex-1"
                step="0.1"
                min="0"
              />
              <button
                onClick={handleDeposit}
                disabled={loading}
                className="terminal-button whitespace-nowrap"
              >
                {loading ? 'SENDING...' : '['} DEPOSIT {']'}
              </button>
            </div>
          </div>

          {/* Withdraw */}
          <div className="border border-terminal-dim p-3">
            <div className="text-terminal-bright mb-2">{'>'} WITHDRAW SOL</div>
            <div className="flex gap-2 mb-2">
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Amount (SOL)"
                className="terminal-input flex-1"
                step="0.1"
                min="0"
              />
              <button
                onClick={handleWithdraw}
                disabled={loading || !withdrawAmount}
                className="terminal-button whitespace-nowrap"
              >
                {loading ? 'SENDING...' : '['} WITHDRAW {']'}
              </button>
            </div>
            <button
              onClick={() => setWithdrawAmount('all')}
              className="terminal-button w-full text-xs"
            >
              {'['} WITHDRAW ALL {']'}
            </button>
          </div>

          {/* Delete Session */}
          <button
            onClick={handleDeleteSession}
            className="terminal-button w-full text-xs border-terminal-dim hover:border-red-500 hover:text-red-500"
          >
            {'['} DELETE SESSION {']'}
          </button>

          {error && (
            <div className="text-red-500 text-xs border border-red-500 p-2">
              ERROR: {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
