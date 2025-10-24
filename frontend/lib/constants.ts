import { PublicKey } from '@solana/web3.js';

// Program IDs
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF'
);

export const ORACLE_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ORACLE_PROGRAM_ID || '7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE'
);

// Oracle State (configurable)
export const ORACLE_STATE = new PublicKey(
  process.env.NEXT_PUBLIC_ORACLE_STATE || '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq'
);

// Seeds
export const AMM_SEED = process.env.NEXT_PUBLIC_AMM_SEED || 'amm_btc_v3';
export const VAULT_SEED = 'vault_sol';
export const POSITION_SEED = 'pos';

// Conversion
export const LAMPORTS_PER_E6 = Number(process.env.NEXT_PUBLIC_LAMPORTS_PER_E6 || '100');
export const E6 = 1_000_000;

// Trade limits (from lib.rs)
export const MIN_BUY_E6 = 100_000; // $0.10
export const MIN_SELL_E6 = 100_000; // 0.1 shares
export const MAX_SPEND_E6 = 50_000_000_000; // $50k
export const MAX_SHARES_E6 = 50_000_000_000; // 50M shares

// Vault
export const MIN_VAULT_LAMPORTS = 1_000_000_000; // 1 SOL

// Session Storage Keys
export const SESSION_KEYPAIR_KEY = 'btc_market_session_keypair';
export const SESSION_CREATED_KEY = 'btc_market_session_created';
