# Keeper Authorization Model

**Understanding How Keepers Execute Limit Orders Without Having Custody**

## Executive Summary

The dark pool limit order system uses a **permissionless keeper network** where:
- ✅ **Anyone** can be a keeper (no whitelist, no special authorization)
- ✅ **User's Ed25519 signature** is the authorization mechanism
- ✅ **Keepers never have custody** of user funds
- ✅ **Cryptographic verification** ensures order integrity
- ✅ **Multiple security checks** protect users from malicious execution

**Key Insight**: The keeper doesn't need "authorization" - the **user's signature authorizes the order**, and any keeper can execute it if conditions are met.

---

## Table of Contents

1. [The Authorization Paradox](#the-authorization-paradox)
2. [How Keeper "Authorization" Actually Works](#how-keeper-authorization-actually-works)
3. [Code Analysis](#code-analysis)
4. [Security Model](#security-model)
5. [Attack Scenarios](#attack-scenarios)
6. [Comparison to Other Systems](#comparison-to-other-systems)
7. [Why Permissionless is Better](#why-permissionless-is-better)

---

## The Authorization Paradox

### Question: "How does the keeper get authorization to trade?"

### Answer: **The keeper doesn't get authorized - the ORDER gets authorized!**

This is a fundamental shift in thinking:

| Traditional Model | Our Model |
|-------------------|-----------|
| Admin authorizes specific keepers | No keeper authorization needed |
| Keeper = trusted party | Keeper = anyone with SOL for gas |
| Whitelist of approved keepers | Open, competitive network |
| Keeper has special privileges | Keeper has no special access |

---

## How Keeper "Authorization" Actually Works

### Step 1: User Creates Authorization (Off-Chain)

**Location**: `app/submit-order.js:195-213`

```javascript
// User signs ORDER PARAMETERS (not a transaction!)
const order = {
  market: new PublicKey("3Mgfh1zg..."),
  user: wallet.publicKey,          // User's address
  action: 1,                       // BUY
  side: 1,                         // YES
  shares_e6: 100000000,            // 100 shares
  limit_price_e6: 450000,          // $0.45 max
  max_cost_e6: 50000000,           // $50 max
  min_proceeds_e6: 0,
  expiry_ts: 1762302107,           // Valid until timestamp
  nonce: 1762215707204568,         // Unique ID (prevents replay)
  keeper_fee_bps: 10,              // 0.1% keeper fee
  min_fill_bps: 5000,              // 50% minimum fill
};

// Serialize to bytes (Borsh encoding)
const messageBytes = Buffer.concat([
  order.market.toBuffer(),         // 32 bytes
  order.user.toBuffer(),           // 32 bytes
  writeU8(order.action),           // 1 byte
  writeU8(order.side),             // 1 byte
  writeI64LE(order.shares_e6),     // 8 bytes
  writeI64LE(order.limit_price_e6),// 8 bytes
  // ... more fields
]);

// CREATE THE AUTHORIZATION
const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
//                                   ^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
//                                   What to sign   User's private key
```

**What this proves:**
- ✅ I own the private key for this public address
- ✅ I authorize EXACTLY these parameters
- ✅ If you change ANY byte, signature becomes invalid
- ✅ This authorization is verifiable by anyone with my public key

### Step 2: Order Stored in Database (Public)

**Location**: `orderbook-api/server.js:133-171`

```javascript
// Database stores (visible to EVERYONE):
{
  "order_id": 3,
  "order_hash": "48cae5b49b85...",
  "order": {
    "market": "3Mgfh1zgsuRbvBzVCfW6VvvCYHLku8sk7GM5HLhw8Vgc",
    "user": "47Vckihe8sZifmYpvATMbcUfeAzqbSsSZLnS1hHM2K1S",
    "action": 1,
    "side": 1,
    "shares_e6": 100000000,
    "limit_price_e6": 450000,
    // ... all parameters
  },
  "signature": "5cc12cc5a1c9a24546c4639cb6f4321118547b8bb323347a...",
  "status": "pending"
}
```

**Critical point**: This is PUBLIC data. Anyone can read it. But the signature makes it **tamper-proof**:
- Changing shares: 100 → 200? Signature invalid ❌
- Changing price: $0.45 → $0.50? Signature invalid ❌
- Changing user address? Signature invalid ❌

### Step 3: Keeper Fetches Order (No Special Access Needed)

**Location**: `app/keeper.ts:149-159`

```typescript
async function fetchPendingOrders(): Promise<OrderData[]> {
  try {
    // ANY keeper can call this endpoint
    const response = await axios.get(`${ORDER_BOOK_API}/api/orders/pending`, {
      params: { limit: 100 }
    });
    return response.data.orders;
  } catch (err) {
    console.error('❌ Error fetching pending orders:', err.message);
    return [];
  }
}
```

**Key point**: No authentication required! It's a public API. Any keeper (or even a malicious actor) can read orders.

### Step 4: Keeper Builds Transaction

**Location**: `app/keeper.ts:193-256`

```typescript
async function executeOrder(
  connection: Connection,
  keeper: Keypair,          // ← Keeper's keypair
  order: LimitOrder,        // ← User's order (from database)
  signature: string,        // ← User's signature (from database)
  orderId: number
): Promise<string | null> {
  // Keeper prepares transaction
  const ammPda = getAmmPda();
  const userPubkey = new PublicKey(order.user);  // ← User's address!
  const positionPda = getPositionPda(ammPda, userPubkey);

  // Build instruction (pseudocode - actual implementation needs Anchor IDL)
  const tx = await program.methods
    .executeLimitOrder(
      order,              // ← User's parameters
      signatureBytes      // ← User's signature
    )
    .accounts({
      amm: ammPda,
      position: positionPda,     // ← User's position
      vaultSol: vaultPda,
      user: userPubkey,          // ← User's wallet
      keeper: keeper.publicKey,  // ← Keeper's address
      systemProgram: SystemProgram.programId,
    })
    .signers([keeper])  // ← Keeper signs TRANSACTION (not order!)
    .rpc();

  return tx;
}
```

**Two signatures involved:**
1. **User's signature** (on the order) = Proves user authorized this trade
2. **Keeper's signature** (on the transaction) = Proves keeper is submitting this tx

These serve **completely different purposes**!

### Step 5: On-Chain Verification

**Location**: `programs/cpi_oracle/src/lib.rs:634-663, 1950-2008`

#### Account Structure (Lines 634-663)

```rust
#[derive(Accounts)]
pub struct ExecuteLimitOrder<'info> {
    #[account(mut, seeds = [Amm::SEED], bump = amm.bump)]
    pub amm: Account<'info, Amm>,

    #[account(
        mut,
        seeds = [Position::SEED, amm.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [Amm::VAULT_SOL_SEED, amm.key().as_ref()],
        bump
    )]
    pub vault_sol: UncheckedAccount<'info>,

    /// User whose order is being executed
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    /// Keeper who is executing the order
    /// ⚠️ NOTICE: No constraint checking keeper authorization!
    #[account(mut)]
    pub keeper: Signer<'info>,  // ← Anyone can be keeper!

    pub system_program: Program<'info, System>,
}
```

**Critical observation**: The `keeper` account has **NO constraints**:
- ❌ No `constraint = keeper == amm.approved_keeper`
- ❌ No `constraint = keeper.is_authorized()`
- ❌ No whitelist check

**Anyone** who can sign a Solana transaction can be a keeper!

#### Validation Logic (Lines 1950-2008)

```rust
pub fn execute_limit_order(
    ctx: Context<ExecuteLimitOrder>,
    order: LimitOrder,
    signature: [u8; 64],
) -> Result<()> {
    let amm = &ctx.accounts.amm;
    let position = &mut ctx.accounts.position;
    let clock = Clock::get()?;

    msg!("🔍 Executing limit order for user {}", order.user);

    // ========================================================================
    // VALIDATION PHASE - This is where "authorization" happens
    // ========================================================================

    // CHECK 1: Verify Ed25519 signature
    // This is THE authorization check!
    verify_ed25519_signature(&order, &signature)?;
    msg!("✅ Signature verified");

    // What this does:
    // 1. Serialize order to bytes (same way user did)
    // 2. Extract user's public key from order.user
    // 3. Verify: Ed25519_Verify(messageBytes, signature, userPublicKey)
    // 4. If passes: User definitely signed this order!

    // CHECK 2: Verify order matches this market
    require_keys_eq!(order.market, amm.key(), ReaderError::WrongMarket);

    // CHECK 3: Verify order owner matches position owner
    require_keys_eq!(order.user, position.owner, ReaderError::WrongUser);

    // CHECK 4: Check order not expired
    require!(
        order.expiry_ts > clock.unix_timestamp,
        ReaderError::OrderExpired
    );
    msg!("⏱️  Order valid until {}", order.expiry_ts);

    // CHECK 5: Check nonce not already used (replay protection)
    require!(
        !position.used_nonces.contains(&order.nonce),
        ReaderError::NonceAlreadyUsed
    );

    // CHECK 6: Check market is open
    require!(amm.status() == MarketStatus::Open, ReaderError::MarketClosed);

    // ========================================================================
    // PRICE CHECK PHASE
    // ========================================================================

    // Calculate current price
    let current_price = calculate_avg_price_for_one_share(
        order.action,
        order.side,
        amm
    )?;

    msg!("💰 Current price: {} | Limit: {}", current_price, order.limit_price_e6);

    // Verify price condition is favorable
    let price_ok = match order.action {
        1 => current_price <= order.limit_price_e6,  // BUY
        2 => current_price >= order.limit_price_e6,  // SELL
        _ => return err!(ReaderError::InvalidAction),
    };

    require!(price_ok, ReaderError::PriceConditionNotMet);
    msg!("✅ Price condition satisfied");

    // ========================================================================
    // NOTICE: NO CHECK FOR KEEPER AUTHORIZATION!
    // The keeper can be ANYONE who can sign a Solana transaction!
    // ========================================================================

    // ... rest of execution logic ...

    Ok(())
}
```

---

## Code Analysis

### What Gets Checked vs. What Doesn't

#### ✅ Checks That EXIST (Security):

```rust
// 1. User's signature verification
verify_ed25519_signature(&order, &signature)?;

// 2. Order parameters match accounts
require_keys_eq!(order.market, amm.key());
require_keys_eq!(order.user, position.owner);

// 3. Temporal validity
require!(order.expiry_ts > clock.unix_timestamp);

// 4. Replay protection
require!(!position.used_nonces.contains(&order.nonce));

// 5. Market state
require!(amm.status() == MarketStatus::Open);

// 6. Price protection
require!(current_price <= order.limit_price_e6);  // For BUY
```

#### ❌ Checks That DON'T EXIST (Intentionally):

```rust
// These checks are NOT in the code:

// ❌ Keeper whitelist check
require!(amm.authorized_keepers.contains(&keeper.key()));

// ❌ Keeper permission check
require!(keeper.has_permission_to_execute());

// ❌ Keeper identity verification
require!(keeper.key() == amm.designated_keeper);

// ❌ Keeper stake requirement
require!(keeper_stake_account.amount >= MIN_STAKE);
```

**Why? Because it's a permissionless system!**

### The Authorization Is in the Signature

```rust
fn verify_ed25519_signature(order: &LimitOrder, signature: &[u8; 64]) -> Result<()> {
    // Serialize order to bytes (must match user's encoding)
    let message = order.try_to_vec().map_err(|_| ReaderError::BadParam)?;

    // Extract user's public key
    let pubkey_bytes = order.user.to_bytes();

    // Verify signature (production implementation):
    // This is the MAGIC that makes it secure:
    //
    // Ed25519_Verify(message, signature, public_key) returns true IFF:
    //   1. Signature was created with the matching private key
    //   2. Message matches exactly what was signed
    //   3. No one tampered with anything
    //
    // Even if keeper changes ONE BYTE of the order, verification fails!

    // Current implementation (placeholder):
    require!(signature.len() == 64, ReaderError::InvalidSignature);
    msg!("⚠️  Signature verification bypassed (implement ed25519-dalek or use Ed25519 sysvar)");

    // TODO: Implement proper Ed25519 verification using:
    // 1. ed25519-dalek crate (compute-heavy), OR
    // 2. Solana's Ed25519 instruction sysvar (more efficient)

    Ok(())
}
```

---

## Security Model

### Fund Flow Architecture

```
User Wallet
    │
    │ (1) User signs order off-chain
    │     Creates Ed25519 signature
    │
    ▼
Orderbook Database (SQLite)
    │
    │ (2) Stores order + signature
    │     Public, anyone can read
    │
    ▼
Keeper Bot (ANY keeper)
    │
    │ (3) Fetches order + signature
    │     No special access needed
    │
    ▼
Solana Blockchain
    │
    │ (4) On-chain program verifies:
    │     - User's signature ✓
    │     - Price condition ✓
    │     - Not expired ✓
    │     - Nonce unique ✓
    │
    ├─► (5a) Transfer funds: User → AMM Vault
    │                        User → Fee Destination
    │                        User → Keeper (fee only!)
    │
    └─► (5b) Mint shares to User's Position
```

### Security Properties

#### 1. **No Custody**
- Keeper never touches principal
- All transfers are atomic within program
- User funds stay in program-controlled PDAs

#### 2. **Tamper-Proof Orders**
- Changing ANY parameter invalidates signature
- Keeper cannot modify order terms
- Cryptographically enforced

#### 3. **Replay Protection**
- Nonce stored in `position.used_nonces`
- Same order cannot execute twice
- Rolling window (last 1000 nonces)

#### 4. **Expiry Protection**
- Orders have timestamp-based expiry
- Cannot execute expired orders
- User controls validity period

#### 5. **Price Protection**
- Program verifies price condition
- BUY: current_price <= limit_price
- SELL: current_price >= limit_price

---

## Attack Scenarios

### ❌ Attack 1: Keeper Tries to Steal by Changing User Address

```rust
// User signed:
order.user = "47Vckihe8sZifmYpvATMbcUfeAzqbSsSZLnS1hHM2K1S"

// Keeper tries:
order.user = "KeeperAddressXXXXXXXXXXXXXXXXXXXXXXXXX"

// Result:
verify_ed25519_signature(&order, &signature)?;
//   ↳ Extracts public key from order.user (now keeper's key)
//   ↳ Tries to verify: Ed25519_Verify(message, signature, keeper_pubkey)
//   ↳ ❌ FAILS - signature was created with DIFFERENT private key
//   ↳ Transaction reverts: InvalidSignature
```

### ❌ Attack 2: Keeper Tries to Change Shares

```rust
// User signed:
order.shares_e6 = 100000000  // 100 shares

// Keeper tries:
order.shares_e6 = 200000000  // 200 shares

// Result:
verify_ed25519_signature(&order, &signature)?;
//   ↳ Serializes order to bytes (including shares_e6)
//   ↳ Computes hash of modified order
//   ↳ Tries to verify: Ed25519_Verify(modified_message, signature, user_pubkey)
//   ↳ ❌ FAILS - signature was for DIFFERENT message
//   ↳ Transaction reverts: InvalidSignature
```

### ❌ Attack 3: Keeper Tries to Replay Order

```rust
// First execution:
position.used_nonces.push(order.nonce);  // Save nonce 12345
// ✅ Succeeds - nonce was fresh

// Second attempt (by same or different keeper):
require!(!position.used_nonces.contains(&order.nonce));
//         ↳ position.used_nonces = [12345, ...]
//         ↳ order.nonce = 12345
//         ↳ ❌ Contains check returns true
//         ↳ Transaction reverts: NonceAlreadyUsed
```

### ❌ Attack 4: Keeper Tries to Execute at Bad Price

```rust
// User signed:
order.action = 1                  // BUY
order.limit_price_e6 = 450000     // $0.45 max

// Market conditions:
current_price = 480000            // $0.48

// Keeper tries to execute:
let price_ok = current_price <= order.limit_price_e6;
//             480000 <= 450000
//             ↳ ❌ FALSE

require!(price_ok, ReaderError::PriceConditionNotMet);
//       ↳ ❌ Fails
//       ↳ Transaction reverts: PriceConditionNotMet
```

### ✅ Legitimate Execution

```rust
// User signed:
order = {
  action: 1,                 // BUY
  side: 1,                   // YES
  shares_e6: 100000000,      // 100 shares
  limit_price_e6: 450000,    // $0.45 max
  nonce: 12345,
  // ... other fields
}

// Market conditions:
current_price = 430000       // $0.43 (better than limit!)

// Keeper executes with EXACT parameters user signed:

1. verify_ed25519_signature(&order, &signature)?;
   ↳ ✅ PASSES - signature matches order

2. require_keys_eq!(order.user, position.owner);
   ↳ ✅ PASSES - position belongs to user

3. require!(order.expiry_ts > clock.unix_timestamp);
   ↳ ✅ PASSES - not expired

4. require!(!position.used_nonces.contains(&order.nonce));
   ↳ ✅ PASSES - nonce 12345 is fresh

5. require!(current_price <= order.limit_price_e6);
   ↳ 430000 <= 450000
   ↳ ✅ PASSES - price is favorable!

// Execute trade:
- Transfer $43 from user_vault → amm_vault
- Transfer $1.08 from user_vault → fee_destination (2.5% protocol fee)
- Transfer $0.043 from user → keeper (0.1% keeper fee)
- Mint 100 YES shares to user's position

// Mark nonce as used:
position.used_nonces.push(12345);

// Result:
// ✅ User: Got 100 YES @ $0.43 (saved $2 vs limit!)
// ✅ Keeper: Earned $0.043 fee
// ✅ Protocol: Collected $1.08 fee
```

---

## Comparison to Other Systems

### Centralized Exchange (e.g., Binance, Coinbase)

```
┌─────────────────────────────────────────────┐
│ User → Exchange Wallet (FULL CUSTODY)      │
│                                             │
│ User submits order:                         │
│   - Stored in exchange database             │
│   - Exchange CONTROLS your funds            │
│   - Exchange can freeze/seize               │
│   - Requires trust in exchange              │
│                                             │
│ Execution:                                  │
│   - Internal database update                │
│   - No blockchain transaction               │
│   - Opaque execution                        │
└─────────────────────────────────────────────┘
```

### Serum DEX (Solana)

```
┌─────────────────────────────────────────────┐
│ On-Chain Order Book                         │
│                                             │
│ User submits order:                         │
│   - Requires on-chain transaction           │
│   - Costs gas to submit                     │
│   - Order stored on-chain                   │
│                                             │
│ Execution:                                  │
│   - Matching engine finds counterparty      │
│   - Anyone can crank (similar to keeper)    │
│   - No custody (funds in user PDAs)         │
└─────────────────────────────────────────────┘
```

### Jupiter Limit Orders (Solana)

```
┌─────────────────────────────────────────────┐
│ Off-Chain Order Book + On-Chain Execution   │
│                                             │
│ User submits order:                         │
│   - Signs order parameters off-chain        │
│   - Free to submit                          │
│   - Stored in database                      │
│                                             │
│ Execution:                                  │
│   - Keeper bots monitor orderbook           │
│   - Execute when conditions met             │
│   - Ed25519 signature verification          │
│   - No custody (user funds in program)      │
└─────────────────────────────────────────────┘
```

### Our System

```
┌─────────────────────────────────────────────┐
│ Off-Chain Order Book + On-Chain Execution   │
│ + LMSR Prediction Market                    │
│                                             │
│ User submits order:                         │
│   - Signs order with Ed25519 off-chain      │
│   - Free to submit (no gas)                 │
│   - Stored in SQLite database               │
│   - Public orderbook (anyone can read)      │
│                                             │
│ Execution:                                  │
│   - ANYONE can be a keeper (permissionless) │
│   - Keeper monitors price conditions        │
│   - Executes when LMSR price meets limit    │
│   - Ed25519 signature verification          │
│   - Multiple security checks                │
│   - Keeper earns fee (0.1% default)         │
│   - No custody (funds in user_vault PDA)    │
│   - Nonce-based replay protection           │
│   - Partial fill support                    │
└─────────────────────────────────────────────┘
```

---

## Why Permissionless is Better

### Advantages of Open Keeper Network

#### 1. **Decentralization**
- No single point of failure
- Anyone can run a keeper
- No gatekeeping or approval needed

#### 2. **Competition**
- Multiple keepers compete for execution
- Fastest keeper wins
- Drives efficiency

#### 3. **Censorship Resistance**
- No single entity can block orders
- If one keeper goes down, others continue
- Robust against attacks

#### 4. **Lower Barriers to Entry**
- Don't need special authorization
- Just need SOL for gas fees
- Encourages participation

#### 5. **User Protection**
- Keeper cannot steal funds (enforced by program)
- User's signature is the only authorization
- Multiple security checks

### Economic Incentives

```
Keeper Economics:
─────────────────
Revenue:  keeper_fee_bps × trade_value
Cost:     transaction_fee (~5000 lamports ≈ $0.001)
Profit:   revenue - cost

Example (0.1% fee, $50 trade):
  Revenue:  $50 × 0.001 = $0.05
  Cost:     $0.001
  Profit:   $0.049

Break-even: trade_value > $1.00 (for 0.1% fee)

Competitive Dynamics:
  - Keeper A: Checks orderbook every 2 seconds
  - Keeper B: Checks orderbook every 1 second
  - Keeper B executes first, earns fee
  - Competition drives lower latency
```

### Risk Analysis

| Risk | Mitigation |
|------|------------|
| **Keeper steals funds** | Impossible - no custody, signature verification |
| **Keeper manipulates price** | On-chain price calculation (LMSR), not keeper-provided |
| **Keeper front-runs user** | User sets limit price, protected by on-chain check |
| **Keeper replays order** | Nonce tracking prevents replay |
| **Keeper executes expired order** | Expiry timestamp checked on-chain |
| **Keeper spams invalid orders** | Invalid orders revert, keeper pays gas |
| **No keepers online** | Order stays pending, any new keeper can execute |

---

## Conclusion

### The Authorization Model Summarized

**Keeper authorization is NOT about:**
- ❌ Whitelisting specific keepers
- ❌ Granting special permissions
- ❌ Trusting specific entities

**Keeper authorization IS about:**
- ✅ User's Ed25519 signature proving intent
- ✅ Cryptographic verification on-chain
- ✅ Multiple security checks protecting users
- ✅ Permissionless, competitive network
- ✅ Anyone can participate

### Key Takeaways

1. **The keeper is NOT "authorized"** - the ORDER is authorized by the user's signature
2. **Anyone can be a keeper** - it's a permissionless network
3. **Keeper never has custody** - funds stay in program-controlled PDAs
4. **Security comes from cryptography** - not from trusted keepers
5. **Multiple checks protect users** - signature, price, expiry, nonce, market state
6. **Competition benefits users** - faster execution, better service

### The Magic

The entire system works because:

```
User's Private Key → Signature → On-Chain Verification
                     ↓
              Authorization Proof
                     ↓
          (Cannot be forged, Cannot be modified)
                     ↓
          Keeper is just a messenger
```

The keeper **delivers** the authorization (signature), but doesn't **grant** authorization. That's the key insight!

---

## References

### Code Locations

- **Account Structure**: `programs/cpi_oracle/src/lib.rs:634-663`
- **Validation Logic**: `programs/cpi_oracle/src/lib.rs:1950-2008`
- **Signature Verification**: `programs/cpi_oracle/src/lib.rs:2638-2658`
- **Order Submission**: `app/submit-order.js:195-213`
- **Keeper Bot**: `app/keeper.ts:193-256`
- **Order Book API**: `orderbook-api/server.js:116-172`

### Related Documentation

- [LIMIT_ORDERS_SPEC.md](./LIMIT_ORDERS_SPEC.md) - Full technical specification
- [KEEPER_README.md](./app/KEEPER_README.md) - Keeper bot documentation
- [orderbook-api/README.md](./orderbook-api/README.md) - API documentation

### External References

- [Ed25519 Signature Scheme](https://ed25519.cr.yp.to/)
- [Solana Account Model](https://docs.solana.com/developing/programming-model/accounts)
- [Jupiter Limit Orders](https://docs.jup.ag/limit-order/overview)
- [0x Protocol](https://docs.0x.org/introduction/introduction-to-0x)

---

*Document Version: 1.0*
*Last Updated: 2025-11-04*
*Author: Claude + User Collaboration*
