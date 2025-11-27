# Network Configuration

## Testnet

| Resource | Address |
|----------|---------|
| RPC URL | `https://rpc.testnet.x1.xyz` |
| Program ID | `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF` |
| Oracle Program | `7ARBeYF5rGCanAGiRaxhVpiuZZpGXazo5UJqHMoJgkuE` |
| Oracle State | `4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq` |
| AMM Seed | `amm_btc_v6` |

## Mainnet

| Resource | Address |
|----------|---------|
| RPC URL | `https://rpc.mainnet.x1.xyz` |
| Program ID | `EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF` |
| Oracle Program | `LuS6XnQ3qNXqNQvAJ3akXnEJRBv9XNoUricjMgTyCxX` |
| Oracle State | `ErU8byy8jYDZg5NjsF7eacK2khJ7jfUjsoQZ2E28baJA` |
| AMM Seed | `amm_btc_v6` |

## PDAs (Derived)

PDAs are derived from seeds and the program ID. These are the same on both networks since the program ID is the same:

| PDA | Seeds |
|-----|-------|
| AMM | `["amm_btc_v6"]` |
| Position | `["pos", amm_pubkey, user_pubkey]` |
| Vault | `["vault_sol", amm_pubkey]` |
| User Vault | `["user_vault", position_pubkey]` |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| LAMPORTS_PER_E6 | 100 | Conversion factor for e6 to lamports |
| MIN_VAULT_LAMPORTS | 1 SOL | Minimum vault reserve |
| ORACLE_MAX_AGE_SECS | 90 | Max oracle price age in seconds |
| MIN_BUY_E6 | 100,000 | Min buy amount ($0.10) |
| MAX_SPEND_E6 | 50,000,000,000 | Max spend per trade ($50k) |
