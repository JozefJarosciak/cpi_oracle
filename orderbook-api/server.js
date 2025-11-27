const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3436;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'orders.db');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.json());

// SSE clients for keeper log streaming
const keeperLogClients = new Set();
const keeperLogBuffer = [];
const MAX_LOG_BUFFER = 100;

// SSE clients for order updates
const orderUpdateClients = new Set();

// Helper function to broadcast keeper logs to all SSE clients
function broadcastKeeperLog(message, level = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    level
  };

  // Add to buffer
  keeperLogBuffer.push(logEntry);
  if (keeperLogBuffer.length > MAX_LOG_BUFFER) {
    keeperLogBuffer.shift();
  }

  // Broadcast to all connected clients
  const data = JSON.stringify(logEntry);
  keeperLogClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      console.error('Error broadcasting to SSE client:', err);
      keeperLogClients.delete(client);
    }
  });
}

// Helper function to broadcast order updates to all SSE clients
function broadcastOrderUpdate(event, order) {
  const updateData = {
    timestamp: new Date().toISOString(),
    event, // 'order_submitted', 'order_cancelled', 'order_filled', 'order_expired'
    order
  };

  const data = JSON.stringify(updateData);
  orderUpdateClients.forEach(client => {
    try {
      client.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch (err) {
      console.error('Error broadcasting order update to SSE client:', err);
      orderUpdateClients.delete(client);
    }
  });
}

// Expose functions globally so keeper can use them
global.broadcastKeeperLog = broadcastKeeperLog;
global.broadcastOrderUpdate = broadcastOrderUpdate;

// Database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite database at:', DB_PATH);
});

// Enable foreign keys and WAL mode for better concurrency
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');

// ===========================
// Helper Functions
// ===========================

function computeOrderHash(orderJson) {
  // Create deterministic hash from order JSON
  const sortedOrder = JSON.stringify(orderJson, Object.keys(orderJson).sort());
  return crypto.createHash('sha256').update(sortedOrder).digest('hex');
}

function validateOrder(order) {
  const required = [
    'market', 'user', 'action', 'side', 'shares_e6',
    'limit_price_e6', 'expiry_ts', 'nonce'
  ];

  for (const field of required) {
    if (order[field] === undefined || order[field] === null) {
      return `Missing required field: ${field}`;
    }
  }

  // Validate action (1=BUY, 2=SELL)
  if (![1, 2].includes(order.action)) {
    return 'Invalid action: must be 1 (BUY) or 2 (SELL)';
  }

  // Validate side (1=YES, 2=NO)
  if (![1, 2].includes(order.side)) {
    return 'Invalid side: must be 1 (YES) or 2 (NO)';
  }

  // Validate shares
  if (order.shares_e6 <= 0) {
    return 'shares_e6 must be positive';
  }

  // Validate limit price
  if (order.limit_price_e6 <= 0) {
    return 'limit_price_e6 must be positive';
  }

  // Validate expiry is in the future
  const now = Math.floor(Date.now() / 1000);
  if (order.expiry_ts <= now) {
    return 'expiry_ts must be in the future';
  }

  // Validate signature format (128 hex chars = 64 bytes)
  if (typeof order.signature === 'string' && order.signature.length !== 128) {
    return 'signature must be 128 hex characters (64 bytes)';
  }

  return null; // Valid
}

// ===========================
// API Endpoints
// ===========================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// GET /api/stats - Database statistics
app.get('/api/stats', (req, res) => {
  const query = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) as filled,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM orders
  `;

  db.get(query, [], (err, stats) => {
    if (err) {
      console.error('Error fetching stats:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(stats);
  });
});

// POST /api/orders/submit - Submit a new signed order
app.post('/api/orders/submit', (req, res) => {
  const { order, signature } = req.body;

  if (!order || !signature) {
    return res.status(400).json({ error: 'Missing order or signature' });
  }

  // Validate order structure
  const validationError = validateOrder(order);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Compute order hash
  const orderHash = computeOrderHash(order);

  // Insert into database
  const sql = `
    INSERT INTO orders (
      order_hash, order_json, signature,
      market, user_pubkey, action, side,
      limit_price_e6, shares_e6, expiry_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    orderHash,
    JSON.stringify(order),
    signature,
    order.market,
    order.user,
    order.action,
    order.side,
    order.limit_price_e6,
    order.shares_e6,
    order.expiry_ts
  ];

  db.run(sql, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Order already exists (duplicate hash)' });
      }
      console.error('Error inserting order:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const orderId = this.lastID;
    console.log(`✅ Order submitted: ${orderHash.slice(0, 16)}... (id=${orderId})`);

    // Broadcast order submission to SSE clients
    broadcastOrderUpdate('order_submitted', {
      order_id: orderId,
      order,
      order_hash: orderHash
    });

    res.json({
      success: true,
      order_id: orderId,
      order_hash: orderHash
    });
  });
});

