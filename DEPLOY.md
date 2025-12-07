# Vero Program Deployment Guide

## Program Information

| Field | Value |
|-------|-------|
| Program ID | `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF` |
| Upgrade Authority | `AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4` |
| Authority Keypair | `/home/ubuntu/.config/solana/id.json` |
| Source Code | `/home/ubuntu/dev/cpi_oracle/programs/cpi_oracle/src/lib.rs` |
| Build Output | `/home/ubuntu/dev/cpi_oracle/target/deploy/cpi_oracle.so` |

## Prerequisites

1. Ensure you have the upgrade authority keypair at `/home/ubuntu/.config/solana/id.json`
2. Verify the keypair matches the upgrade authority:
   ```bash
   solana-keygen pubkey /home/ubuntu/.config/solana/id.json
   # Should output: AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4
   ```

3. Ensure the authority has enough SOL for deployment (~5 SOL recommended):
   ```bash
   solana balance AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4 --url https://rpc.mainnet.x1.xyz
   ```

## Build Process

1. Navigate to the source directory:
   ```bash
   cd /home/ubuntu/dev/cpi_oracle
   ```

2. Build the program:
   ```bash
   anchor build
   ```

   Or using cargo directly:
   ```bash
   cargo build-bpf
   ```

3. Verify the build output exists:
   ```bash
   ls -la target/deploy/cpi_oracle.so
   ```

## Deployment

### Mainnet Deployment

```bash
cd /home/ubuntu/dev/cpi_oracle

solana program deploy target/deploy/cpi_oracle.so \
  --program-id EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF \
  --url https://rpc.mainnet.x1.xyz \
  --keypair /home/ubuntu/.config/solana/id.json
```

### Testnet Deployment

```bash
cd /home/ubuntu/dev/cpi_oracle

solana program deploy target/deploy/cpi_oracle.so \
  --program-id EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF \
  --url https://rpc.testnet.x1.xyz \
  --keypair /home/ubuntu/.config/solana/id.json
```

## Post-Deployment Verification

1. Verify the program was deployed:
   ```bash
   solana program show EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF --url https://rpc.mainnet.x1.xyz
   ```

2. Check the deployment slot and authority:
   ```
   Program Id: EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF
   Owner: BPFLoaderUpgradeab1e11111111111111111111111
   ProgramData Address: EWjN3XV1ojCTVh87rNV6Y5tes9KPwQ23Dnim81RBGN2Y
   Authority: AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4
   ```

3. Restart the PM2 services:
   ```bash
   pm2 restart 17  # mainnet-settlement-bot
   pm2 restart 28  # trade-manager
   ```

4. Test a buy order:
   ```bash
   cd /home/ubuntu/dev/cpi_oracle_mainnet
   timeout 35 bash -c 'WALLET=./app/bot.key node app/liquidity_bot.js --chance 100'
   ```

## Common Errors

### Wrong Authority Error

```
Error: Program's authority Some(AivknDqDUqnvyYVmDViiB2bEHKyUK5HcX91gWL2zgTZ4) does not match authority provided jqj117nAKqLepiFkxjAQob4p2ibfBnvJ943J3cryX55
```

**Cause:** Using the wrong keypair (e.g., `operator.json` instead of the upgrade authority keypair).

**Fix:** Use the correct keypair at `/home/ubuntu/.config/solana/id.json`

### WrongOwner / ConstraintOwner Error

```
Error Code: WrongOwner. Error Number: 6000. Error Message: oracle_state owned by wrong program.
Left: LuS6XnQ3qNXqNQvAJ3akXnEJRBv9XNoUricjMgTyCxX
Right: CcgTMiYkgVfz7cAGkD6835BqfycG5N5Y4aPPHYW1EvKx
```

**Cause:** The on-chain program has an outdated `ORACLE_PROGRAM_ID` constant.

**Fix:**
1. Update `ORACLE_PROGRAM_ID` in `lib.rs`
2. Rebuild the program
3. Redeploy with the correct keypair

## Key Files

| File | Purpose |
|------|---------|
| `/home/ubuntu/.config/solana/id.json` | Upgrade authority keypair (USE THIS FOR DEPLOYS) |
| `/home/ubuntu/dev/cpi_oracle_mainnet/operator.json` | Operator keypair (for market operations, NOT deploys) |
| `/home/ubuntu/dev/cpi_oracle_mainnet/app/bot.key` | Trading bot keypair |

## Current Configuration (as of Dec 2025)

| Setting | Value |
|---------|-------|
| Oracle Program | `CcgTMiYkgVfz7cAGkD6835BqfycG5N5Y4aPPHYW1EvKx` |
| Oracle State | `CqhjUyyiQ21GHFEPB99tyu1txumWG31vNaRxKTGYdEGy` |
| RPC (Mainnet) | `https://rpc.mainnet.x1.xyz` |
| RPC (Testnet) | `https://rpc.testnet.x1.xyz` |
