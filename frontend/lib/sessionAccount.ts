import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SESSION_KEYPAIR_KEY, SESSION_CREATED_KEY } from './constants';

export interface SessionAccountData {
  keypair: Keypair;
  createdAt: number;
}

/**
 * Generate a new session keypair and store it in browser storage
 */
export function createSessionAccount(): SessionAccountData {
  const keypair = Keypair.generate();
  const secretKey = bs58.encode(keypair.secretKey);

  const sessionData = {
    secretKey,
    publicKey: keypair.publicKey.toBase58(),
    createdAt: Date.now(),
  };

  if (typeof window !== 'undefined') {
    localStorage.setItem(SESSION_KEYPAIR_KEY, JSON.stringify(sessionData));
    localStorage.setItem(SESSION_CREATED_KEY, sessionData.createdAt.toString());
  }

  return {
    keypair,
    createdAt: sessionData.createdAt,
  };
}

/**
 * Load existing session keypair from browser storage
 */
export function loadSessionAccount(): SessionAccountData | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = localStorage.getItem(SESSION_KEYPAIR_KEY);
  if (!stored) {
    return null;
  }

  try {
    const sessionData = JSON.parse(stored);
    const secretKey = bs58.decode(sessionData.secretKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    return {
      keypair,
      createdAt: sessionData.createdAt,
    };
  } catch (error) {
    console.error('Failed to load session account:', error);
    return null;
  }
}

/**
 * Get the current session account, or create a new one if none exists
 */
export function getOrCreateSessionAccount(): SessionAccountData {
  const existing = loadSessionAccount();
  if (existing) {
    return existing;
  }
  return createSessionAccount();
}

/**
 * Delete the session account from storage
 */
export function deleteSessionAccount(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SESSION_KEYPAIR_KEY);
    localStorage.removeItem(SESSION_CREATED_KEY);
  }
}

/**
 * Check if a session account exists
 */
export function hasSessionAccount(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return localStorage.getItem(SESSION_KEYPAIR_KEY) !== null;
}
