-- =========================================================================
-- JAI LUDO: IN-APP PURCHASE & COIN TRANSACTION DATABASE SCHEMA
-- Compatible with PostgreSQL, SQLite, and MySQL
-- =========================================================================

-- 1. Users Table (Source of truth for persistent player balances)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) PRIMARY KEY,               -- Firebase UID or Google User ID
    coin_balance BIGINT NOT NULL DEFAULT 25000, -- Server-side coin balance
    email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Purchase Transactions Table (Strict idempotency and audit ledger)
-- The UNIQUE constraint on purchase_token is critical to prevent double-crediting
CREATE TABLE IF NOT EXISTS purchase_transactions (
    purchase_token VARCHAR(512) PRIMARY KEY,   -- UNIQUE token from Google Play
    product_id VARCHAR(64) NOT NULL,           -- coins_100, coins_500, coins_1000, coins_5000
    user_id VARCHAR(128) NOT NULL,             -- References users(id)
    order_id VARCHAR(128),                     -- Google Play GPA.XXXX-XXXX-XXXX-XXXXX
    coins_granted INTEGER NOT NULL,            -- Number of coins credited
    purchase_time_millis BIGINT,               -- Play purchase timestamp
    status VARCHAR(32) NOT NULL DEFAULT 'VERIFIED', -- VERIFIED, COMPLETED, PENDING, REVOKED, REFUNDED
    raw_play_response TEXT,                    -- Full JSON response from Google Play Developer API
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON purchase_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON purchase_transactions(status);
