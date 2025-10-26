# Unredeemed Winnings - Current Behavior & Solutions

## ⚠️ Current Issue

**When users don't redeem their winnings before the market closes, those funds become PERMANENTLY LOCKED.**

### Why This Happens

1. **The `redeem` instruction requires user signature** (lib.rs:228)
   - The user must personally sign the transaction to redeem
   - The bot/admin cannot redeem on behalf of users without their private keys
   - This is intentional for security - prevents unauthorized draining of positions

2. **The `close_amm` instruction doesn't handle vault funds** (lib.rs:656)
   - Only closes the AMM state account
   - The `vault_sol` PDA remains with locked funds inside
   - No admin function exists to sweep the vault

3. **Position PDAs become orphaned**
   - Position accounts are derived from: `[b"pos", amm.key(), user.key()]`
   - Once AMM is closed, positions cannot be redeemed (requires AMM account)
   - Vault funds remain stuck in the PDA

### Current Workaround

The `init_amm` function (lib.rs:361-383) sweeps leftover vault funds to `fee_dest`:

```rust
// If vault already has lamports from a prior run, sweep to fee_dest
if vault_ai.lamports() > 0 {
    let bal = vault_ai.lamports();
    // ... transfers to fee_dest
}
```

**This means:**
- Unredeemed funds are recovered when you initialize the NEXT market
- But you must create a new market to access them
- Not ideal for continuous operation

---

## ✅ Recommended Solutions

### Solution 1: Add Permissionless Admin Redeem (Smart Contract Change)

Add a new instruction that allows the fee_dest to force-redeem positions after settlement:

```rust
pub fn admin_redeem(ctx: Context<AdminRedeem>, user_pubkey: Pubkey) -> Result<()> {
    // Only fee_dest can call this
    require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.amm.fee_dest);

    // Market must be settled
    require!(ctx.accounts.amm.status() == MarketStatus::Settled);

    // Redeem logic (pay to user, not admin)
    // ... same payout calculation as regular redeem
    // ... transfer from vault to user
    // ... wipe position
}
```

**Pros:**
- Protects users - admin can force payout but funds still go to rightful owner
- Prevents locked funds
- Settlement bot can auto-redeem all positions

**Cons:**
- Requires contract redeployment
- Gas costs paid by admin/bot

### Solution 2: Extend Redemption Period (Current System)

Keep the market open longer before closing:

```javascript
// In settlement_bot.js
const WAIT_FOR_REDEMPTIONS = 2 * 60 * 1000; // 2 minutes

await settleMarket(conn, kp, ammPda);
log("Market settled - waiting for users to redeem...");
await new Promise(r => setTimeout(r, WAIT_FOR_REDEMPTIONS));
// Then close_amm
```

**Pros:**
- No contract changes needed
- Works with current code

**Cons:**
- Users who forget still lose funds
- Delays next market cycle
- Doesn't solve the problem, just mitigates it

### Solution 3: Don't Close Markets (Recommended for Now)

Simply don't call `close_amm` - leave settled markets open:

```javascript
// In settlement_bot.js runCycle()
// Step 1: Check if market exists
const ammInfo = await conn.getAccountInfo(ammPda);
if (ammInfo) {
    const marketData = await readMarketData(conn, ammPda);

    // Only close if settled (allows late redemptions)
    if (marketData && marketData.status === 2) {
        log("Previous market is settled - reinitializing...");
        // Note: init_amm will sweep vault automatically
    }
}

// Step 2: Always init (sweeps vault if needed)
await initMarket(conn, kp, ammPda, vaultPda);
```

**Pros:**
- Users can redeem anytime before next market starts
- No contract changes needed
- Vault sweep happens automatically on next init

**Cons:**
- Slightly more complex bot logic
- Need to handle AMM account already existing

### Solution 4: Client-Side Notification

Add a visual warning in the web UI:

```javascript
// In app.js
if (currentMarketStatus === 2) { // Settled
    showBigWarning("⚠️ MARKET SETTLED - REDEEM NOW OR LOSE WINNINGS!");
    // Show countdown to next market
    // Disable trading buttons
    // Highlight redeem button
}
```

**Pros:**
- Easy to implement
- Educates users

**Cons:**
- Doesn't prevent the problem
- Users might not see it

---

## 📊 Implementation Status

### Currently Implemented
- ✅ Redeem functionality works (requires user signature)
- ✅ Web UI shows redeemable amounts
- ✅ Vault sweep on init (recovers funds from previous market)

### Not Yet Implemented
- ❌ Admin force-redeem function
- ❌ Extended redemption period in settlement bot
- ❌ Visual warning in UI
- ❌ Proper vault closure in close_amm

---

## 🔧 Immediate Action Items

For the current deployment, recommend:

1. **Keep settlement_bot as-is** - it settles markets correctly
2. **Don't manually close markets** - let init_amm handle cleanup
3. **Add UI warning** - show big red banner when market is settled
4. **Document for users** - explain redemption deadline clearly

For production deployment:

1. **Add `admin_redeem` to smart contract**
2. **Modify settlement_bot to auto-redeem all positions**
3. **Add vault sweep to `close_amm` instruction**
4. **Implement countdown timers in UI**

---

## 💡 Technical Details

### Position Data Structure
```rust
pub struct Position {
    pub owner: Pubkey,        // 32 bytes
    pub yes_shares_e6: i64,   // 8 bytes
    pub no_shares_e6: i64,    // 8 bytes
}
// Total: 48 bytes + 8 byte discriminator = 56 bytes
```

### Finding All Positions
```javascript
const positions = await conn.getProgramAccounts(PID, {
    filters: [{ dataSize: 8 + 32 + 8 + 8 }], // Position account size
});
```

### Redeem Instruction Accounts
```rust
#[account(mut)] pub amm: Account<'info, Amm>,
#[account(mut)] pub user: Signer<'info>,  // <-- REQUIRES SIGNATURE
#[account(mut)] pub pos: Account<'info, Position>,
#[account(mut)] pub fee_dest: UncheckedAccount<'info>,
#[account(mut)] pub vault_sol: UncheckedAccount<'info>,
pub system_program: Program<'info, System>,
```

---

## 🎯 Conclusion

The **best immediate solution** is **Solution 3** (don't close markets manually), combined with **Solution 4** (UI warnings).

The **best long-term solution** is **Solution 1** (add admin_redeem to contract) so the settlement bot can automatically pay out all users.

Until the contract is updated, users **MUST redeem before the next market starts**, or their funds are swept to `fee_dest` (effectively lost to users, recovered by protocol).