// GET /api/orders/pending - Get all pending orders (for keepers)
app.get('/api/orders/pending', (req, res) => {
  const { market, action, side, limit } = req.query;

  let sql = 'SELECT * FROM orders WHERE status = ?';
  const params = ['pending'];

  if (market) {
    sql += ' AND market = ?';
    params.push(market);
  }

  if (action) {
    sql += ' AND action = ?';
    params.push(parseInt(action));
  }

  if (side) {
    sql += ' AND side = ?';
    params.push(parseInt(side));
  }

  sql += ' ORDER BY submitted_at ASC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(parseInt(limit));
  } else {
    sql += ' LIMIT 100'; // Default limit
  }

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching pending orders:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const orders = rows.map(row => ({
      order_id: row.id,
      order_hash: row.order_hash,
      order: JSON.parse(row.order_json),
      signature: row.signature,
      submitted_at: new Date(row.submitted_at * 1000).toISOString()
    }));

    res.json({ orders });
  });
});

// GET /api/orders/filled - Get all filled orders (for history view)
app.get('/api/orders/filled', (req, res) => {
  const { market, limit } = req.query;

  let sql = 'SELECT * FROM orders WHERE status = ?';
  const params = ['filled'];

  if (market) {
    sql += ' AND market = ?';
    params.push(market);
  }

  sql += ' ORDER BY filled_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(parseInt(limit));
  } else {
    sql += ' LIMIT 100'; // Default limit
  }

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching filled orders:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const orders = rows.map(row => {
      const order = JSON.parse(row.order_json);
      // Calculate total cost and effective price
      const shares = row.filled_shares_e6 / 10_000_000; // Convert from 10M scale
      const effectivePrice = row.execution_price_e6 / 1e6; // Convert from 1e6 scale
      const totalCost = shares * effectivePrice;

      return {
        order_id: row.id,
        order_hash: row.order_hash,
        order: order,
        signature: row.signature,
        submitted_at: new Date(row.submitted_at * 1000).toISOString(),
        filled_at: new Date(row.filled_at * 1000).toISOString(),
        filled_tx: row.filled_tx,
        filled_shares: shares,
        execution_price: effectivePrice,
        total_cost: totalCost,
        keeper_pubkey: row.keeper_pubkey
      };
    });

    res.json({ orders });
  });
});

// GET /api/orders/user/:pubkey - Get orders for specific user
app.get('/api/orders/user/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const { status } = req.query;

  let sql = 'SELECT * FROM orders WHERE user_pubkey = ?';
  const params = [pubkey];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY submitted_at DESC LIMIT 100';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching user orders:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const orders = rows.map(row => ({
      order_id: row.id,
      order_hash: row.order_hash,
      order: JSON.parse(row.order_json),
      signature: row.signature,
      status: row.status,
      submitted_at: new Date(row.submitted_at * 1000).toISOString(),
      filled_at: row.filled_at ? new Date(row.filled_at * 1000).toISOString() : null,
      filled_tx: row.filled_tx,
      filled_shares_e6: row.filled_shares_e6,
      execution_price_e6: row.execution_price_e6,
      keeper_pubkey: row.keeper_pubkey
    }));

    res.json({ orders });
  });
});

