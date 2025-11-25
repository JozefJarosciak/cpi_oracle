-- Points System Schema
-- User points are tracked by master_pubkey (Backpack wallet)

-- Main user points table
CREATE TABLE IF NOT EXISTS users (
    master_pubkey TEXT PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    deposit_points INTEGER DEFAULT 0,
    trade_points INTEGER DEFAULT 0,
    win_points INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Point transactions ledger (immutable history)
CREATE TABLE IF NOT EXISTS point_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    master_pubkey TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('deposit', 'trade', 'win')),
    points INTEGER NOT NULL,
    -- Context for the event
    tx_signature TEXT,           -- Solana tx signature
    amount_lamports INTEGER,     -- For deposits: amount deposited
    shares_e6 INTEGER,           -- For trades: shares bought/sold
    side TEXT,                   -- For trades: 'yes' or 'no'
    direction TEXT,              -- For trades: 'buy' or 'sell'
    payout_lamports INTEGER,     -- For wins: amount won
    market_id TEXT,              -- Market identifier (AMM pubkey)
    created_at INTEGER DEFAULT (strftime('%s', 'now')),

    FOREIGN KEY (master_pubkey) REFERENCES users(master_pubkey)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_point_events_user ON point_events(master_pubkey);
CREATE INDEX IF NOT EXISTS idx_point_events_type ON point_events(event_type);
CREATE INDEX IF NOT EXISTS idx_point_events_created ON point_events(created_at);
CREATE INDEX IF NOT EXISTS idx_users_total_points ON users(total_points DESC);

-- Trigger to update user totals and updated_at on new point event
CREATE TRIGGER IF NOT EXISTS update_user_points
AFTER INSERT ON point_events
BEGIN
    INSERT INTO users (master_pubkey, total_points, deposit_points, trade_points, win_points)
    VALUES (NEW.master_pubkey, 0, 0, 0, 0)
    ON CONFLICT(master_pubkey) DO NOTHING;

    UPDATE users SET
        total_points = total_points + NEW.points,
        deposit_points = deposit_points + CASE WHEN NEW.event_type = 'deposit' THEN NEW.points ELSE 0 END,
        trade_points = trade_points + CASE WHEN NEW.event_type = 'trade' THEN NEW.points ELSE 0 END,
        win_points = win_points + CASE WHEN NEW.event_type = 'win' THEN NEW.points ELSE 0 END,
        updated_at = strftime('%s', 'now')
    WHERE master_pubkey = NEW.master_pubkey;
END;
