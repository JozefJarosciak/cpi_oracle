import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorWallet } from '@solana/wallet-adapter-react';
import idl from './idl.json';
import { PROGRAM_ID, AMM_SEED, VAULT_SEED, POSITION_SEED } from './constants';

export type CpiOracleProgram = Program<typeof idl>;

/**
 * Get the Anchor program instance
 */
export function getProgram(connection: Connection, wallet: AnchorWallet): CpiOracleProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  return new Program(idl as any, provider) as CpiOracleProgram;
}

/**
 * Find AMM PDA
 */
export function findAmmPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AMM_SEED)],
    PROGRAM_ID
  );
}

/**
 * Find Vault PDA
 */
export function findVaultPda(ammPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), ammPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Find Position PDA
 */
export function findPositionPda(ammPubkey: PublicKey, userPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(POSITION_SEED), ammPubkey.toBuffer(), userPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Convert lamports to E6 format
 */
export function lamportsToE6(lamports: number, lamportsPerE6: number): number {
  return Math.floor(lamports / lamportsPerE6);
}

/**
 * Convert E6 format to lamports
 */
export function e6ToLamports(e6: number, lamportsPerE6: number): number {
  return e6 * lamportsPerE6;
}

/**
 * Format E6 value to USD string
 */
export function formatE6ToUsd(e6Value: number): string {
  return `$${(e6Value / 1_000_000).toFixed(2)}`;
}

/**
 * Format E6 value to shares string
 */
export function formatE6ToShares(e6Value: number): string {
  return (e6Value / 1_000_000).toFixed(4);
}