// GET /api/orders/:order_id - Get specific order by ID
app.get('/api/orders/:order_id', (req, res) => {
  const { order_id } = req.params;

  db.get('SELECT * FROM orders WHERE id = ?', [order_id], (err, row) => {
    if (err) {
      console.error('Error fetching order:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = {
      order_id: row.id,
      order_hash: row.order_hash,
      order: JSON.parse(row.order_json),
      signature: row.signature,
      status: row.status,
      submitted_at: new Date(row.submitted_at * 1000).toISOString(),
      filled_at: row.filled_at ? new Date(row.filled_at * 1000).toISOString() : null,
      filled_tx: row.filled_tx,
      filled_shares_e6: row.filled_shares_e6,
      execution_price_e6: row.execution_price_e6,
      keeper_pubkey: row.keeper_pubkey
    };

    res.json(order);
  });
});

// POST /api/orders/:order_id/fill - Mark order as filled (keeper only)
app.post('/api/orders/:order_id/fill', (req, res) => {
  const { order_id } = req.params;
  const { tx_signature, shares_filled, execution_price, keeper_pubkey } = req.body;

  if (!tx_signature) {
    return res.status(400).json({ error: 'Missing tx_signature' });
  }

  // First, get order details for logging
  db.get('SELECT * FROM orders WHERE id = ?', [order_id], (err, order) => {
    if (err || !order) {
      console.error('Error fetching order for fill:', err);
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = JSON.parse(order.order_json);
    const action = orderData.action === 1 ? 'BUY' : 'SELL';
    const side = orderData.side === 1 ? 'YES' : 'NO';
    const shares = (shares_filled / 10_000_000).toFixed(2);
    const price = (execution_price / 1e6).toFixed(6);
    const txShort = tx_signature.slice(0, 8);

    const sql = `
      UPDATE orders
      SET status = 'filled',
          filled_tx = ?,
          filled_at = strftime('%s', 'now'),
          filled_shares_e6 = ?,
          execution_price_e6 = ?,
          keeper_pubkey = ?
      WHERE id = ? AND status = 'pending'
    `;

    db.run(sql, [tx_signature, shares_filled, execution_price, keeper_pubkey, order_id], function(err) {
      if (err) {
        console.error('Error marking order as filled:', err);
        broadcastKeeperLog(`❌ Failed to mark order #${order_id} as filled: ${err.message}`, 'error');
        return res.status(500).json({ error: 'Database error' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Order not found or already processed' });
      }

      const logMsg = `✅ Order #${order_id} filled: ${action} ${shares} ${side} @ $${price}`;
      console.log(logMsg);
      broadcastKeeperLog(logMsg, 'success');
      broadcastKeeperLog(`TX: ${tx_signature}`, 'tx');

      // Broadcast order filled event to SSE clients
      broadcastOrderUpdate('order_filled', {
        order_id: parseInt(order_id),
        order: orderData,
        status: 'filled',
        filled_tx: tx_signature,
        filled_shares: parseFloat(shares),
        execution_price: parseFloat(price),
        total_cost: (shares_filled / 10_000_000) * (execution_price / 1_000_000)
      });

      // Notify main server about the fill to update cost basis
      notifyMainServerOfFill(orderData, shares_filled, execution_price);

      res.json({ success: true, order_id: parseInt(order_id) });
    });
  });
});

// Helper function to notify main server of filled order for cost basis tracking
async function notifyMainServerOfFill(orderData, sharesFilled, executionPrice) {
  try {
    const action = orderData.action === 1 ? 'BUY' : 'SELL';
    const side = orderData.side === 1 ? 'UP' : 'DOWN';
    const shares = sharesFilled / 10_000_000;
    const price = executionPrice / 1_000_000;
    const costUsd = shares * price;
    const userPubkey = orderData.user || orderData.user_pubkey;

    const data = JSON.stringify({
      userPrefix: userPubkey.slice(0, 6),
      walletPubkey: userPubkey,
      action,
      side,
      shares,
      costUsd,
      avgPrice: price,
      pnl: null
    });

    const options = {
      hostname: 'localhost',
      port: 3434,
      path: '/api/trading-history',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ Cost basis updated for ${userPubkey.slice(0, 6)}: ${action} ${shares.toFixed(2)} ${side} @ $${price.toFixed(6)}`);
        } else {
          console.error(`❌ Failed to update cost basis: ${body}`);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Error notifying main server:', err.message);
    });

    req.write(data);
    req.end();
  } catch (err) {
    console.error('Failed to notify main server:', err.message);
  }
}

// POST /api/orders/:order_id/cancel - Cancel order (user only)
app.post('/api/orders/:order_id/cancel', (req, res) => {
  const { order_id } = req.params;

  // TODO: Add signature verification to ensure only order owner can cancel

  const sql = `
    UPDATE orders
    SET status = 'cancelled'
    WHERE id = ? AND status = 'pending'
  `;

  db.run(sql, [order_id], function(err) {
    if (err) {
      console.error('Error cancelling order:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Order not found or already processed' });
    }

    console.log(`🚫 Order ${order_id} cancelled`);

    // Broadcast order cancellation to SSE clients
    broadcastOrderUpdate('order_cancelled', {
      order_id: parseInt(order_id),
      status: 'cancelled'
    });

    res.json({ success: true, order_id: parseInt(order_id) });
  });
});

// POST /api/orders/expire - Mark expired orders (cron job endpoint)
app.post('/api/orders/expire', (req, res) => {
  const now = Math.floor(Date.now() / 1000);

  const sql = `
    UPDATE orders
    SET status = 'expired'
    WHERE status = 'pending' AND expiry_ts <= ?
  `;

  db.run(sql, [now], function(err) {
    if (err) {
      console.error('Error expiring orders:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`⏱️  Expired ${this.changes} orders`);

    res.json({
      success: true,
      expired_count: this.changes
    });
  });
});

// POST /api/orders/cancel-all - Cancel all pending orders
app.post('/api/orders/cancel-all', (req, res) => {
  const sql = `
    UPDATE orders
    SET status = 'cancelled'
    WHERE status = 'pending'
  `;

  db.run(sql, [], function(err) {
    if (err) {
      console.error('Error cancelling all orders:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`🚫 Cancelled ${this.changes} pending orders`);

    res.json({
      success: true,
      cancelled_count: this.changes
    });
  });
});

// DELETE /api/orders/clear-history - Clear all filled, cancelled, and expired orders
app.delete('/api/orders/clear-history', (req, res) => {
  const sql = `
    DELETE FROM orders
    WHERE status IN ('filled', 'cancelled', 'expired')
  `;

  db.run(sql, [], function(err) {
    if (err) {
      console.error('Error clearing history:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`🗑️  Cleared ${this.changes} historical orders`);

    res.json({
      success: true,
      deleted_count: this.changes
    });
  });
});

// ===========================
// Keeper Log Streaming (SSE)
// ===========================

app.get('/api/keeper-logs', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write(`data: ${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: '🔗 Connected to keeper log stream',
    level: 'info'
  })}\n\n`);

  // Send buffered logs
  keeperLogBuffer.forEach(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  // Add client to set
  keeperLogClients.add(res);
  console.log(`📡 New SSE client connected. Total clients: ${keeperLogClients.size}`);

  // Remove client on disconnect
  req.on('close', () => {
    keeperLogClients.delete(res);
    console.log(`📡 SSE client disconnected. Total clients: ${keeperLogClients.size}`);
  });
});

// ===========================
// Order Updates Streaming (SSE)
// ===========================

app.get('/api/orders-stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write(`event: connected\ndata: ${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: '🔗 Connected to order updates stream'
  })}\n\n`);

  // Add client to set
  orderUpdateClients.add(res);
  console.log(`📊 New order update client connected. Total clients: ${orderUpdateClients.size}`);

  // Remove client on disconnect
  req.on('close', () => {
    orderUpdateClients.delete(res);
    console.log(`📊 Order update client disconnected. Total clients: ${orderUpdateClients.size}`);
  });
});

// ===========================
// Background Tasks
// ===========================

// Auto-expire orders every 60 seconds
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);

  db.run(
    "UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expiry_ts <= ?",
    [now],
    function(err) {
      if (err) {
        console.error('❌ Error auto-expiring orders:', err);
      } else if (this.changes > 0) {
        console.log(`⏱️  Auto-expired ${this.changes} orders`);
      }
    }
  );
}, 60000); // Every 60 seconds

// ===========================
// Error Handling
// ===========================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===========================
// Start Server
// ===========================

app.listen(PORT, () => {
  console.log(`🚀 Order Book API running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/stats`);
  console.log(`  POST /api/orders/submit`);
  console.log(`  GET  /api/orders/pending`);
  console.log(`  GET  /api/orders/user/:pubkey`);
  console.log(`  GET  /api/orders/:order_id`);
  console.log(`  POST /api/orders/:order_id/fill`);
  console.log(`  POST /api/orders/:order_id/cancel`);
  console.log(`  POST /api/orders/expire`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    process.exit(0);
  });
});
