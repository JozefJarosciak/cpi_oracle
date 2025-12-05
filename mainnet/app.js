// Configuration - Updated for v5 market
const CONFIG = {
    RPC_URL: 'https://rpc.mainnet.x1.xyz',
    PROGRAM_ID: 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF',
    ORACLE_STATE: 'ErU8byy8jYDZg5NjsF7eacK2khJ7jfUjsoQZ2E28baJA',
    AMM_SEED: 'amm_btc_v6',  // v6: time-based trading lockout
    LAMPORTS_PER_E6: 100,
    STATUS_URL: '/market_status.json',
    // API prefix - Use TypeScript endpoints if window.API_BASE is set (proto2)
    API_PREFIX: window.API_BASE || '/api'
};

// Remote logging function for mobile debugging
function remoteLog(msg) {
    console.log(msg); // Also log locally
    fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
    }).catch(() => {}); // Ignore errors
}

// Mobile/Android detection and touch event setup
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const isAndroidWebView = /Android/i.test(navigator.userAgent) && /wv|WebView/i.test(navigator.userAgent);

if (isMobileDevice) {
    remoteLog('[MOBILE] Mobile device detected: ' + navigator.userAgent.substring(0, 50));
}

// Setup touch handlers for mobile WebView - called after DOM ready
function setupMobileTouchHandlers() {
    if (!isMobileDevice) return;

    remoteLog('[MOBILE] Setting up touch handlers');

    // Map of button IDs to their handler functions
    const buttonHandlers = {
        'depositBtn': async () => {
            remoteLog('[TOUCH] depositBtn touched');
            try { await openDepositModal(); }
            catch(e) { remoteLog('[TOUCH ERROR] depositBtn: ' + e.message); }
        },
        'executeDepositBtn': async () => {
            remoteLog('[TOUCH] executeDepositBtn touched');
            try { await executeDeposit(); }
            catch(e) { remoteLog('[TOUCH ERROR] executeDepositBtn: ' + e.message); }
        },
        'createUserBtn': async () => {
            remoteLog('[TOUCH] createUserBtn touched');
            try { await createUser(); }
            catch(e) { remoteLog('[TOUCH ERROR] createUserBtn: ' + e.message); }
        },
        'connectWalletBtn': async () => {
            remoteLog('[TOUCH] connectWalletBtn touched');
            try { await connectBackpack(); }
            catch(e) { remoteLog('[TOUCH ERROR] connectWalletBtn: ' + e.message); }
        }
    };

    for (const [btnId, handler] of Object.entries(buttonHandlers)) {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }, { passive: false });
            remoteLog('[MOBILE] Touch handler added for: ' + btnId);
        }
    }
}

// Log the config on load to verify we're using the right version
console.log('[CONFIG] Using AMM_SEED:', CONFIG.AMM_SEED);
console.log('[CONFIG] Using API endpoints:', CONFIG.API_PREFIX);

// Global state
let wallet = null; // Session wallet (Keypair)
let backpackWallet = null; // Connected wallet provider (Phantom, Backpack, or X1)
let activeWalletType = null; // Track which wallet type is connected: 'phantom', 'backpack', 'x1_wallet'

// Multi-wallet detection - returns the first available wallet provider
function detectWallet() {
    // Check for X1 Wallet (mobile app WebView)
    if (window.x1_wallet) {
        console.log('[Wallet] X1 Wallet detected');
        return { provider: window.x1_wallet, type: 'x1_wallet', name: 'X1 Wallet' };
    }
    // Check for Backpack
    if (window.backpack) {
        console.log('[Wallet] Backpack detected');
        return { provider: window.backpack, type: 'backpack', name: 'Backpack' };
    }
    // Check for Phantom (window.phantom.solana or window.solana)
    if (window.phantom?.solana) {
        console.log('[Wallet] Phantom detected (window.phantom.solana)');
        return { provider: window.phantom.solana, type: 'phantom', name: 'Phantom' };
    }
    if (window.solana?.isPhantom) {
        console.log('[Wallet] Phantom detected (window.solana)');
        return { provider: window.solana, type: 'phantom', name: 'Phantom' };
    }
    console.log('[Wallet] No wallet detected');
    return null;
}
let currentFeeBps = 25; // Default fee in basis points (0.25%)
let rapidFireMode = false; // Rapid fire trading mode (no confirmation)
let debugMode = false; // Debug mode (console logging)
let pendingTradeData = null; // Stores trade data when waiting for confirmation

// Alarm state for market close warning
let alarmPlayed = false; // Track if alarm has been played for current market
let lastMarketEndTime = null; // Track market end time to reset alarm
let alarmEnabled = true; // User preference for alarm (saved to localStorage)
let notificationPermission = 'default'; // Track notification permission status

// Snapshot notification state
let snapshotSoundPlayed = false; // Track if snapshot sound has been played for current market
let lastMarketState = null; // Track market state transitions

// Countdown state for smooth updates
let countdownEndTime = null; // Cached end time for smooth countdown
let countdownUpdateInterval = null; // Interval for countdown updates

// BTC Price Chart (Chart.js)
let btcChart = null;
let priceHistory = []; // Stores actual BTC prices (one per second)
let currentTimeRange = 60; // Current time range in seconds (default 1 minute for display)
const PRICE_HISTORY_KEY = 'btc_price_history';
const PRICE_HISTORY_MAX_AGE_MS = 60000; // Keep data for 60 seconds

// Chart style (line, line-colored)
let chartStyle = 'line-colored'; // Default to colored line chart style
const CHART_STYLE_KEY = 'btc_chart_style';
const CHART_STYLES = ['line', 'line-colored']; // Toggle between these modes

// Throttle price logging to once per second
let lastPriceLogTime = 0;

// High-resolution chart for smooth scrolling
const CHART_UPDATE_INTERVAL_MS = 55; // Update chart every 55ms (~18 points/sec, 10% reduction)
const BASE_POINTS_PER_SECOND = 1000 / CHART_UPDATE_INTERVAL_MS; // ~18.18 points per second
const MAX_CHART_POINTS = 2000; // Maximum points to display to prevent memory issues
let chartDataPoints = []; // High-resolution data for smooth scrolling
let chartUpdateTimer = null;

// CRITICAL: Global counter for sampling - MUST be reset when switching time ranges
// See CHART_SMOOTHNESS_FIX.md for detailed explanation
let chartUpdateCounter = 0; // Reset to 0 in rebuildChartFromHistory() to align sampling grid

let currentSamplingRate = 1; // How many data points to skip (1 = no skip, 2 = every other, etc.)

// Interpolation for smooth animation
// CRITICAL: currentTargetPrice is continuously updated by live stream - preserve it during rebuilds!
// See CHART_SMOOTHNESS_FIX.md for why overwriting this causes 8-second delays
let currentTargetPrice = null; // Latest real-time BTC price (DO NOT overwrite with historical data)
let lastActualPrice = null;    // Last interpolated display price (sync to currentTargetPrice on rebuild)

// Calculate optimal sampling rate based on time range to stay under MAX_CHART_POINTS
function getOptimalSamplingRate(timeRangeSeconds) {
    if (!timeRangeSeconds) {
        // For 'ALL', estimate based on current data
        const estimatedSeconds = Math.max(300, chartDataPoints.length / BASE_POINTS_PER_SECOND);
        timeRangeSeconds = estimatedSeconds;
    }

    // Apply point reduction based on time range
    let maxPoints = MAX_CHART_POINTS;

    if (timeRangeSeconds >= 1800) {
        // 30m, 1h, 6h, 24h: Use 1000 points
        maxPoints = 1000;
    }
    // 1m (60s), 5m (300s), and 15m (900s): No restriction, use MAX_CHART_POINTS (2000) for smooth updates

    const totalPoints = timeRangeSeconds * BASE_POINTS_PER_SECOND;
    const samplingRate = Math.max(1, Math.ceil(totalPoints / maxPoints));
    return samplingRate;
}

// Get effective points per second after sampling
function getEffectivePointsPerSecond(timeRangeSeconds) {
    const samplingRate = getOptimalSamplingRate(timeRangeSeconds);
    return BASE_POINTS_PER_SECOND / samplingRate;
}

// Market start price (for arrow indicator)
let marketStartPrice = null;
let showPriceToBeatLine = false; // Toggle for price-to-beat horizontal line on chart

let connection = null;
let ammPda = null;
let vaultPda = null;

let currentLockoutStartSlot = 0;
let latestObservedSlot = 0;
let slotPollIntervalId = null;

function updateSlotHeaderDisplay() {
    const startEl = document.getElementById('slotStartValue');
    const endEl = document.getElementById('slotEndValue');
    const currentEl = document.getElementById('slotCurrentValue');
    const diffEl = document.getElementById('slotDiffValue');
    const container = document.getElementById('slotIndicators');

    if (startEl) {
        startEl.textContent = currentLockoutStartSlot > 0
            ? currentLockoutStartSlot.toLocaleString('en-US')
            : '--';
    }

    if (endEl) {
        endEl.textContent = currentMarketEndSlot > 0
            ? currentMarketEndSlot.toLocaleString('en-US')
            : '--';
    }

    if (currentEl) {
        currentEl.textContent = latestObservedSlot > 0
            ? latestObservedSlot.toLocaleString('en-US')
            : '--';
    }

    if (diffEl) {
        // Calculate: end slot - current slot = slots remaining
        if (currentMarketEndSlot > 0 && latestObservedSlot > 0) {
            const diff = currentMarketEndSlot - latestObservedSlot;
            if (diff >= 0) {
                diffEl.textContent = diff.toLocaleString('en-US');
                diffEl.style.color = 'rgba(255, 255, 255, 0.4)';
            } else {
                // Market ended, show negative in red
                diffEl.textContent = diff.toLocaleString('en-US');
                diffEl.style.color = '#ff4757';
            }
//             console.log(`[Slot Display] DIFF: ${diff} (end: ${currentMarketEndSlot}, current: ${latestObservedSlot})`);
        } else {
            diffEl.textContent = '--';
            diffEl.style.color = 'rgba(255, 255, 255, 0.4)';
//             console.log(`[Slot Display] DIFF showing '--' (end: ${currentMarketEndSlot}, current: ${latestObservedSlot})`);
        }
    } else {
//         console.warn('[Slot Display] slotDiffValue element not found!');
    }

    if (container) {
        const isLockedSoon = currentLockoutStartSlot > 0 && latestObservedSlot >= currentLockoutStartSlot;
        container.classList.toggle('slot-warning', isLockedSoon);
    }
}

async function pollCurrentSlot() {
    if (!connection) return;
    try {
        const slot = await connection.getSlot();
        latestObservedSlot = slot;
        updateSlotHeaderDisplay();
    } catch (err) {
        console.error('Failed to poll current slot:', err);
    }
}

function startSlotPolling() {
    if (slotPollIntervalId !== null) return;
    pollCurrentSlot();
    slotPollIntervalId = setInterval(pollCurrentSlot, 2000);
}

function updateMarketEndSlot(slot) {
    currentMarketEndSlot = slot || 0;
    currentLockoutStartSlot = currentMarketEndSlot > 0
        ? Math.max(0, currentMarketEndSlot - TRADING_LOCKOUT_SLOTS)
        : 0;
    updateSlotHeaderDisplay();
}

// ============= OUTLIER DETECTION =============

/**
 * Remove outliers from price data using Median Absolute Deviation (MAD)
 * This prevents chart rendering issues from data artifacts
 */
function removeOutliers(prices, threshold = 3) {
    if (!prices || prices.length === 0) return prices;
    if (prices.length < 5) return prices; // Not enough data to detect outliers

    // Calculate median
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

    // Calculate MAD (Median Absolute Deviation)
    const absoluteDeviations = prices.map(price => Math.abs(price - median));
    const sortedDeviations = [...absoluteDeviations].sort((a, b) => a - b);
    const madMid = Math.floor(sortedDeviations.length / 2);
    const mad = sortedDeviations.length % 2 === 0
        ? (sortedDeviations[madMid - 1] + sortedDeviations[madMid]) / 2
        : sortedDeviations[madMid];

    // If MAD is 0 (all values are the same), use standard deviation instead
    let filterThreshold;
    if (mad === 0) {
        const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        const stdDev = Math.sqrt(variance);
        filterThreshold = stdDev * threshold;
    } else {
        // Use MAD-based threshold (scaled by 1.4826 to be consistent with standard deviation)
        filterThreshold = 1.4826 * mad * threshold;
    }

    // Filter outliers: keep only values within threshold of median
    const filtered = prices.filter(price =>
        Math.abs(price - median) <= filterThreshold
    );

    const removedCount = prices.length - filtered.length;
    if (removedCount > 0) {
        console.log(`Removed ${removedCount} outliers from ${prices.length} prices (median: $${median.toFixed(2)}, threshold: ±$${filterThreshold.toFixed(2)})`);
    }

    return filtered;
}

// ============= BROWSER-COMPATIBLE BUFFER =============

// Helper to convert string to Uint8Array (browser-compatible Buffer replacement)
function stringToUint8Array(str) {
    return new TextEncoder().encode(str);
}

// Helper to concat Uint8Arrays
function concatUint8Arrays(...arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// ============= LOGGING SYSTEM =============

function addLog(message, type = 'info') {
    const logContent = document.getElementById('logContent');
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    const now = new Date();
    time.textContent = now.toLocaleTimeString('en-US', { hour12: false });

    const msg = document.createElement('span');
    msg.className = 'log-message';

    // Detect transaction signatures and make them clickable
    if (type === 'tx' && message.startsWith('TX: ')) {
        const signature = message.substring(4); // Remove 'TX: ' prefix
        const link = document.createElement('a');
        link.href = `https://explorer.mainnet.x1.xyz/tx/${signature}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = message;
        link.style.color = '#00ff00';
        link.style.textDecoration = 'underline';
        msg.appendChild(link);
    } else {
        msg.textContent = message;
    }

    entry.appendChild(time);
    entry.appendChild(msg);

    // Prepend to show newest on top
    if (logContent.firstChild) {
        logContent.insertBefore(entry, logContent.firstChild);
    } else {
        logContent.appendChild(entry);
    }

    // Auto-scroll to top to show newest entry
    logContent.scrollTop = 0;

    // Keep only last 100 entries (remove from bottom since we add to top)
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.lastChild);
    }
}

function clearLog() {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = '';
    addLog('Log cleared', 'info');
}

// Initialize on load
window.addEventListener('load', async () => {
    addLog('Initializing trading terminal...', 'info');

    connection = new solanaWeb3.Connection(CONFIG.RPC_URL, 'confirmed');
    addLog('Connected to RPC: ' + CONFIG.RPC_URL, 'info');

    // Calculate PDAs
    const [amm] = await solanaWeb3.PublicKey.findProgramAddressSync(
        [stringToUint8Array(CONFIG.AMM_SEED)],
        new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
    );
    ammPda = amm;
    console.log('[INIT] Calculated AMM PDA:', ammPda.toString());
    console.log('[INIT] Using AMM_SEED:', CONFIG.AMM_SEED);

    const [vault] = await solanaWeb3.PublicKey.findProgramAddressSync(
        [stringToUint8Array('vault_sol'), ammPda.toBytes()],
        new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
    );
    vaultPda = vault;
    console.log('[INIT] Calculated Vault PDA:', vaultPda.toString());

    updateSlotHeaderDisplay();
    startSlotPolling();

    // Poll market data every 5 seconds to keep market_end_slot fresh
    fetchMarketData(); // Initial fetch
    setInterval(fetchMarketData, 5000);

    // Log trading lockout status every 10 seconds
    setInterval(() => {
        if (currentMarketEndTime > 0) {
            const now = Date.now();
            const lockoutStartTime = currentMarketEndTime - (TRADING_LOCKOUT_SECONDS * 1000);
            const timeUntilEnd = Math.max(0, currentMarketEndTime - now) / 1000;
            const timeUntilLockout = Math.max(0, lockoutStartTime - now) / 1000;
            const isLocked = now >= lockoutStartTime;

            if (timeUntilEnd > 0) {
                console.log(`[Market Timing] End: ${new Date(currentMarketEndTime).toLocaleTimeString()} | Lockout in: ${timeUntilLockout.toFixed(0)}s | Closes in: ${timeUntilEnd.toFixed(0)}s | Locked: ${isLocked ? '🔒 YES' : '✅ NO'}`);
            }
        }
    }, 10000);

    addLog('AMM PDA: ' + ammPda.toString(), 'info');
    addLog('Vault PDA: ' + vaultPda.toString(), 'info');

    // Try to restore session if Backpack is already connected
    await restoreSession();

    // Set display time range to 1 minute
    currentTimeRange = 60;

    // Load only what we need for 1m view (with 2x buffer for smooth scrolling)
    // Data for other time ranges will be loaded on-demand when user switches
    await loadPriceHistory(currentTimeRange * 2); // Load 2 minutes for 1m view

    // Initialize BTC chart with Chart.js
    // Note: initBTCChart calls rebuildChartFromHistory internally after successful init
    initBTCChart();

    // Start polling
    startPolling();
    addLog('System ready. Auto-refresh every 1s', 'success');

    // Set up wallet account change listener (supports X1, Backpack, Phantom)
    setupWalletAccountListener();

    // Set up mobile touch handlers for Android WebView
    setupMobileTouchHandlers();
});

// Handle page visibility changes - reload chart data when tab becomes active
document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
        // Tab became visible - user returned to page
        console.log('[VISIBILITY] Tab became visible - reloading price history to refresh chart');

        // Reload price history with current time range to get fresh data
        const timeRangeToLoad = currentTimeRange || 3600; // Default to 1 hour if not set
        await loadPriceHistory(timeRangeToLoad);

        // Rebuild chart with fresh data
        if (priceHistory.length > 0) {
            rebuildChartFromHistory();
            console.log('[VISIBILITY] Chart refreshed with', priceHistory.length, 'seconds of data');
        }
    }
});

// ============= SESSION MANAGEMENT =============

const WALLET_CACHE_KEY = 'backpack_wallet_cached';
const WALLET_CACHE_ADDRESS_KEY = 'backpack_wallet_address';

// Cache wallet connection preference
function cacheWalletConnection(address) {
    try {
        localStorage.setItem(WALLET_CACHE_KEY, 'true');
        localStorage.setItem(WALLET_CACHE_ADDRESS_KEY, address);
        console.log('[Cache] Wallet connection cached:', address);
    } catch (err) {
        console.warn('[Cache] Failed to cache wallet:', err);
    }
}

// Clear wallet cache
function clearWalletCache() {
    try {
        localStorage.removeItem(WALLET_CACHE_KEY);
        localStorage.removeItem(WALLET_CACHE_ADDRESS_KEY);
        console.log('[Cache] Wallet cache cleared');

        // Also clear session wallet cache for safety
        clearSessionWalletCache();
    } catch (err) {
        console.warn('[Cache] Failed to clear cache:', err);
    }
}

// Get cached wallet address
function getCachedWalletAddress() {
    try {
        const isCached = localStorage.getItem(WALLET_CACHE_KEY);
        const cachedAddress = localStorage.getItem(WALLET_CACHE_ADDRESS_KEY);
        if (isCached === 'true' && cachedAddress) {
            return cachedAddress;
        }
    } catch (err) {
        console.warn('[Cache] Failed to get cached wallet:', err);
    }
    return null;
}

async function restoreSession() {
    try {
        // Detect available wallet (X1, Backpack, or Phantom)
        const detected = detectWallet();
        if (!detected) {
            console.log('No wallet detected');
            showNoWallet();
            clearWalletCache();
            return;
        }

        const { provider, type, name } = detected;
        console.log(`[Restore] Using ${name} wallet`);

        // Check for cached wallet preference
        const cachedAddress = getCachedWalletAddress();

        // If wallet is already connected, restore immediately
        if (provider.isConnected) {
            console.log(`[Restore] ${name} already connected, restoring session...`);
            addLog('Restoring session...', 'info');

            backpackWallet = provider;
            activeWalletType = type;
            const walletAddress = backpackWallet.publicKey.toString();

            console.log('[Restore] Wallet address:', walletAddress);

            // Verify cached address matches current wallet (if cached)
            if (cachedAddress && cachedAddress !== walletAddress) {
                console.log('[Restore] Cached wallet mismatch, updating cache');
                clearWalletCache();
            }

            // Cache the connection
            cacheWalletConnection(walletAddress);

            // Derive session wallet (will request signature)
            addLog('Deriving session wallet...', 'info');
            wallet = await deriveSessionWalletFromBackpack(backpackWallet);

            const sessionAddr = wallet.publicKey.toString();
            console.log('[Restore] Session wallet restored:', sessionAddr);

            addLog('Session restored: ' + sessionAddr.substring(0, 12) + '...', 'success');

            // Update UI
            showHasWallet(walletAddress);
            updateWalletBalance();
            fetchPositionData();
            showStatus('Session restored: ' + sessionAddr);

            return;
        }

        // If we have a cached connection preference but not connected, try to reconnect
        if (cachedAddress) {
            console.log('[Restore] Found cached wallet, attempting auto-reconnect...');
            addLog('Auto-reconnecting wallet...', 'info');

            try {
                // Attempt silent reconnection
                const response = await provider.connect();
                backpackWallet = provider;
                activeWalletType = type;
                const walletAddress = backpackWallet.publicKey.toString();

                // Verify it matches the cached address
                if (walletAddress !== cachedAddress) {
                    console.log('[Restore] Wallet address changed, clearing cache');
                    clearWalletCache();
                }

                // Update cache
                cacheWalletConnection(walletAddress);

                // Derive session wallet
                addLog('Deriving session wallet...', 'info');
                wallet = await deriveSessionWalletFromBackpack(backpackWallet);

                const sessionAddr = wallet.publicKey.toString();
                console.log('[Restore] Session wallet auto-restored:', sessionAddr);

                addLog('Wallet auto-reconnected: ' + sessionAddr.substring(0, 12) + '...', 'success');

                // Update UI
                showHasWallet(walletAddress);
                updateWalletBalance();
                fetchPositionData();
                showStatus('Auto-reconnected: ' + sessionAddr);

                return;
            } catch (reconnectErr) {
                console.log('[Restore] Auto-reconnect failed:', reconnectErr);
                clearWalletCache(); // Clear cache if auto-reconnect fails
            }
        }

        // No cache or auto-reconnect failed
        console.log('No cached wallet or auto-reconnect failed, user must click Connect');
        showNoWallet();

    } catch (err) {
        console.error('[Restore] Failed to restore session:', err);
        clearWalletCache(); // Clear cache on error
        showNoWallet();
    }
}

// ============= WALLET ACCOUNT SWITCHING =============

function setupWalletAccountListener() {
    const detected = detectWallet();
    if (!detected) {
        console.log('No wallet detected, account listener not set up');
        return;
    }

    const { provider, type, name } = detected;

    // Only set up listener if the wallet supports it (Backpack and Phantom do, X1 may not)
    if (typeof provider.on !== 'function') {
        console.log(`${name} does not support account change events`);
        return;
    }

    // Listen for account changes
    provider.on('accountChanged', async (publicKey) => {
        console.log(`[Account Switch] ${name} account changed to:`, publicKey?.toString());

        if (!publicKey) {
            // User disconnected
            addLog('Wallet disconnected', 'warning');
            disconnectWallet();
            return;
        }

        // Check if we're already connected
        if (!backpackWallet) {
            console.log('[Account Switch] Not connected yet, ignoring account change');
            return;
        }

        const newWalletAddress = publicKey.toString();
        addLog('Wallet switched to: ' + newWalletAddress.substring(0, 12) + '...', 'info');

        try {
            // Update wallet reference
            backpackWallet = provider;
            activeWalletType = type;

            // Clear old session wallet cache before deriving new one
            clearSessionWalletCache();

            // Re-derive session wallet for the new wallet
            addLog('Re-deriving session wallet for new account...', 'info');
            console.log('[Account Switch] Deriving new session wallet...');

            wallet = await deriveSessionWalletFromBackpack(backpackWallet);

            const sessionAddr = wallet.publicKey.toString();
            console.log('[Account Switch] New session wallet:', sessionAddr);

            addLog('Switched to session wallet: ' + sessionAddr.substring(0, 12) + '...', 'success');
            addLog('This is the deterministic session wallet for your new account', 'info');

            // Update cache with new wallet address
            cacheWalletConnection(newWalletAddress);

            // Update UI
            showHasWallet(newWalletAddress);
            updateWalletBalance();
            fetchPositionData();
            showStatus('Switched! Session wallet: ' + sessionAddr);

        } catch (err) {
            console.error('[Account Switch] Failed to switch session wallet:', err);
            addLog('Failed to switch session wallet: ' + err.message, 'error');
            showError('Failed to derive session wallet for new account');
            disconnectWallet();
        }
    });

    console.log(`${name} account change listener installed`);
}

async function connectBackpack() {
    console.log('[connectBackpack] Button clicked!');
    try {
        // Detect available wallet (X1, Backpack, or Phantom)
        const detected = detectWallet();
        console.log('[connectBackpack] Detected wallet:', detected);

        if (!detected) {
            console.error('[connectBackpack] No wallet found in window object');
            addLog('ERROR: Wallet not found!', 'error');
            addLog('Please open this page in a supported wallet browser', 'info');
            showError('Wallet not found! Please use a supported wallet browser');
            return;
        }

        const { provider, type, name } = detected;
        console.log(`[connectBackpack] ${name} detected, attempting to connect...`);
        addLog(`Connecting ${name}...`, 'info');
        showStatus(`Connecting ${name}...`);

        // Connect wallet
        const response = await provider.connect();
        backpackWallet = provider;
        activeWalletType = type;
        const walletAddress = backpackWallet.publicKey.toString();

        addLog(`${name} connected: ` + walletAddress.substring(0, 12) + '...', 'success');

        // Derive deterministic session wallet from wallet signature
        // Same wallet = Same signature = Same session wallet, ALWAYS!
        // No localStorage needed - completely reproducible from signature alone
        console.log('[DEBUG] About to derive session wallet...');
        wallet = await deriveSessionWalletFromBackpack(backpackWallet);
        console.log('[DEBUG] Wallet object:', wallet);
        console.log('[DEBUG] Wallet is null?', wallet === null);
        console.log('[DEBUG] Wallet publicKey:', wallet ? wallet.publicKey : 'NULL WALLET');

        const sessionAddr = wallet.publicKey.toString();
        console.log('[DEBUG] Session address:', sessionAddr);

        addLog('Session wallet: ' + sessionAddr.substring(0, 12) + '...', 'success');
        addLog('This wallet is deterministically derived from your wallet signature', 'info');
        addLog('Same wallet = Same session wallet, on any device!', 'info');

        // Cache the wallet connection for auto-reconnect on page navigation
        cacheWalletConnection(walletAddress);

        console.log('[DEBUG] About to call showHasWallet...');
        showHasWallet(walletAddress);
        console.log('[DEBUG] showHasWallet completed');

        // Automatically initialize position with master_wallet security
        addLog('Checking position account...', 'info');
        const posInitialized = await initPosition();
        if (posInitialized) {
            addLog('✅ Position ready with withdrawal security enabled', 'success');
        } else {
            addLog('⚠️ Position initialization failed - you may need to initialize manually', 'warning');
        }

        updateWalletBalance();
        fetchPositionData();
        showStatus('Connected! Session wallet: ' + sessionAddr);

    } catch (err) {
        addLog('Connection failed: ' + err.message, 'error');
        showError('Failed to connect wallet: ' + err.message);
        console.error(err);
        clearWalletCache(); // Clear cache on connection failure
    }
}

function disconnectWallet() {
    addLog('Disconnecting wallet...', 'info');

    // Clear wallet references and cache
    wallet = null;
    backpackWallet = null;
    activeWalletType = null;

    // Clear wallet cache to prevent auto-reconnect
    clearWalletCache();

    // Clear session wallet cache
    clearSessionWalletCache();

    // Disconnect any connected wallet provider
    const detected = detectWallet();
    if (detected && detected.provider && detected.provider.disconnect) {
        try {
            detected.provider.disconnect();
        } catch (e) {
            console.log('Wallet disconnect error (ignored):', e);
        }
    }

    showNoWallet();
    addLog('Wallet disconnected.', 'success');
}

// Simple base58 encoder using the base58 alphabet
function bs58encode(bytes) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const base = BigInt(58);

    // Convert bytes to BigInt
    let num = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
        num = num * BigInt(256) + BigInt(bytes[i]);
    }

    // Convert to base58
    let encoded = '';
    while (num > 0) {
        const remainder = num % base;
        num = num / base;
        encoded = ALPHABET[Number(remainder)] + encoded;
    }

    // Add leading zeros
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
        encoded = '1' + encoded;
    }

    return encoded;
}

// ============= DETERMINISTIC SESSION WALLET =============

const SESSION_WALLET_SEED_KEY = 'session_wallet_seed';
const SESSION_WALLET_ADDRESS_KEY = 'session_wallet_address';

// Cache session wallet seed in sessionStorage (persists during browser session only)
function cacheSessionWallet(seed, address) {
    try {
        // Convert Uint8Array seed to hex string for storage
        const seedHex = Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem(SESSION_WALLET_SEED_KEY, seedHex);
        sessionStorage.setItem(SESSION_WALLET_ADDRESS_KEY, address);
        console.log('[Session Cache] Wallet seed cached for address:', address);
    } catch (err) {
        console.warn('[Session Cache] Failed to cache wallet seed:', err);
    }
}

// Get cached session wallet from sessionStorage
function getCachedSessionWallet() {
    try {
        const seedHex = sessionStorage.getItem(SESSION_WALLET_SEED_KEY);
        const address = sessionStorage.getItem(SESSION_WALLET_ADDRESS_KEY);

        if (seedHex && address) {
            // Convert hex string back to Uint8Array
            const seed = new Uint8Array(seedHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            console.log('[Session Cache] Found cached wallet seed for address:', address);
            return { seed, address };
        }
    } catch (err) {
        console.warn('[Session Cache] Failed to get cached wallet:', err);
    }
    return null;
}

// Clear cached session wallet
function clearSessionWalletCache() {
    try {
        sessionStorage.removeItem(SESSION_WALLET_SEED_KEY);
        sessionStorage.removeItem(SESSION_WALLET_ADDRESS_KEY);
        console.log('[Session Cache] Wallet seed cache cleared');
    } catch (err) {
        console.warn('[Session Cache] Failed to clear wallet cache:', err);
    }
}

// Force regeneration of session wallet (for migration to new Position format)
function forceNewSessionWallet() {
    clearSessionWalletCache();
    addLog('Session wallet cache cleared - will generate new wallet on next connection', 'info');
}

// Derive a deterministic session wallet from Backpack signature
// This is SECURE because:
// 1. Signature is derived from Backpack's private key (only owner can produce it)
// 2. Same Backpack wallet always produces same signature for same message
// 3. Signature is 64 bytes = 512 bits of entropy (more than enough for Ed25519 seed)
// 4. Cached in sessionStorage during browser session to avoid re-prompting
async function deriveSessionWalletFromBackpack(backpackWallet) {
    const backpackAddress = backpackWallet.publicKey.toString();

    // Check for cached session wallet first
    const cached = getCachedSessionWallet();
    if (cached) {
        console.log('[Derive] Using cached session wallet, no signature needed');
        addLog('Restoring cached session wallet...', 'info');

        // Verify the cached address matches (safety check)
        const keypair = solanaWeb3.Keypair.fromSeed(cached.seed);
        const derivedAddress = keypair.publicKey.toString();

        if (derivedAddress === cached.address) {
            console.log('[Derive] Cached wallet verified:', derivedAddress);
            return keypair;
        } else {
            console.warn('[Derive] Cached wallet mismatch, re-deriving');
            clearSessionWalletCache();
        }
    }

    const message = new TextEncoder().encode('x1-markets-deterministic-session-wallet-v1');

    try {
        // Request signature from Backpack - this is DETERMINISTIC and SECRET
        addLog('Requesting signature to derive session wallet...', 'info');
        console.log('[DEBUG derive] Requesting signature from Backpack...');

        const signature = await backpackWallet.signMessage(message);
        console.log('[DEBUG derive] Got signature, length:', signature.length);
        console.log('[DEBUG derive] Signature type:', typeof signature);
        console.log('[DEBUG derive] Signature constructor:', signature.constructor.name);
        console.log('[DEBUG derive] Signature object:', signature);

        // Convert signature to Uint8Array if it's not already
        let signatureBytes;
        if (signature instanceof Uint8Array) {
            signatureBytes = signature;
        } else if (signature.signature) {
            // Check if signature.signature is a base64 string (from X1 Wallet) or Uint8Array (from Backpack)
            if (typeof signature.signature === 'string') {
                // X1 Wallet returns base64 encoded signature
                console.log('[DEBUG derive] Decoding base64 signature from X1 Wallet');
                const binary = atob(signature.signature);
                signatureBytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    signatureBytes[i] = binary.charCodeAt(i);
                }
            } else {
                // Backpack returns {signature: Uint8Array, publicKey: PublicKey}
                signatureBytes = signature.signature;
            }
        } else if (ArrayBuffer.isView(signature)) {
            signatureBytes = new Uint8Array(signature.buffer);
        } else if (typeof signature === 'string') {
            // Direct base64 string
            console.log('[DEBUG derive] Decoding direct base64 signature');
            const binary = atob(signature);
            signatureBytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                signatureBytes[i] = binary.charCodeAt(i);
            }
        } else {
            console.error('[DEBUG derive] Unexpected signature format:', signature);
            throw new Error('Unexpected signature format from wallet');
        }

        console.log('[DEBUG derive] Signature bytes length:', signatureBytes.length);
        console.log('[DEBUG derive] First 8 bytes:', Array.from(signatureBytes.slice(0, 8)));

        // Use first 32 bytes of signature as Ed25519 seed
        // Ed25519 seeds are exactly 32 bytes (256 bits)
        const seed = signatureBytes.slice(0, 32);
        console.log('[DEBUG derive] Seed created, length:', seed.length);

        // Create keypair from deterministic seed
        const keypair = solanaWeb3.Keypair.fromSeed(seed);
        console.log('[DEBUG derive] Keypair created');
        console.log('[DEBUG derive] Keypair publicKey:', keypair.publicKey.toString());
        console.log('[DEBUG derive] Keypair type:', typeof keypair);
        console.log('[DEBUG derive] Keypair is null?', keypair === null);

        // Cache the session wallet seed for this browser session
        const sessionAddress = keypair.publicKey.toString();
        cacheSessionWallet(seed, sessionAddress);

        addLog('Session wallet derived from signature (deterministic)', 'success');
        addLog('Same wallet = Same session wallet, always!', 'info');

        console.log('[DEBUG derive] Returning keypair...');
        return keypair;
    } catch (err) {
        console.error('Failed to derive session wallet:', err);
        console.error('[DEBUG derive] Error stack:', err.stack);
        throw new Error('User denied signature request or Backpack error');
    }
}

// LEGACY: Get encryption key from Backpack signature (kept for old localStorage sessions)
async function getEncryptionKeyFromBackpack(backpackWallet) {
    const message = new TextEncoder().encode('x1-markets-session-wallet-encryption-v1');

    try {
        // Request signature from Backpack - this is a SECRET derived from private key
        const signature = await backpackWallet.signMessage(message);

        // Convert signature bytes to hex string for use as password
        const signatureHex = Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');
        return signatureHex;
    } catch (err) {
        console.error('Failed to get signature from Backpack:', err);
        throw new Error('User denied signature request or Backpack error');
    }
}

// Derive encryption key from password/passphrase
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: enc.encode('x1-markets-salt-v1'), // Static salt (OK for this use case)
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Encrypt data using AES-GCM
async function encryptData(data, password) {
    const key = await deriveKey(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        enc.encode(JSON.stringify(data))
    );

    // Return iv + encrypted data as base64
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode.apply(null, combined));
}

// Decrypt data using AES-GCM
async function decryptData(encryptedBase64, password) {
    try {
        const key = await deriveKey(password);
        const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );

        const dec = new TextDecoder();
        return JSON.parse(dec.decode(decrypted));
    } catch (err) {
        console.error('Decryption failed:', err);
        return null;
    }
}

function copySessionWallet() {
    if (!wallet) {
        addLog('No session wallet to copy', 'error');
        return;
    }

    const sessionAddr = wallet.publicKey.toString();

    // Copy to clipboard
    navigator.clipboard.writeText(sessionAddr).then(() => {
        addLog('Session wallet copied: ' + sessionAddr, 'success');

        // Visual feedback - change icon temporarily
        const copyBtn = document.querySelector('.copy-icon');
        if (copyBtn) {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✓';
            copyBtn.classList.add('copied');

            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.classList.remove('copied');
            }, 2000);
        }
    }).catch(err => {
        console.error('Failed to copy:', err);
        addLog('Failed to copy to clipboard', 'error');
        // Fallback: show prompt
        prompt('Copy session wallet address:', sessionAddr);
    });
}

function exportPrivateKey() {
    if (!wallet) {
        addLog('No session wallet to export', 'error');
        return;
    }

    // Get the private key as a byte array
    const privateKeyBytes = wallet.secretKey;

    // Convert to base58 string (standard Solana format)
    let privateKeyBase58;
    try {
        // Try to use the web3 library's base58 encoder
        const { PublicKey } = window.solanaWeb3;
        // Create a temporary file-like format with the byte array
        privateKeyBase58 = bs58encode(privateKeyBytes);
    } catch (err) {
        console.error('Base58 encoding error:', err);
        // Fallback: show as JSON array
        privateKeyBase58 = JSON.stringify(Array.from(privateKeyBytes));
        addLog('Showing private key as byte array (use solana-keygen for conversion)', 'warning');
    }

    // Create a modal/dialog to show the private key
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;

    modal.innerHTML = `
        <div style="
            background: #1a1a1a;
            border: 1px solid #3fb68b;
            border-radius: 12px;
            padding: 30px;
            max-width: 600px;
            width: 90%;
            box-shadow: 0 0 50px rgba(63, 182, 139, 0.3);
        ">
            <h2 style="color: #e8e8e8; margin: 0 0 20px 0; font-size: 18px; text-align: center;">
                🔑 Session Wallet Private Key
            </h2>
            <div style="
                background: #0a0a0a;
                border: 1px solid #252525;
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 20px;
                word-break: break-all;
                font-family: 'SF Mono', Monaco, Consolas, monospace;
                font-size: 12px;
                color: #3fb68b;
                user-select: all;
                cursor: text;
            " id="privateKeyDisplay">
                ${privateKeyBase58}
            </div>
            <div style="color: #ff5353; font-size: 12px; margin-bottom: 20px; text-align: center;">
                ⚠️ NEVER share this key with anyone! It gives full access to your wallet.
            </div>
            <div style="display: flex; gap: 10px;">
                <button onclick="copyPrivateKey('${privateKeyBase58}')" style="
                    flex: 1;
                    background: #3fb68b;
                    color: #000;
                    border: none;
                    border-radius: 6px;
                    padding: 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                ">
                    📋 Copy to Clipboard
                </button>
                <button onclick="closeExportModal()" style="
                    flex: 1;
                    background: transparent;
                    color: #888;
                    border: 1px solid #252525;
                    border-radius: 6px;
                    padding: 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                ">
                    Close
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.id = 'exportModal';

    addLog('Private key exported. Keep it safe!', 'warning');
}

function copyPrivateKey(privateKey) {
    navigator.clipboard.writeText(privateKey).then(() => {
        addLog('Private key copied to clipboard!', 'success');
    }).catch(err => {
        addLog('Failed to copy: ' + err.message, 'error');
    });
}

function closeExportModal() {
    const modal = document.getElementById('exportModal');
    if (modal) {
        modal.remove();
    }
}

// Enable/disable action buttons based on wallet connection
function disableActionButtons() {
    // Trading buttons
    const buttons = [
        'buyTab', 'sellTab',           // Buy/Sell tabs
        'yesBtn', 'noBtn',              // YES/NO outcome buttons
        'modeShares', 'modeXnt',        // Shares/XNT mode toggle
        'tradeBtn'                       // Execute trade button
    ];

    buttons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = true;
            btn.classList.add('disabled');
        }
    });

    // Quick amount buttons (shares and XNT)
    const quickButtons = document.querySelectorAll('.quick-amounts button');
    quickButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.add('disabled');
    });
}

function enableActionButtons() {
    // Trading buttons
    const buttons = [
        'buyTab', 'sellTab',
        'yesBtn', 'noBtn',
        'modeShares', 'modeXnt',
        'tradeBtn'
    ];

    buttons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('disabled');
        }
    });

    // Quick amount buttons
    const quickButtons = document.querySelectorAll('.quick-amounts button');
    quickButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('disabled');
    });
}

function showNoWallet() {
    // Nav bar
    if (document.getElementById('walletNavDisconnected')) {
        document.getElementById('walletNavDisconnected').classList.remove('hidden');
        document.getElementById('walletNavConnected').classList.add('hidden');
    }

    // Sidebar
    if (document.getElementById('sidebarWalletDisconnected')) {
        document.getElementById('sidebarWalletDisconnected').classList.remove('hidden');
        document.getElementById('sidebarWalletConnected').classList.add('hidden');
    }

    // Position & Status
    if (document.getElementById('positionStatusDisconnected')) {
        document.getElementById('positionStatusDisconnected').classList.remove('hidden');
        document.getElementById('positionStatusConnected').classList.add('hidden');
    }

    // Disable all action buttons when no wallet connected
    disableActionButtons();

    // Reset position shares
    userYesShares = 0;
    userNoShares = 0;
    validateSellButtons();
}

function showHasWallet(backpackAddr) {
    console.log('[DEBUG showHasWallet] Called with backpackAddr:', backpackAddr);
    console.log('[DEBUG showHasWallet] wallet object:', wallet);

    if (!wallet) {
        console.error('showHasWallet called but wallet is null');
        return;
    }

    const sessionAddr = wallet.publicKey.toString();
    const shortAddr = sessionAddr.substring(0, 8) + '...' + sessionAddr.substring(sessionAddr.length - 4);

    console.log('[DEBUG showHasWallet] sessionAddr:', sessionAddr);
    console.log('[DEBUG showHasWallet] shortAddr:', shortAddr);

    // Nav bar
    const navWalletAddr = document.getElementById('navWalletAddr');
    console.log('[DEBUG showHasWallet] navWalletAddr element:', navWalletAddr);
    if (navWalletAddr) {
        navWalletAddr.textContent = shortAddr;
        document.getElementById('walletNavDisconnected').classList.add('hidden');
        document.getElementById('walletNavConnected').classList.remove('hidden');
        console.log('[DEBUG showHasWallet] Nav bar updated');
    }

    // Sidebar
    const sessionAddrElement = document.getElementById('sessionAddr');
    console.log('[DEBUG showHasWallet] sessionAddr element:', sessionAddrElement);
    if (sessionAddrElement) {
        sessionAddrElement.textContent = sessionAddr;
        document.getElementById('sidebarWalletDisconnected').classList.add('hidden');
        document.getElementById('sidebarWalletConnected').classList.remove('hidden');
        console.log('[DEBUG showHasWallet] Sidebar updated, text content:', sessionAddrElement.textContent);
    }

    // Position & Status
    if (document.getElementById('positionStatusDisconnected')) {
        document.getElementById('positionStatusDisconnected').classList.add('hidden');
        document.getElementById('positionStatusConnected').classList.remove('hidden');
        console.log('[DEBUG showHasWallet] Position status updated');
    }

    // Enable all action buttons when wallet connected
    enableActionButtons();

    // Update Create User nav button visibility based on position existence
    updateCreateUserNavButton();

    // Start fetching user points
    startPointsPolling();

    console.log('[DEBUG showHasWallet] Function completed');
}

async function fetchPositionAccount() {
    if (!wallet) {
        return null;
    }

    try {
        const [ammPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array(CONFIG.AMM_SEED)],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const accountInfo = await connection.getAccountInfo(posPda);

        if (!accountInfo) {
//             console.log('[fetchPositionAccount] No position account found');
            return null;
        }

        const d = accountInfo.data;
//         console.log('[fetchPositionAccount] Account data length:', d.length, 'bytes (expected:', 8 + 89, ')');

        // Position struct: discriminator(8) + owner(32) + yes_shares_e6(8) + no_shares_e6(8) + master_wallet(32) + vault_balance_e6(8) + vault_bump(1)
        if (d.length >= 8 + 32 + 8 + 8 + 32 + 8) {
            let o = 8; // Skip discriminator
            o += 32; // Skip owner pubkey
            const sharesY = readI64LE(d, o); o += 8;
            const sharesN = readI64LE(d, o); o += 8;
            o += 32; // Skip master_wallet
            const vaultBalance = readI64LE(d, o); o += 8;

//             console.log('[fetchPositionAccount] Raw vault_balance_e6:', vaultBalance);
//             console.log('[fetchPositionAccount] Converted to XNT:', vaultBalance / 1e7);

            return {
                yes_shares_e6: sharesY,
                no_shares_e6: sharesN,
                vault_balance_e6: vaultBalance
            };
        }

//         console.log('[fetchPositionAccount] Account data too small');


        return null;
    } catch (err) {
        console.error('Failed to fetch position account:', err);
        return null;
    }
}

async function updateWalletBalance() {
    if (!wallet) {
        console.log('No wallet to update balance');
        return;
    }

    try {
        // Get vault balance from Position account (this is the tradeable balance)
        const position = await fetchPositionAccount();
        let vaultBalance = 0;

        if (position && position.vault_balance_e6 !== undefined) {
            // vault_balance_e6 uses LAMPORTS_PER_E6 = 100, so 1 XNT = 10_000_000 e6 units
            vaultBalance = position.vault_balance_e6 / 1e7;
        }

        const solBalance = vaultBalance.toFixed(4);
        const solBalanceShort = vaultBalance.toFixed(2);
        const balanceNum = vaultBalance;

        // Set global wallet balance for trading functions
        window.walletBalance = vaultBalance;

        // Update slider max based on new balance
        updateSliderMax();

        // Update nav bar
        if (document.getElementById('navWalletBal')) {
            document.getElementById('navWalletBal').textContent = solBalanceShort;
        }

        // Update sidebar (showing vault balance, not session wallet)
        if (document.getElementById('walletBal')) {
            document.getElementById('walletBal').textContent = solBalance;
        }

        // Security warning for high balances in SESSION WALLET (not trading account)
        // Session wallet is for TX fees only, should be small
        const WARNING_THRESHOLD = 100; // 100 XNT
        const lastWarningKey = 'btc_market_balance_warning_shown';
        const lastWarningTime = localStorage.getItem(lastWarningKey);
        const now = Date.now();

        // Check actual session wallet on-chain balance (lamports), not trading vault
        if (wallet && wallet.publicKey) {
            try {
                const sessionWalletLamports = await connection.getBalance(wallet.publicKey);
                const sessionWalletXNT = sessionWalletLamports / 1e9;

                // Show warning if session wallet balance > threshold and no warning shown in last 24h
                if (sessionWalletXNT > WARNING_THRESHOLD) {
                    if (!lastWarningTime || (now - parseInt(lastWarningTime)) > 24 * 60 * 60 * 1000) {
                        showBalanceWarning(sessionWalletXNT);
                        localStorage.setItem(lastWarningKey, now.toString());
                    }
                }
            } catch (err) {
                console.error('Failed to check session wallet balance for warning:', err);
            }
        }
    } catch (err) {
        console.error('Failed to get balance:', err);
    }
}

function showBalanceWarning(balance) {
    const warning = `
⚠️ SECURITY WARNING ⚠️

Your session wallet has ${balance.toFixed(2)} XNT.

Session wallets are stored in your browser and are meant for small amounts only.

Recommendation:
• Keep < 100 XNT in session wallets
• Withdraw excess to your wallet
• Session wallets are less secure than hardware wallets

This is a temporary wallet for trading only.
    `.trim();

    console.warn(warning);
    addLog(`⚠️ High balance warning: ${balance.toFixed(2)} XNT in session wallet`, 'warning');
}

// Update shares slider max based on vault balance and current price
function updateSliderMax() {
    const slider = document.getElementById('sharesSlider');
    if (!slider) return;

    const balance = window.walletBalance || 0;
    if (balance <= 0) {
        slider.max = 0;
        return;
    }

    // Get current price for selected side (currentSide is 'yes' or 'no' lowercase)
    const side = (typeof currentSide !== 'undefined' ? currentSide : 'yes').toLowerCase();
    let price = side === 'yes' ? currentYesPrice : currentNoPrice;

    // Fallback to UI if global price not set
    if (!price || price <= 0) {
        const priceEl = document.getElementById(side === 'yes' ? 'yesBtnPrice' : 'noBtnPrice');
        price = priceEl ? parseFloat(priceEl.textContent) : 0.5;
    }

    if (price <= 0) {
        slider.max = 500; // Default fallback
        return;
    }

    // Calculate max shares with small buffer for fees/slippage
    const safeBalance = balance * 0.98;
    const maxShares = Math.floor(safeBalance / price);

    // Cap at reasonable maximum (500) but allow less if balance is low
    slider.max = Math.min(Math.max(maxShares, 0), 500);

    // Also clamp current value if it exceeds new max
    if (parseInt(slider.value) > parseInt(slider.max)) {
        slider.value = slider.max;
        const input = document.getElementById('tradeAmountShares');
        if (input) input.value = slider.max;
    }
}

// ============= BTC PRICE CHART =============

// Note: Price saving is now handled by server.js polling the oracle directly
// This function is no longer needed but kept as a no-op for backwards compatibility
async function savePriceToServer(price) {
    // No-op: Server now fetches and saves prices directly from oracle
    return;
}

// Load price history from server
async function loadPriceHistory(seconds = null) {
    try {
        console.log(`📊 LOAD HISTORY - Requesting ${seconds || 'all'} seconds of data`);
        // Build URL with optional time range parameter
        const url = seconds ? `/api/price-history?seconds=${seconds}` : '/api/price-history';
        const response = await fetch(url);
        if (!response.ok) {
            console.warn('Failed to load price history from server:', response.status);
            return;
        }

        const data = await response.json();
        if (data.prices && Array.isArray(data.prices)) {
            // Extract just the price values (server stores {price, timestamp} objects)
            let rawPrices = data.prices.map(item => {
                return typeof item === 'number' ? item : item.price;
            });

            console.log(`📊 LOAD HISTORY - Loaded ${rawPrices.length} price points from server (total available: ${data.totalPoints || rawPrices.length})`);

            // Remove outliers to prevent chart rendering issues
            const beforeOutliers = rawPrices.length;
            priceHistory = removeOutliers(rawPrices, 3);
            console.log(`📊 LOAD HISTORY - After outlier removal: ${priceHistory.length} points (removed ${beforeOutliers - priceHistory.length} outliers)`);

            // Update chart if already initialized
            if (btcChart && priceHistory.length > 0) {
                console.log(`📊 LOAD HISTORY - Rebuilding chart from ${priceHistory.length} history points`);
                // Rebuild high-resolution chart data from price history
                rebuildChartFromHistory();
            }
        }
    } catch (err) {
        console.warn('Failed to load price history from server:', err);
    }
}

// Available time ranges (in order for cycling)
const TIME_RANGES = [60, 300, 900, 1800, 3600, 21600, 86400];
let currentTimeRangeIndex = 0; // Start at 1m (60 seconds)
let isChangingTimeRange = false; // Lock to prevent overlapping time range changes

// Toggle time range dropdown menu
function toggleTimeRangeDropdown() {
    const menu = document.getElementById('timeRangeMenu');
    const trigger = document.querySelector('.timerange-dropdown-trigger');

    if (menu && trigger) {
        const isOpen = menu.classList.contains('show');

        if (isOpen) {
            menu.classList.remove('show');
            trigger.classList.remove('active');
        } else {
            menu.classList.add('show');
            trigger.classList.add('active');
        }
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.querySelector('.chart-timerange-dropdown');
    const menu = document.getElementById('timeRangeMenu');
    const trigger = document.querySelector('.timerange-dropdown-trigger');

    if (dropdown && menu && trigger && !dropdown.contains(e.target)) {
        menu.classList.remove('show');
        trigger.classList.remove('active');
    }
});

// Select a specific time range
async function selectTimeRange(seconds) {
    // Prevent overlapping time range changes
    if (isChangingTimeRange) {
        console.log(`⚠️ SELECT TIME RANGE - Already changing, ignoring request for ${seconds}s`);
        return;
    }

    isChangingTimeRange = true;
    console.log(`📊 SELECT TIME RANGE - Switching to ${seconds}s`);

    try {
        // Update active option in dropdown
        document.querySelectorAll('.timerange-option').forEach(opt => {
            opt.classList.remove('active');
        });
        const activeOpt = document.querySelector(`.timerange-option[data-seconds="${seconds}"]`);
        console.log(`📊 SELECT TIME RANGE - Found option element:`, activeOpt ? `"${activeOpt.textContent}"` : 'NOT FOUND');

        if (activeOpt) {
            activeOpt.classList.add('active');
        }

        // Update displayed value in trigger
        const selectedDisplay = document.getElementById('selectedTimeRange');
        if (selectedDisplay) {
            const newText = activeOpt ? activeOpt.textContent : seconds;
            console.log(`📊 SELECT TIME RANGE - Updating label from "${selectedDisplay.textContent}" to "${newText}"`);
            selectedDisplay.textContent = newText;
        } else {
            console.warn('📊 SELECT TIME RANGE - selectedTimeRange element NOT FOUND');
        }

    // Close dropdown
    const menu = document.getElementById('timeRangeMenu');
    const trigger = document.querySelector('.timerange-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.remove('show');
        trigger.classList.remove('active');
    }

    // Update current index
    currentTimeRangeIndex = TIME_RANGES.indexOf(seconds);

    // Load data
    currentTimeRange = parseInt(seconds);
    await loadPriceHistory(currentTimeRange);

    // Recalculate sampling rate for the new time range
    // Note: interpolation state is reset inside rebuildChartFromHistory() for atomic updates
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);
    console.log(`Time range changed to ${seconds}s - Sampling rate: ${currentSamplingRate} (${effectivePointsPerSecond.toFixed(2)} points/sec)`);
    } finally {
        // Always release the lock
        isChangingTimeRange = false;
        console.log(`✅ SELECT TIME RANGE - Completed, lock released`);
    }
}

// Cycle to next time range (for chart click)
async function cycleTimeRange() {
    // Don't increment index if already changing (will be ignored anyway)
    if (isChangingTimeRange) {
        console.log(`⚠️ CYCLE - Already changing, skipping cycle`);
        return;
    }

    const prevIndex = currentTimeRangeIndex;
    currentTimeRangeIndex = (currentTimeRangeIndex + 1) % TIME_RANGES.length;
    const nextRange = TIME_RANGES[currentTimeRangeIndex];
    console.log(`🔄 CYCLE - From index ${prevIndex} (${TIME_RANGES[prevIndex]}s) → ${currentTimeRangeIndex} (${nextRange}s)`);
    console.log(`🔄 CYCLE - All ranges: ${TIME_RANGES.join(', ')}`);
    await selectTimeRange(nextRange);
}

// Toggle chart style - toggles between: area ↔ candlestick
function toggleChartStyle() {
    // Toggle between line and line-colored
    chartStyle = chartStyle === 'line' ? 'line-colored' : 'line';

    // Save preference to localStorage
    try {
        localStorage.setItem(CHART_STYLE_KEY, chartStyle);
    } catch (err) {
        console.warn('Failed to save chart style preference:', err);
    }

    // Update button visual state
    const toggleBtn = document.querySelector('.chart-style-toggle');
    if (toggleBtn) {
        if (chartStyle === 'line-colored') {
            toggleBtn.classList.add('active');
            toggleBtn.title = 'Colored Line (Click for Solid)';
        } else {
            toggleBtn.classList.remove('active');
            toggleBtn.title = 'Solid Line (Click for Colored)';
        }
    }

    // Rebuild chart with new style
    if (btcChart) {
        rebuildChartWithNewStyle();
    }

    console.log('Chart style:', chartStyle);
}

// Toggle price-to-beat line visibility
function togglePriceToBeatLine() {
    showPriceToBeatLine = !showPriceToBeatLine;

    // Save preference to localStorage
    const PRICE_LINE_KEY = 'showPriceToBeatLine';
    try {
        localStorage.setItem(PRICE_LINE_KEY, showPriceToBeatLine);
    } catch (err) {
        console.warn('Failed to save price line preference:', err);
    }

    // Update button visual state
    const toggleBtn = document.getElementById('priceToBeatToggle');
    if (toggleBtn) {
        if (showPriceToBeatLine) {
            toggleBtn.classList.add('active');
            toggleBtn.title = 'Hide price to beat line';
        } else {
            toggleBtn.classList.remove('active');
            toggleBtn.title = 'Show price to beat line';
        }
    }

    // Redraw chart to show/hide the line
    if (btcChart) {
        btcChart.update('none'); // Update without animation
    }

    console.log('Price to beat line:', showPriceToBeatLine ? 'visible' : 'hidden');
}

// Rebuild chart when switching between area and candlestick
function rebuildChartWithNewStyle() {
    if (!btcChart) return;

    console.log(`🎨 Updating chart style to: ${chartStyle}`);

    // Just update the style without destroying the chart
    // This preserves all the high-resolution chartDataPoints
    updateChartStyle();
}

// Update chart segment styles based on current style preference
function updateChartStyle() {
    if (!btcChart) return;

    const dataset = btcChart.data.datasets[0];

    if (chartStyle === 'line-colored') {
        // Colored line: dynamic colors based on price movement
        dataset.segment = {
            borderColor: ctx => {
                const chart = ctx.chart;
                const dataset = chart.data.datasets[0];
                const p0 = dataset.data[ctx.p0DataIndex];
                const p1 = dataset.data[ctx.p1DataIndex];
                if (p0 === null || p1 === null) return '#00c896';
                return p1 >= p0 ? '#00c896' : '#ff5353';
            },
            backgroundColor: ctx => {
                const chart = ctx.chart;
                const dataset = chart.data.datasets[0];
                const p0 = dataset.data[ctx.p0DataIndex];
                const p1 = dataset.data[ctx.p1DataIndex];
                if (p0 === null || p1 === null) return 'rgba(0, 200, 150, 0.1)';
                return p1 >= p0 ? 'rgba(0, 200, 150, 0.1)' : 'rgba(255, 83, 83, 0.1)';
            }
        };
    } else {
        // Solid line: use red if below price to beat, green otherwise
        dataset.segment = {
            borderColor: ctx => {
                const chart = ctx.chart;
                const dataset = chart.data.datasets[0];
                const p1 = dataset.data[ctx.p1DataIndex];

                // If we have a market start price (price to beat) and current price is below it, use red
                if (marketStartPrice && p1 !== null && p1 < marketStartPrice) {
                    return '#ff5353';
                }
                return '#00c896';
            },
            backgroundColor: ctx => {
                const chart = ctx.chart;
                const dataset = chart.data.datasets[0];
                const p1 = dataset.data[ctx.p1DataIndex];

                // Match background to border color
                if (marketStartPrice && p1 !== null && p1 < marketStartPrice) {
                    return 'rgba(255, 83, 83, 0.1)';
                }
                return 'rgba(0, 200, 150, 0.1)';
            }
        };
    }

    btcChart.update('none');
}

// Load chart style preference from localStorage
function loadChartStylePreference() {
    try {
        const saved = localStorage.getItem(CHART_STYLE_KEY);
        if (saved && CHART_STYLES.includes(saved)) {
            chartStyle = saved;
            console.log('Loaded chart style preference:', saved);
        }

        // Update button state
        const toggleBtn = document.querySelector('.chart-style-toggle');
        if (toggleBtn) {
            if (chartStyle === 'line-colored') {
                toggleBtn.classList.add('active');
                toggleBtn.title = 'Colored Line (Click for Solid)';
            } else {
                toggleBtn.classList.remove('active');
                toggleBtn.title = 'Solid Line (Click for Colored)';
            }
        }
    } catch (err) {
        console.warn('Failed to load chart style preference:', err);
    }
}

// Load price line visibility preference from localStorage
function loadPriceLinePreference() {
    const PRICE_LINE_KEY = 'showPriceToBeatLine';
    try {
        const saved = localStorage.getItem(PRICE_LINE_KEY);
        if (saved !== null) {
            showPriceToBeatLine = saved === 'true';
            console.log('Loaded price line preference:', showPriceToBeatLine);
        }

        // Update button state
        const toggleBtn = document.getElementById('priceToBeatToggle');
        if (toggleBtn) {
            if (showPriceToBeatLine) {
                toggleBtn.classList.add('active');
                toggleBtn.title = 'Hide price to beat line';
            } else {
                toggleBtn.classList.remove('active');
                toggleBtn.title = 'Show price to beat line';
            }
        }
    } catch (err) {
        console.warn('Failed to load price line preference:', err);
    }
}

// Generate time labels for chart X-axis
function generateTimeLabels(numPoints, timeRangeSeconds) {
    const labels = [];
    const now = Date.now();
    const msPerPoint = timeRangeSeconds ? (timeRangeSeconds * 1000) / numPoints : (60 * 1000) / numPoints;

    for (let i = 0; i < numPoints; i++) {
        const timestamp = now - (numPoints - i) * msPerPoint;
        const date = new Date(timestamp);
        const seconds = date.getSeconds().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const hours = date.getHours().toString().padStart(2, '0');

        // Show different formats based on time range
        if (!timeRangeSeconds || timeRangeSeconds <= 300) {
            // For <= 5 minutes, show MM:SS
            labels.push(`${minutes}:${seconds}`);
        } else if (timeRangeSeconds <= 3600) {
            // For <= 1 hour, show HH:MM
            labels.push(`${hours}:${minutes}`);
        } else if (timeRangeSeconds <= 86400) {
            // For 24 hours, show HH:MM (every few hours will have a date marker naturally)
            labels.push(`${hours}:${minutes}`);
        } else {
            // For > 24 hours, show HH:MM
            labels.push(`${hours}:${minutes}`);
        }
    }

    return labels;
}

// Get human-readable label for time range
function getTimeRangeLabel(seconds) {
    if (!seconds) return 'ALL';
    if (seconds === 60) return '1m';
    if (seconds === 300) return '5m';
    if (seconds === 900) return '15m';
    if (seconds === 1800) return '30m';
    if (seconds === 3600) return '1h';
    if (seconds === 21600) return '6h';
    if (seconds === 86400) return '24h';
    return `${seconds}s`;
}

// Rebuild high-resolution chart data from price history
function rebuildChartFromHistory() {
    if (priceHistory.length === 0) return;

    // Check if we have enough data for the current time range
    const requiredSeconds = currentTimeRange || 60;
    if (priceHistory.length < requiredSeconds * 0.5) { // Warn if we have less than 50% of required data
        const hoursAvailable = (priceHistory.length / 3600).toFixed(1);
        const hoursRequired = (requiredSeconds / 3600).toFixed(1);
        console.warn(`⚠️ INSUFFICIENT DATA: Have ${hoursAvailable}h, showing ${getTimeRangeLabel(currentTimeRange)} (${hoursRequired}h). Chart will fill as data accumulates.`);
    }

    // Calculate optimal sampling rate for current time range
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);

    const oldPointsCount = chartDataPoints.length;
    console.log(`🔴 REBUILD CHART - Had ${oldPointsCount} points, rebuilding with ${priceHistory.length} history points, sampling rate: ${currentSamplingRate}`);

    chartDataPoints = [];

    console.log(`📊 REBUILD DEBUG - Starting with ${priceHistory.length} history points`);
    console.log(`📊 REBUILD DEBUG - Time range: ${currentTimeRange}s, Sampling rate: ${currentSamplingRate}`);

    // Calculate total raw points we would have without sampling
    const totalRawPoints = priceHistory.length * BASE_POINTS_PER_SECOND;
    console.log(`📊 REBUILD DEBUG - Total raw points (before sampling): ${Math.floor(totalRawPoints)}`);

    // Interpolate between historical prices to create smooth chart
    // Apply sampling by only creating every Nth point
    let totalPointsCreated = 0;

    // Optimized: Calculate which points to create without iterating through skipped ones
    const targetPoints = Math.floor(totalRawPoints / currentSamplingRate);
    console.log(`📊 REBUILD DEBUG - Target points after sampling: ${targetPoints}`);

    for (let sampledIdx = 0; sampledIdx < targetPoints; sampledIdx++) {
        // Calculate the global point index this sampled point represents
        const globalPointIndex = sampledIdx * currentSamplingRate;

        // Convert global point index to history index and sub-point index
        const historyIndex = Math.floor(globalPointIndex / BASE_POINTS_PER_SECOND);
        const subPointIndex = globalPointIndex % BASE_POINTS_PER_SECOND;

        // Don't exceed history bounds
        if (historyIndex >= priceHistory.length) break;

        const currentPrice = priceHistory[historyIndex];
        const nextPrice = historyIndex < priceHistory.length - 1 ? priceHistory[historyIndex + 1] : currentPrice;

        // Interpolate between current and next price
        const t = subPointIndex / BASE_POINTS_PER_SECOND;
        const interpolatedPrice = currentPrice + (nextPrice - currentPrice) * t;
        chartDataPoints.push(interpolatedPrice);
        totalPointsCreated++;
    }

    console.log(`📊 REBUILD DEBUG - Created ${totalPointsCreated} interpolated points from ${priceHistory.length} history points`);
    console.log(`📊 REBUILD DEBUG - Points per history item: ${(totalPointsCreated / priceHistory.length).toFixed(2)}`);
    console.log(`📊 REBUILD DEBUG - Reduction factor: ${(totalRawPoints / totalPointsCreated).toFixed(2)}x`)

    // Calculate max points based on current time range with effective rate
    const maxPoints = currentTimeRange
        ? Math.floor(currentTimeRange * effectivePointsPerSecond)
        : Math.min(chartDataPoints.length, MAX_CHART_POINTS);

    console.log(`📊 REBUILD DEBUG - Max points allowed: ${maxPoints}`);
    console.log(`📊 REBUILD DEBUG - Chart data points before trim: ${chartDataPoints.length}`);

    // Keep only last maxPoints
    if (chartDataPoints.length > maxPoints) {
        const beforeTrim = chartDataPoints.length;
        chartDataPoints = chartDataPoints.slice(-maxPoints);
        console.log(`📊 REBUILD DEBUG - Trimmed ${beforeTrim - chartDataPoints.length} points (${beforeTrim} → ${chartDataPoints.length})`);
    }

    console.log(`📊 REBUILD DEBUG - Final chart data points: ${chartDataPoints.length}`);

    // Update chart
    if (btcChart) {
        // Use actual data size if we don't have enough data to fill the time range
        const actualPoints = chartDataPoints.length;
        const displayPoints = actualPoints < maxPoints ? actualPoints : maxPoints;

        // Calculate time range based on actual data
        const actualTimeRange = actualPoints < maxPoints
            ? (actualPoints / effectivePointsPerSecond)
            : currentTimeRange;

        console.log(`📊 REBUILD DEBUG - Display points: ${displayPoints} (max: ${maxPoints}, actual: ${actualPoints})`);

        btcChart.data.labels = generateTimeLabels(displayPoints, actualTimeRange);
        btcChart.data.datasets[0].data = chartDataPoints;
        console.log(`📊 REBUILD DEBUG - Final array sent to chart: ${chartDataPoints.length} points (all non-null)`);
        btcChart.update('none');

        // Reset interpolation state immediately after rebuild to avoid stale state during update loop
        // CRITICAL: currentTargetPrice already has the latest real-time price from live updates
        // We just need to sync lastActualPrice to it to avoid any interpolation catch-up delay
        if (chartDataPoints.length > 0 && currentTargetPrice !== null) {
            // Use the current real-time target price, don't overwrite with historical data
            // This prevents the 8-second catch-up delay when switching time ranges
            lastActualPrice = currentTargetPrice;
            console.log(`📊 INTERPOLATION RESET - Synced to current real-time price: ${currentTargetPrice.toFixed(2)}`);
        } else if (chartDataPoints.length > 0 && priceHistory.length > 0) {
            // Fallback: if no current target (initial load), initialize from historical data
            // This ensures the chart animates immediately even before live stream connects
            const lastHistoricalPrice = priceHistory[priceHistory.length - 1];
            lastActualPrice = lastHistoricalPrice;
            currentTargetPrice = lastHistoricalPrice;
            console.log(`📊 INTERPOLATION RESET - Initialized from historical: ${currentTargetPrice.toFixed(2)}`);
        }

        // Reset update counter to align live sampling with rebuilt chart
        // This ensures smooth updates immediately after time range change
        chartUpdateCounter = 0;
        console.log(`📊 UPDATE COUNTER RESET - Aligned live sampling to rebuilt chart`);
    }
}

function initBTCChart() {
    const ctx = document.getElementById('btcChart');
    if (!ctx) {
        console.log('BTC Chart canvas not found');
        return;
    }

    // Check if Chart.js is loaded
    if (typeof Chart === 'undefined') {
        console.error('Chart.js not loaded yet! Retrying in 500ms...');
        setTimeout(initBTCChart, 500);
        return;
    }

    console.log('Initializing BTC Chart...');

    // Load user preferences from localStorage
    loadChartStylePreference();
    loadPriceLinePreference();

    // Calculate optimal sampling for initial chart setup
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);

    // Initialize with empty data (using effective sampling rate)
    const initialPoints = currentTimeRange ? Math.floor(currentTimeRange * effectivePointsPerSecond) : Math.floor(60 * effectivePointsPerSecond);
    const initialTimeRange = currentTimeRange || 60;
    const labels = generateTimeLabels(initialPoints, initialTimeRange);
    const data = Array(initialPoints).fill(null);

    console.log(`Chart initialized: ${initialPoints} points, ${effectivePointsPerSecond.toFixed(2)} points/sec, sampling rate: ${currentSamplingRate}`);

    // Custom plugin to draw min/max labels on the chart
    const minMaxPlugin = {
        id: 'minMaxLabels',
        afterDatasetsDraw(chart) {
            const ctx = chart.ctx;
            const dataset = chart.data.datasets[0];
            const dataValues = dataset.data;

            // Filter out null values and find min/max
            const validData = dataValues.map((val, idx) => ({ val, idx })).filter(item => item.val !== null && item.val !== undefined);
            if (validData.length === 0) return;

            const minItem = validData.reduce((min, item) => item.val < min.val ? item : min);
            const maxItem = validData.reduce((max, item) => item.val > max.val ? item : max);

            const meta = chart.getDatasetMeta(0);
            const yScale = chart.scales.y;

            // Draw max label (green)
            if (meta.data[maxItem.idx]) {
                const point = meta.data[maxItem.idx];
                const x = point.x;
                const y = point.y;

                ctx.save();
                ctx.font = 'bold 11px "SF Mono", Monaco, monospace';
                ctx.fillStyle = '#00ff00';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';

                const maxText = '$' + maxItem.val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const textWidth = ctx.measureText(maxText).width;
                const padding = 6;

                // Background for better readability
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(x + 4, y - 18, textWidth + padding * 2, 16);

                // Text
                ctx.fillStyle = '#00ff00';
                ctx.fillText(maxText, x + 4 + padding, y - 4);

                ctx.restore();
            }

            // Draw min label (red)
            if (meta.data[minItem.idx]) {
                const point = meta.data[minItem.idx];
                const x = point.x;
                const y = point.y;

                ctx.save();
                ctx.font = 'bold 11px "SF Mono", Monaco, monospace';
                ctx.fillStyle = '#ff5353';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';

                const minText = '$' + minItem.val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const textWidth = ctx.measureText(minText).width;
                const padding = 6;

                // Background for better readability
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(x + 4, y + 2, textWidth + padding * 2, 16);

                // Text
                ctx.fillStyle = '#ff5353';
                ctx.fillText(minText, x + 4 + padding, y + 4);

                ctx.restore();
            }
        }
    };

    // Custom plugin to draw glowing green dot on the last price
    const lastPriceGlowPlugin = {
        id: 'lastPriceGlow',
        afterDatasetsDraw(chart) {
            const ctx = chart.ctx;
            const meta = chart.getDatasetMeta(0);

            // Always use the very last point in the dataset (regardless of interpolation)
            if (!meta.data || meta.data.length === 0) return;

            const lastPoint = meta.data[meta.data.length - 1];
            if (!lastPoint) return;

            const x = lastPoint.x;
            const y = lastPoint.y;

            ctx.save();

            // Draw multiple circles for glow effect (from outer to inner)
            const glowLayers = [
                { radius: 8, alpha: 0.15 },
                { radius: 6, alpha: 0.25 },
                { radius: 4, alpha: 0.35 },
                { radius: 2.5, alpha: 0.5 }
            ];

            // Draw glow layers only
            glowLayers.forEach(layer => {
                ctx.beginPath();
                ctx.arc(x, y, layer.radius, 0, 2 * Math.PI);
                ctx.fillStyle = `rgba(0, 255, 0, ${layer.alpha})`;
                ctx.fill();
            });

            ctx.restore();
        }
    };

    // Custom plugin to draw price-to-beat horizontal line
    const priceToBeatLinePlugin = {
        id: 'priceToBeatLine',
        afterDatasetsDraw(chart) {
            if (!showPriceToBeatLine || !marketStartPrice || marketStartPrice <= 0) return;

            const ctx = chart.ctx;
            const yScale = chart.scales.y;
            const xScale = chart.scales.x;

            // Calculate Y position for the market start price
            const yPos = yScale.getPixelForValue(marketStartPrice);

            // Only draw if the price is within the visible range
            if (yPos < yScale.top || yPos > yScale.bottom) return;

            ctx.save();

            // Draw dashed horizontal line
            ctx.strokeStyle = '#ffa500'; // Orange color for visibility
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]); // Dashed line pattern

            ctx.beginPath();
            ctx.moveTo(xScale.left, yPos);
            ctx.lineTo(xScale.right, yPos);
            ctx.stroke();

            // Draw label on the right side
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.font = 'bold 11px "SF Mono", Monaco, monospace';

            const labelText = '$' + marketStartPrice.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            const textWidth = ctx.measureText(labelText).width;
            const padding = 6;

            // Background box for label
            ctx.fillRect(xScale.right - textWidth - padding * 2 - 4, yPos - 9, textWidth + padding * 2, 18);

            // Text
            ctx.fillStyle = '#ffa500';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, xScale.right - 4 - padding, yPos);

            ctx.restore();
        }
    };

    btcChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'BTC Price',
                data: data,
                borderColor: '#00c896',
                backgroundColor: 'rgba(0, 200, 150, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.5, // Higher tension for smoother curves
                pointRadius: 0,
                pointHoverRadius: 0,
                pointHitRadius: 0,
                pointBorderWidth: 0,
                pointHoverBorderWidth: 0,
                segment: chartStyle === 'line-colored' ? {
                    borderColor: ctx => {
                        // Color each segment based on price movement
                        const chart = ctx.chart;
                        const dataset = chart.data.datasets[0];
                        const p0 = dataset.data[ctx.p0DataIndex];
                        const p1 = dataset.data[ctx.p1DataIndex];

                        // Skip if either point is null
                        if (p0 === null || p1 === null) return '#00c896';

                        // Green if price going up, red if going down
                        return p1 >= p0 ? '#00c896' : '#ff5353';
                    },
                    backgroundColor: ctx => {
                        // Match background gradient to segment color
                        const chart = ctx.chart;
                        const dataset = chart.data.datasets[0];
                        const p0 = dataset.data[ctx.p0DataIndex];
                        const p1 = dataset.data[ctx.p1DataIndex];

                        if (p0 === null || p1 === null) return 'rgba(0, 200, 150, 0.1)';

                        return p1 >= p0 ? 'rgba(0, 200, 150, 0.1)' : 'rgba(255, 83, 83, 0.1)';
                    }
                } : {
                    borderColor: ctx => {
                        const chart = ctx.chart;
                        const dataset = chart.data.datasets[0];
                        const p1 = dataset.data[ctx.p1DataIndex];

                        // If we have a market start price (price to beat) and current price is below it, use red
                        if (marketStartPrice && p1 !== null && p1 < marketStartPrice) {
                            return '#ff5353';
                        }
                        return '#00c896';
                    },
                    backgroundColor: ctx => {
                        const chart = ctx.chart;
                        const dataset = chart.data.datasets[0];
                        const p1 = dataset.data[ctx.p1DataIndex];

                        // Match background to border color
                        if (marketStartPrice && p1 !== null && p1 < marketStartPrice) {
                            return 'rgba(255, 83, 83, 0.1)';
                        }
                        return 'rgba(0, 200, 150, 0.1)';
                    }
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'nearest',
                axis: 'x'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: window.innerWidth > 768,  // Disable on mobile (≤768px)
                    position: 'nearest',
                    backgroundColor: 'rgba(0, 0, 0, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#00c896',
                    borderColor: '#00c896',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    yAlign: 'bottom',
                    xAlign: 'center',
                    caretSize: 6,
                    callbacks: {
                        title: () => 'BTC Price',
                        label: (context) => {
                            // Skip null values (padding at start of chart)
                            if (context.parsed.y === null || context.parsed.y === undefined) {
                                return null;
                            }
                            const price = context.parsed.y;
                            return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        }
                    },
                    filter: (tooltipItem) => {
                        // Don't show tooltip for null data points
                        return tooltipItem.parsed.y !== null && tooltipItem.parsed.y !== undefined;
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: {
                        color: 'rgba(139, 146, 168, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#5a6178',
                        font: {
                            family: "'SF Mono', Monaco, monospace",
                            size: 10
                        },
                        maxTicksLimit: 8,
                        autoSkip: true,
                        callback: function(value, index) {
                            // Show time label for this tick
                            const label = this.getLabelForValue(value);
                            return label;
                        }
                    }
                },
                y: {
                    display: true,
                    position: 'right',
                    beginAtZero: false,
                    grid: {
                        color: 'rgba(139, 146, 168, 0.1)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#5a6178',
                        font: {
                            family: "'SF Mono', Monaco, monospace",
                            size: 11
                        },
                        callback: function(value) {
                            return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
                        },
                        maxTicksLimit: 6
                    }
                }
            },
            animation: {
                duration: 300, // Smooth animation for Y-axis scale changes
                easing: 'easeInOutQuart' // Smooth easing function
            }
        },
        plugins: [minMaxPlugin, lastPriceGlowPlugin, priceToBeatLinePlugin]
    });

    console.log('BTC Chart initialized successfully!');

    // Add click handler to chart canvas for cycling time ranges
    const canvas = document.getElementById('btcChart');
    if (canvas) {
        canvas.addEventListener('click', async (e) => {
            console.log('🖱️ Chart canvas clicked at:', e.offsetX, e.offsetY);
            await cycleTimeRange();
        });
    }

    // Populate chart with historical data if available
    if (priceHistory.length > 0) {
        rebuildChartFromHistory();
        console.log('Chart initialized with', priceHistory.length, 'seconds of historical data');
    } else {
        console.log('Chart initialized empty - waiting for price history');
    }

    // Start the smooth scrolling update loop
    startChartUpdateLoop();
}

// Continuous chart update loop for butter-smooth scrolling
function startChartUpdateLoop() {
    if (chartUpdateTimer) {
        clearInterval(chartUpdateTimer);
    }

    chartUpdateCounter = 0; // Reset global counter for sampling

    chartUpdateTimer = setInterval(() => {
        if (!btcChart || !currentTargetPrice) return;

        // Calculate interpolated price
        let displayPrice = currentTargetPrice;
        if (lastActualPrice !== null && currentTargetPrice !== lastActualPrice) {
            // Smooth interpolation (we're always catching up to the target)
            // Using 0.15 for faster catch-up while still smooth
            displayPrice = lastActualPrice + (currentTargetPrice - lastActualPrice) * 0.15;
            lastActualPrice = displayPrice;
        }

        // SMOOTH ANIMATION: Update last point every frame (18.18 FPS) for butter-smooth rendering
        // This prevents visible "jumps" on longer time ranges (15m, 30m) that have lower sampling rates
        if (chartDataPoints.length > 0) {
            chartDataPoints[chartDataPoints.length - 1] = displayPrice;
        }

        // TIME-BASED SCROLLING: Add NEW point based on sampling rate (time), not data arrival
        // This decouples horizontal scrolling (time-based) from vertical updates (data-based)
        // - For 1m: sampling rate 1 → add NEW point every 55ms → chart scrolls at real-time speed
        // - For 15m: sampling rate 9 → add NEW point every 495ms → chart scrolls 9× slower
        // - Between new points, we continuously update the LAST point above for smooth animation
        // - Result: smooth 18.18 FPS animation on ALL time ranges, with time-based scrolling
        if (chartUpdateCounter % currentSamplingRate === 0) {
            chartDataPoints.push(displayPrice); // Add NEW point for time-based scrolling

            // Calculate effective points per second and max points
            const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);
            const maxPoints = currentTimeRange
                ? Math.floor(currentTimeRange * effectivePointsPerSecond)
                : Math.min(chartDataPoints.length, MAX_CHART_POINTS);

            // Keep only the last maxPoints
            if (chartDataPoints.length > maxPoints) {
                chartDataPoints.shift(); // Remove oldest point - this creates the scrolling effect!
            }

            // Use actual data size if we don't have enough data to fill the time range
            const actualPoints = chartDataPoints.length;
            const displayPoints = actualPoints < maxPoints ? actualPoints : maxPoints;

            // Calculate time range based on actual data
            const actualTimeRange = actualPoints < maxPoints
                ? (actualPoints / effectivePointsPerSecond)
                : currentTimeRange;

            // Debug log every 100 updates to avoid spam
            if (chartUpdateCounter % 100 === 0) {
                console.log(`📊 LIVE UPDATE - chartDataPoints: ${chartDataPoints.length}, maxPoints: ${maxPoints}, displayPoints: ${displayPoints}, sampling: ${currentSamplingRate}`);
            }

            // Update time labels (regenerate every second to keep them fresh)
            const now = Date.now();
            if (!this.lastLabelUpdate || now - this.lastLabelUpdate > 1000) {
                btcChart.data.labels = generateTimeLabels(displayPoints, actualTimeRange);
                this.lastLabelUpdate = now;
            }
        }

        // Update chart every frame for smooth interpolation (even when not adding new points)
        // This is critical for smooth animation on longer time ranges (15m, 30m, etc.)
        btcChart.data.datasets[0].data = chartDataPoints;
        btcChart.update('none'); // No animation - we handle smoothness manually

        chartUpdateCounter++;

        // Update price display with actual target price (instant jump, no interpolation)
        // Chart uses interpolated displayPrice for smoothness, but price display jumps immediately
        updatePriceDisplay(currentTargetPrice);
    }, CHART_UPDATE_INTERVAL_MS);
}

// Update the price arrow indicator
function updatePriceArrowIndicator(currentPrice) {
    const arrowIndicator = document.getElementById('priceArrowIndicator');
    const arrowIcon = document.getElementById('arrowIcon');
    const arrowLabelChange = document.getElementById('arrowLabelChange');
    const arrowLabelPercent = document.getElementById('arrowLabelPercent');

    if (!arrowIndicator || !arrowIcon || !arrowLabelChange || !arrowLabelPercent) return;

    // Only show if we have a start price
    if (!marketStartPrice || marketStartPrice <= 0) {
        arrowIndicator.classList.remove('visible');
        return;
    }

    const diff = currentPrice - marketStartPrice;
    const diffPercent = ((diff / marketStartPrice) * 100).toFixed(2);

    // Update arrow direction and styling
    arrowIndicator.classList.add('visible');
    arrowIndicator.classList.remove('up', 'down');

    if (diff > 0) {
        arrowIndicator.classList.add('up');
        arrowIcon.textContent = '↑';
        arrowLabelChange.textContent = `+$${Math.abs(diff).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        arrowLabelPercent.textContent = `+${diffPercent}%`;
    } else if (diff < 0) {
        arrowIndicator.classList.add('down');
        arrowIcon.textContent = '↓';
        arrowLabelChange.textContent = `-$${Math.abs(diff).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        arrowLabelPercent.textContent = `${diffPercent}%`;
    } else {
        arrowIndicator.classList.remove('visible');
    }
}

// Update the price display element
function updatePriceDisplay(price) {
    const priceEl = document.getElementById('chartCurrentPrice');
    if (!priceEl) return;

    priceEl.textContent = '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Update arrow indicator
    updatePriceArrowIndicator(price);

    // Color based on trend
    if (priceHistory.length > 1) {
        const prevPrice = priceHistory[priceHistory.length - 2];
        if (price > prevPrice) {
            priceEl.style.color = '#00c896'; // Green for up
        } else if (price < prevPrice) {
            priceEl.style.color = '#ff4757'; // Red for down
        }
    }
}

// Called when we get a new actual BTC price from the oracle
function updateBTCChart(price) {
    // Validate price
    if (!price || isNaN(price) || price <= 0) {
        console.warn('Invalid price for chart:', price);
        return;
    }

    // Throttle logging to every 5 seconds
    const now = Date.now();
    if (now - lastPriceLogTime >= 5000) {
        console.log('New BTC price: $' + price.toFixed(2));
        lastPriceLogTime = now;
    }

    // Add actual price to history (for persistence and trend calculation)
    priceHistory.push(price);

    // Keep only what we need in memory (server stores more)
    // When time range is set, keep that much + buffer; when ALL, keep reasonable amount
    const memoryLimit = currentTimeRange ? currentTimeRange + 60 : 3600;
    if (priceHistory.length > memoryLimit) {
        priceHistory.shift();
    }

    // Save to server for persistence across page refreshes
    savePriceToServer(price);

    // Update interpolation targets
    lastActualPrice = currentTargetPrice || price;
    currentTargetPrice = price;

    // Log if chart isn't ready yet (but don't block price updates)
    if (!btcChart) {
        console.log('BTC Chart not initialized yet, but price data is being stored');
    }
}

// ============= ORACLE DATA =============

let priceEventSource = null;

// Connect to SSE price stream
function connectPriceStream() {
    if (priceEventSource) {
        priceEventSource.close();
    }

    // console.log('Connecting to price stream...');
    priceEventSource = new EventSource(`${CONFIG.API_PREFIX}/price-stream`);

    priceEventSource.onopen = () => {
        // console.log('✅ Price stream connected');
    };

    priceEventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.price) {
                updatePriceDisplay(data.price);
            }
        } catch (err) {
            console.error('Failed to parse price data:', err);
        }
    };

    priceEventSource.onerror = (error) => {
        console.error('Price stream error, reconnecting in 5s...');
        priceEventSource.close();
        setTimeout(connectPriceStream, 5000);
    };
}

function updatePriceDisplay(btcPrice) {
    // Format price
    const priceFormatted = '$' + btcPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    // Update the visible "Current Price" display
    const chartPriceEl = document.getElementById('chartCurrentPrice');
    const oracleAgeEl = document.getElementById('oracleAge');

    // console.log('[SSE] Price update:', priceFormatted);
    // console.log('[SSE] Elements:', {
    //     chartCurrentPrice: !!chartPriceEl,
    //     oracleAge: !!oracleAgeEl
    // });

    if (chartPriceEl) {
        chartPriceEl.textContent = priceFormatted;
        // console.log('[SSE] Updated chartCurrentPrice to:', priceFormatted);
    } else {
        // console.error('[SSE] chartCurrentPrice element not found!');
    }

    // Update BTC chart with numeric price
    updateBTCChart(btcPrice);

    // Update arrow indicator (shows difference from start price)
    updatePriceArrowIndicator(btcPrice);

    // Display age (SSE provides real-time data)
    const ageText = 'live';
    if (oracleAgeEl) {
        oracleAgeEl.textContent = ageText;
        oracleAgeEl.style.color = '#26de81';
    }
}

let marketEventSource = null;

// Connect to SSE market stream
function connectMarketStream() {
    if (marketEventSource) {
        marketEventSource.close();
    }

    // console.log('Connecting to market stream...');
    marketEventSource = new EventSource(`${CONFIG.API_PREFIX}/market-stream`);

    marketEventSource.onopen = () => {
        // console.log('✅ Market stream connected');
    };

    marketEventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data) {
                updateMarketDisplay(data);
            }
        } catch (err) {
            console.error('Failed to parse market data:', err);
        }
    };

    marketEventSource.onerror = (error) => {
        console.error('Market stream error, reconnecting in 5s...');
        marketEventSource.close();
        setTimeout(connectMarketStream, 5000);
    };
}

function updateMarketDisplay(marketData) {
    // console.log('[Market SSE] Update:', marketData);

    // Store fee for buy calculations
    currentFeeBps = marketData.feeBps;

    // Store start price for arrow indicator
    marketStartPrice = marketData.startPrice > 0 ? marketData.startPrice : null;

    // Update current cycle ID for quote history tracking
    if (marketData.cycleId && window.currentCycleId !== marketData.cycleId) {
        window.currentCycleId = marketData.cycleId;
        // Auto-load quote history for current cycle if viewing current market
        const selector = document.getElementById('cycleSelector');
        if (selector && selector.value === '' && typeof window.fetchQuoteHistory === 'function') {
            window.fetchQuoteHistory(marketData.cycleId);
        }
    }

    // Update "Price to Beat" display
    const beatPriceEl = document.getElementById('chartBeatPrice');
    if (beatPriceEl && marketStartPrice && marketStartPrice > 0) {
        const formattedPrice = marketStartPrice.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        beatPriceEl.textContent = `$${formattedPrice}`;
    } else if (beatPriceEl) {
        beatPriceEl.textContent = '--';
    }

    // Update market status display
    const statusEl = document.getElementById('marketStatus');
    if (statusEl) {
        const statusTexts = ['OPEN', 'STOPPED', 'SETTLED'];
        statusEl.textContent = statusTexts[marketData.status] || 'UNKNOWN';
        statusEl.className = `status-${statusTexts[marketData.status]?.toLowerCase() || 'unknown'}`;
    }

    // Update liquidity and vault displays (if they exist)
    const liquidityEl = document.getElementById('marketLiquidity');
    if (liquidityEl) {
        liquidityEl.textContent = marketData.bScaled.toFixed(2);
    }

    const vaultEl = document.getElementById('marketVault');
    if (vaultEl) {
        vaultEl.textContent = marketData.vault.toFixed(2);
    }

    // Update vault total display (in oracle section) - SSE path
    if (document.getElementById('vaultTotalDisplay')) {
        document.getElementById('vaultTotalDisplay').textContent = marketData.vault.toFixed(2);
    }

    // Update vault display (in header) - SSE path
    if (document.getElementById('vaultDisplay')) {
        document.getElementById('vaultDisplay').textContent = marketData.vault.toFixed(0);
    }

    // Update q_yes/q_no displays (if they exist)
    const qYesEl = document.getElementById('qYes');
    if (qYesEl) {
        qYesEl.textContent = marketData.qYes.toFixed(2);
    }

    const qNoEl = document.getElementById('qNo');
    if (qNoEl) {
        qNoEl.textContent = marketData.qNo.toFixed(2);
    }

    // If market is settled, show winner
    if (marketData.status === 2) {
        const winnerEl = document.getElementById('marketWinner');
        if (winnerEl) {
            const winnerTexts = ['NONE', 'UP/YES', 'DOWN/NO'];
            winnerEl.textContent = winnerTexts[marketData.winner] || 'UNKNOWN';
        }
    }
}

let volumeEventSource = null;
let cycleEventSource = null;

// Connect to SSE volume stream
function connectVolumeStream() {
    if (volumeEventSource) {
        volumeEventSource.close();
    }

    // console.log('Connecting to volume stream...');
    volumeEventSource = new EventSource(`${CONFIG.API_PREFIX}/volume-stream`);

    volumeEventSource.onopen = () => {
        // console.log('✅ Volume stream connected');
    };

    volumeEventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data) {
                updateVolumeDisplay(data);
            }
        } catch (err) {
            console.error('Failed to parse volume data:', err);
        }
    };

    volumeEventSource.onerror = (error) => {
        console.error('Volume stream error, reconnecting in 5s...');
        volumeEventSource.close();
        setTimeout(connectVolumeStream, 5000);
    };
}

function updateVolumeDisplay(volumeData) {
    // console.log('[Volume SSE] Update:', volumeData);

    // Update volume chart if it exists
    if (typeof updateVolumeChart === 'function') {
        updateVolumeChart(volumeData);
    }
}

// Connect to SSE cycle status stream
function connectCycleStream() {
    if (cycleEventSource) {
        // console.log('[Cycle Stream] Closing existing connection');
        cycleEventSource.close();
    }

    // console.log('[Cycle Stream] Connecting to /api/cycle-stream...');
    cycleEventSource = new EventSource(`${CONFIG.API_PREFIX}/cycle-stream`);

    cycleEventSource.onopen = () => {
        // console.log('[Cycle Stream] ✅ Connected successfully');
    };

    cycleEventSource.onmessage = (event) => {
        // console.log('[Cycle Stream] 📩 Received message:', event.data);
        try {
            const data = JSON.parse(event.data);
            // console.log('[Cycle Stream] 📦 Parsed data:', data);
            if (data) {
                // console.log('[Cycle Stream] 🔄 Calling updateCycleDisplay with state:', data.state);
                updateCycleDisplay(data);
            } else {
                // console.warn('[Cycle Stream] ⚠️ Received null/undefined data');
            }
        } catch (err) {
            // console.error('[Cycle Stream] ❌ Failed to parse cycle data:', err);
            // console.error('[Cycle Stream] Raw event data:', event.data);
        }
    };

    cycleEventSource.onerror = (error) => {
        // console.error('[Cycle Stream] ❌ Stream error:', error);
        // console.error('[Cycle Stream] ReadyState:', cycleEventSource.readyState);
        // console.error('[Cycle Stream] Reconnecting in 5s...');
        cycleEventSource.close();
        setTimeout(connectCycleStream, 5000);
    };
}

// Fallback: Fetch current price (for initial load before SSE connects)
async function fetchOracleData() {
    try {
        const response = await fetch(`${CONFIG.API_PREFIX}/current-price`);
        if (!response.ok) return;

        const data = await response.json();
        if (data.price) {
            updatePriceDisplay(data.price);
        }
    } catch (err) {
        console.error('Oracle fetch failed:', err);
    }
}

// ============= MARKET DATA =============

function readI64LE(buf, off) {
    const u = buf.readBigUInt64LE(off);
    const max = (1n << 63n) - 1n;
    return u > max ? Number(u - (1n << 64n)) : Number(u);
}

function readU8(buf, off) {
    return buf.readUInt8(off);
}

function readU16LE(buf, off) {
    return buf.readUInt16LE(off);
}

function readU64LE(buf, off) {
    return Number(buf.readBigUInt64LE(off));
}

async function fetchMarketData() {
    try {
//         console.log('[fetchMarketData] Fetching account:', ammPda ? ammPda.toString() : 'NULL');
        const accountInfo = await connection.getAccountInfo(ammPda);

        if (!accountInfo) {
            console.error('No market found at:', ammPda ? ammPda.toString() : 'NULL');
            return;
        }

        const d = accountInfo.data;
        if (d.length < 8 + 62) {
            console.error('Market data invalid');
            return;
        }

        const p = d.subarray(8);
        let o = 0;

        const bump = readU8(p, o); o += 1;
        const decimals = readU8(p, o); o += 1;
        const bScaled = readI64LE(p, o); o += 8;
        const feeBps = readU16LE(p, o); o += 2;

        // Store fee for buy calculations
        currentFeeBps = feeBps;
        const qY = readI64LE(p, o); o += 8;
        const qN = readI64LE(p, o); o += 8;
        const fees = readI64LE(p, o); o += 8;
        const vault = readI64LE(p, o); o += 8;
        const status = readU8(p, o); o += 1;
        const winner = readU8(p, o); o += 1;
        const wTotal = readI64LE(p, o); o += 8;
        const pps = readI64LE(p, o); o += 8;
        o += 32; // Skip fee_dest pubkey
        const vaultSolBump = readU8(p, o); o += 1;
        const startPriceE6 = readI64LE(p, o); o += 8;
        const startTs = readI64LE(p, o); o += 8;
        const settlePriceE6 = readI64LE(p, o); o += 8;
       const settleTs = readI64LE(p, o); o += 8;
       const marketEndSlot = readU64LE(p, o); o += 8;
       const marketEndTime = readI64LE(p, o); o += 8;  // Unix timestamp in seconds

        // Store market end slot + lockout start
        updateMarketEndSlot(marketEndSlot);

        // Store market end time (convert seconds to milliseconds)
        currentMarketEndTime = marketEndTime > 0 ? marketEndTime * 1000 : 0;

        // Log market timing info
        if (currentMarketEndTime > 0) {
            const lockoutStartTime = currentMarketEndTime - (TRADING_LOCKOUT_SECONDS * 1000);
//             console.log('[fetchMarketData] Market Timing Configuration:');
            console.log(`  Market End Time: ${new Date(currentMarketEndTime).toLocaleString()}`);
            console.log(`  Lockout Start: ${new Date(lockoutStartTime).toLocaleString()}`);
            console.log(`  Trading locks ${TRADING_LOCKOUT_SECONDS} seconds before market end`);
        }

        // Store start price for arrow indicator
        marketStartPrice = startPriceE6 > 0 ? startPriceE6 / 1_000_000 : null;

//         console.log('[fetchMarketData] Start price E6:', startPriceE6, '→ USD:', marketStartPrice);
//         console.log('[fetchMarketData] Market end slot:', marketEndSlot);

        // Update "Price to Beat" display
        const beatPriceEl = document.getElementById('chartBeatPrice');
        if (beatPriceEl) {
            if (marketStartPrice && marketStartPrice > 0) {
                const formattedPrice = marketStartPrice.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                beatPriceEl.textContent = `$${formattedPrice}`;
//                 console.log('[fetchMarketData] ✅ Updated beatPrice display to:', formattedPrice);
            } else {
                beatPriceEl.textContent = '--';
//                 console.log('[fetchMarketData] ⚠️ No start price yet, showing --');
            }
        }

        // Store LMSR parameters globally
        currentB = bScaled;
        currentQYes = qY;
        currentQNo = qN;
        currentVaultE6 = vault;

        // Calculate YES/NO probabilities using LMSR
        const b = bScaled;
        const a = Math.exp(qY / b);
        const c = Math.exp(qN / b);
        const yesProb = a / (a + c);
        const noProb = 1 - yesProb;

        // Store current prices globally for position valuation
        currentYesPrice = yesProb;
        currentNoPrice = noProb;

        // Calculate total shares (q values are in LAMPORTS scale)
        // q values are POSITIVE for shares outstanding
        const yesShares = Math.max(0, qY / 10_000_000);
        const noShares = Math.max(0, qN / 10_000_000);

        // Update YES/NO prices (in XNT instead of percentages)
        if (document.getElementById('yesPercentage')) {
            document.getElementById('yesPercentage').textContent = yesProb.toFixed(2);
        }
        if (document.getElementById('noPercentage')) {
            document.getElementById('noPercentage').textContent = noProb.toFixed(2);
        }

        // Update YES/NO shares
        if (document.getElementById('yesShares')) {
            document.getElementById('yesShares').textContent = yesShares.toFixed(0) + ' shares';
        }
        if (document.getElementById('noShares')) {
            document.getElementById('noShares').textContent = noShares.toFixed(0) + ' shares';
        }

        // Update volume stats from market data (for /hl page)
        if (typeof window.updateVolumeStatsFromMarket === 'function') {
            window.updateVolumeStatsFromMarket(qY, qN);
        }

        // Update outcome button prices
        if (document.getElementById('yesBtnPrice')) {
            document.getElementById('yesBtnPrice').textContent = yesProb.toFixed(2);
        }
        if (document.getElementById('noBtnPrice')) {
            document.getElementById('noBtnPrice').textContent = noProb.toFixed(2);
        }

        // Update slider max when prices change
        updateSliderMax();

        // Update vault display (in header)
        // vault_e6 uses LAMPORTS scale: 1 XNT = 10_000_000 e6
        if (document.getElementById('vaultDisplay')) {
            document.getElementById('vaultDisplay').textContent = (vault / 10_000_000).toFixed(0);
        }

        // Update vault total display (in oracle section)
        if (document.getElementById('vaultTotalDisplay')) {
            document.getElementById('vaultTotalDisplay').textContent = (vault / 10_000_000).toFixed(2);
        }

        // Update market status badge and track globally
        currentMarketStatus = status;
        const statusText = status === 0 ? 'OPEN' : status === 1 ? 'STOPPED' : 'STARTING SOON';
        if (document.getElementById('marketStatusBadge')) {
            document.getElementById('marketStatusBadge').textContent = statusText;
            document.getElementById('marketStatusBadge').className = 'market-status';
            if (status === 0) document.getElementById('marketStatusBadge').style.background = '#00c896';
            else if (status === 1) document.getElementById('marketStatusBadge').style.background = '#ffa502';
            else document.getElementById('marketStatusBadge').style.background = '#ff4757';
        }

        // Update button states based on market status
        updateButtonStates();

        // Determine winning side if market is settled
        if (status === 2) {
            // Use the actual winner field from the contract
            // winner: 0 = no winner yet, 1 = YES won, 2 = NO won
            if (winner === 1) {
                currentWinningSide = 'yes';
            } else if (winner === 2) {
                currentWinningSide = 'no';
            } else {
                // Fallback: use probability if winner field not set
                currentWinningSide = yesProb > 0.5 ? 'yes' : 'no';
            }
            // Store actual payout per share (convert from e6 to XNT)
            // pps_e6 max is 1_000_000, so pps_e6 / 1_000_000 = XNT per share (max 1.0)
            currentPayoutPerShare = pps / 1_000_000;
        } else {
            currentWinningSide = null;
            currentPayoutPerShare = 0;
        }

        // Store snapshot price for updateCycleDisplay to use (don't update label here to avoid flickering)
        currentSnapshotPrice = startPriceE6 > 0 ? startPriceE6 / 1_000_000 : null;

        // Update button states
        if (document.getElementById('snapshotBtn')) {
            document.getElementById('snapshotBtn').disabled = status !== 0;
        }

        // Update trade button cost display with new prices
        updateTradeButton();

        // Show winner banner if market is settled
        if (status === 2 && winner > 0 && startPriceE6 > 0) {
            displaySettledMarketWinner(winner, startPriceE6);
        } else if (status !== 2) {
            // Hide banner if market is not settled
            const bannerEl = document.getElementById('winnerBanner');
            if (bannerEl) bannerEl.style.display = 'none';
        }

    } catch (err) {
        console.error('Market fetch failed:', err);
    }
}

// ============= POSITION DATA =============

// Global variables to store current market prices and LMSR parameters
let currentYesPrice = 0.50;
let currentNoPrice = 0.50;
let currentB = 0;
let currentQYes = 0;
let currentQNo = 0;
let currentVaultE6 = 0; // AMM vault balance for covering sells

// Calculate LMSR cost function
// Returns the cost value C(q_yes, q_no) where q values are in shares (NOT e6)
function lmsrCost(qYesShares, qNoShares) {
    const b = currentB / 10_000_000; // Convert b to share units

    // Use log-sum-exp trick for numerical stability
    const max = Math.max(qYesShares, qNoShares);
    const cost = b * (max / b + Math.log(
        Math.exp((qYesShares - max) / b) +
        Math.exp((qNoShares - max) / b)
    ));

    return cost;
}

// Calculate cost to buy numShares on given side
// Returns net cost in XNT (before fees)
function calculateLMSRCost(side, numShares) {
    if (numShares <= 0) {
        return 0;
    }

    // If market not initialized yet, use simple pricing
    if (currentB === 0) {
        const simplePrice = (side === 'yes' ? currentYesPrice : currentNoPrice);
        return numShares * simplePrice;
    }

    // Convert current q values from e6 to shares
    // Note: q values are POSITIVE for shares outstanding (sold to users)
    const currentQYesShares = currentQYes / 10_000_000;
    const currentQNoShares = currentQNo / 10_000_000;

    // Calculate cost before buying
    const C_before = lmsrCost(currentQYesShares, currentQNoShares);

    // Calculate cost after buying (more shares outstanding means higher q)
    let newQYesShares, newQNoShares;
    if (side === 'yes') {
        newQYesShares = currentQYesShares + numShares;
        newQNoShares = currentQNoShares;
    } else {
        newQYesShares = currentQYesShares;
        newQNoShares = currentQNoShares + numShares;
    }

    const C_after = lmsrCost(newQYesShares, newQNoShares);

    // Net cost (before fees)
    const netCost = C_after - C_before;

    // Safety check
    if (!isFinite(netCost) || netCost < 0) {
        console.error('LMSR calculation failed', {
            currentQYesShares, currentQNoShares,
            newQYesShares, newQNoShares,
            C_before, C_after, netCost
        });
        return -1;
    }

    return netCost;
}

// Simulate Rust binary search: given desired shares, find the spend amount that will produce those shares
/**
 * Calculate proceeds from selling shares (matches Rust lmsr_sell_yes/lmsr_sell_no)
 * @param {string} side - 'yes' or 'no'
 * @param {number} numShares - Number of shares to sell
 * @returns {number} Net proceeds in XNT after fees
 */
function calculateSellProceeds(side, numShares) {
    if (numShares <= 0 || currentB === 0) {
        const price = side === 'yes' ? currentYesPrice : currentNoPrice;
        return numShares * price;
    }

    // Convert to e6 scale (shares in contract are stored as e6)
    const sharesE6 = numShares * 10_000_000;

    // Get current quantities in shares
    const qYesShares = currentQYes / 10_000_000;
    const qNoShares = currentQNo / 10_000_000;

    // Limit sell to available liquidity
    const maxSellE6 = side === 'yes' ? currentQYes : currentQNo;
    const sellE6 = Math.min(sharesE6, maxSellE6);
    const sellShares = sellE6 / 10_000_000;

    if (sellShares <= 0) return 0;

    // Calculate cost difference (matches Rust lmsr_sell_yes/lmsr_sell_no)
    let pre, post;
    if (side === 'yes') {
        pre = lmsrCost(qYesShares, qNoShares);
        post = lmsrCost(qYesShares - sellShares, qNoShares);
    } else {
        pre = lmsrCost(qYesShares, qNoShares);
        post = lmsrCost(qYesShares, qNoShares - sellShares);
    }

    let grossH = pre - post;
    if (!isFinite(grossH) || grossH < 0) grossH = 0;

    // Apply fee (same calculation as Rust)
    const feeH = (grossH * currentFeeBps) / 10_000;
    const netH = grossH - feeH;

    console.log(`[calculateSellProceeds] side=${side}, shares=${numShares}`);
    console.log(`  LMSR: pre=${pre.toFixed(6)}, post=${post.toFixed(6)}, gross=${grossH.toFixed(6)}`);
    console.log(`  Fee: ${feeH.toFixed(6)} (${currentFeeBps}bps), Net: ${netH.toFixed(6)}`);

    return Math.max(0, netH);
}

// This matches the Rust lmsr_buy_yes/lmsr_buy_no logic exactly
function calculateSpendForShares(side, desiredShares) {
    if (desiredShares <= 0 || currentB === 0) {
        return desiredShares * (side === 'yes' ? currentYesPrice : currentNoPrice);
    }

    const qYesShares = currentQYes / 10_000_000;
    const qNoShares = currentQNo / 10_000_000;
    const bShares = currentB / 10_000_000;

    // Calculate current probability (matches Rust lmsr_p_yes)
    const base = lmsrCost(qYesShares, qNoShares);
    const p_yes = 1.0 / (1.0 + Math.exp((qNoShares - qYesShares) / bShares));
    const p = side === 'yes' ? Math.max(p_yes, 1e-9) : Math.max(1.0 - p_yes, 1e-9);

    // Binary search to find spend amount that produces desired shares
    // We're inverting: Rust does spend→shares, we need shares→spend
    let lo = 0;
    let hi = desiredShares * p * 2.0; // Initial guess for spend (with margin)

    for (let iter = 0; iter < 32; iter++) {
        const mid = 0.5 * (lo + hi);

        // Simulate what Rust does: given spend 'mid', how many shares would we get?
        const feeRate = currentFeeBps / 10000;
        const netSpend = mid * (1 - feeRate);

        // Rust binary search for shares given netSpend
        const rustShares = simulateRustBinarySearch(side, netSpend, qYesShares, qNoShares, bShares);

        const diff = rustShares - desiredShares;
        if (Math.abs(diff) <= 0.001) { // 0.001 shares tolerance
            return mid;
        }

        if (diff < 0) {
            lo = mid; // Got fewer shares, need more spend
        } else {
            hi = mid; // Got more shares, need less spend
        }
    }

    return 0.5 * (lo + hi);
}

// Simulate Rust's binary search: given net spend, calculate shares using Rust's algorithm
function simulateRustBinarySearch(side, netSpend, qYesShares, qNoShares, bShares) {
    const base = lmsrCost(qYesShares, qNoShares);

    // Rust initial high estimate (matches Rust lines 1238, 1270)
    const p_yes = 1.0 / (1.0 + Math.exp((qNoShares - qYesShares) / bShares));
    const p = side === 'yes' ? Math.max(p_yes, 1e-9) : Math.max(1.0 - p_yes, 1e-9);
    let hi = Math.min(netSpend / p, bShares * 5.0);
    if (hi < 1.0) hi = 1.0;
    let lo = 0.0;

    // Rust binary search (matches Rust lines 1241-1247)
    for (let i = 0; i < 32; i++) {
        const mid = 0.5 * (lo + hi);

        let val;
        if (side === 'yes') {
            val = lmsrCost(qYesShares + mid, qNoShares) - base;
        } else {
            val = lmsrCost(qYesShares, qNoShares + mid) - base;
        }

        const diff = val - netSpend;
        if (Math.abs(diff) <= 1e-9) {
            lo = mid;
            hi = mid;
            break;
        }

        if (diff < 0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    return 0.5 * (lo + hi);
}

// Helper function to get current position shares without updating display
async function getPositionShares() {
    if (!wallet) return null;

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const accountInfo = await connection.getAccountInfo(posPda);
        if (!accountInfo) return { yes: 0, no: 0 };

        const d = accountInfo.data;
        if (d.length >= 8 + 32 + 8 + 8) {
            let o = 8; // Skip discriminator
            o += 32; // Skip owner pubkey
            const sharesY = readI64LE(d, o); o += 8;
            const sharesN = readI64LE(d, o); o += 8;

            return {
                yes: sharesY / 10_000_000,
                no: sharesN / 10_000_000
            };
        }
        return { yes: 0, no: 0 };
    } catch (err) {
        console.error('Position fetch failed:', err);
        return null;
    }
}

async function fetchPositionData() {
    if (!wallet) return;

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const accountInfo = await connection.getAccountInfo(posPda);

        if (!accountInfo) {
            // No position exists - show zeros
            updatePositionDisplay(0, 0);
            return;
        }

        const d = accountInfo.data;
        // Position struct: discriminator(8) + owner(32) + yes_shares_e6(8) + no_shares_e6(8)
        if (d.length >= 8 + 32 + 8 + 8) {
            let o = 8; // Skip discriminator
            o += 32; // Skip owner pubkey
            const sharesY = readI64LE(d, o); o += 8;
            const sharesN = readI64LE(d, o); o += 8;

            // Shares are stored in LAMPORTS scale: 10_000_000 e6 = 1 share
            const sharesYesFloat = sharesY / 10_000_000;
            const sharesNoFloat = sharesN / 10_000_000;

            updatePositionDisplay(sharesYesFloat, sharesNoFloat);
        }

    } catch (err) {
        console.error('Position fetch failed:', err);
    }
}

function updatePositionDisplay(sharesYes, sharesNo) {
    // Store shares globally for validation
    userYesShares = sharesYes;
    userNoShares = sharesNo;

    // Update new position status display
    if (document.getElementById('posYesDisplay')) {
        document.getElementById('posYesDisplay').textContent = sharesYes.toFixed(2);
    }
    if (document.getElementById('posNoDisplay')) {
        document.getElementById('posNoDisplay').textContent = sharesNo.toFixed(2);
    }

    // Validate sell buttons after updating position
    validateSellButtons();

    // Calculate position values using current market prices
    const yesValue = sharesYes * currentYesPrice;
    const noValue = sharesNo * currentNoPrice;
    const totalValue = yesValue + noValue;

    if (document.getElementById('posYesValue')) {
        document.getElementById('posYesValue').textContent = '≈ ' + yesValue.toFixed(2) + ' XNT';
    }
    if (document.getElementById('posNoValue')) {
        document.getElementById('posNoValue').textContent = '≈ ' + noValue.toFixed(2) + ' XNT';
    }
    if (document.getElementById('totalPosValue')) {
        document.getElementById('totalPosValue').textContent = totalValue.toFixed(2) + ' XNT';
    }

    // Calculate net exposure (UP - DOWN in XNT terms)
    const netExposure = yesValue - noValue;
    const netExposureEl = document.getElementById('netExposure');
    if (netExposureEl) {
        if (Math.abs(netExposure) < 0.01) {
            netExposureEl.textContent = 'Neutral';
            netExposureEl.style.color = '#8b92a8';
        } else if (netExposure > 0) {
            netExposureEl.textContent = '+' + netExposure.toFixed(2) + ' XNT UP';
            netExposureEl.style.color = '#00c896';
        } else {
            netExposureEl.textContent = '-' + Math.abs(netExposure).toFixed(2) + ' XNT DOWN';
            netExposureEl.style.color = '#ff4757';
        }
    }

    // Update redeemable balance if market is settled
    updateRedeemableBalance(sharesYes, sharesNo);
}

// Global variable to track market settlement state
let currentMarketStatus = 0;
let currentWinningSide = null; // 'yes' or 'no'
let currentSnapshotPrice = null;
let currentPayoutPerShare = 0; // Actual payout per winning share (in XNT)
let currentMarketEndSlot = 0; // Slot when market ends (0 = not set) - DEPRECATED
let currentMarketEndTime = 0; // Unix timestamp in milliseconds when market ends (0 = not set)
let lastCalculatedMarketEndTime = 0; // Track when we last calculated end slot
const TRADING_LOCKOUT_SLOTS = 90; // Must match Rust program constant - DEPRECATED
const TRADING_LOCKOUT_SECONDS = 45; // Must match Rust program constant (45 seconds)

// Check if trading is locked (45 seconds before market end using time-based check)
async function isTradingLocked() {
    if (currentMarketEndTime === 0) {
        console.log('[isTradingLocked] Market end time not set, allowing trade');
        return false; // Market end not set, trading allowed
    }

    try {
        const now = Date.now(); // Current time in milliseconds
        const lockoutStartTime = currentMarketEndTime - (TRADING_LOCKOUT_SECONDS * 1000); // 45 seconds before end
        const timeUntilEnd = Math.max(0, currentMarketEndTime - now) / 1000; // seconds
        const timeUntilLockout = Math.max(0, lockoutStartTime - now) / 1000; // seconds
        const isLocked = now >= lockoutStartTime;

        console.log(`[Trading Lockout Check]`);
        console.log(`  Market start: ${new Date(currentMarketEndTime - (10 * 60 * 1000)).toLocaleTimeString()}`);
        console.log(`  Market end: ${new Date(currentMarketEndTime).toLocaleTimeString()}`);
        console.log(`  Lockout starts: ${new Date(lockoutStartTime).toLocaleTimeString()}`);
        console.log(`  Current time: ${new Date(now).toLocaleTimeString()}`);
        console.log(`  Time until lockout: ${timeUntilLockout.toFixed(1)}s`);
        console.log(`  Time until market end: ${timeUntilEnd.toFixed(1)}s`);
        console.log(`  🔒 Locked: ${isLocked ? 'YES' : 'NO'}`);

        return isLocked;
    } catch (err) {
        console.error('Error checking trading lockout:', err);
        return false; // On error, allow trading
    }
}

function updateRedeemableBalance(sharesYes, sharesNo) {
    const redeemableSectionSidebar = document.getElementById('redeemableSectionSidebar');
    const btnRedeemSidebar = document.getElementById('btnRedeemSidebar');
    const redeemableSection = document.getElementById('redeemableSection');
    const btnRedeem = document.getElementById('btnRedeem');

    // Calculate redeemable value using ACTUAL payout per share from the contract
    let yesValue, noValue, totalRedeemable;
    const payoutPerWinningShare = currentPayoutPerShare || 1.0;

    if (currentMarketStatus === 2 && currentWinningSide) {
        // Market is SETTLED - enable redeem section
        if (redeemableSectionSidebar) {
            redeemableSectionSidebar.classList.remove('disabled');
        }
        if (btnRedeemSidebar) {
            btnRedeemSidebar.disabled = false;
        }
        if (redeemableSection) {
            redeemableSection.classList.remove('disabled');
        }
        if (btnRedeem) {
            btnRedeem.disabled = false;
        }

        if (currentWinningSide === 'yes') {
            yesValue = sharesYes * payoutPerWinningShare;
            noValue = sharesNo * 0.0;
        } else {
            yesValue = sharesYes * 0.0;
            noValue = sharesNo * payoutPerWinningShare;
        }

        totalRedeemable = yesValue + noValue;
    } else {
        // Market not settled - disable redeem section
        if (redeemableSectionSidebar) {
            redeemableSectionSidebar.classList.add('disabled');
        }
        if (btnRedeemSidebar) {
            btnRedeemSidebar.disabled = true;
        }
        if (redeemableSection) {
            redeemableSection.classList.add('disabled');
        }
        if (btnRedeem) {
            btnRedeem.disabled = true;
        }

        yesValue = 0;
        noValue = 0;
        totalRedeemable = 0;
    }

    const totalText = totalRedeemable.toFixed(2) + ' XNT';

    // Update sidebar amount
    if (document.getElementById('redeemableAmountSidebar')) {
        document.getElementById('redeemableAmountSidebar').textContent = totalText;
    }
    // Update main redeem amount (for proto1)
    if (document.getElementById('redeemableAmount')) {
        document.getElementById('redeemableAmount').textContent = totalText;
    }

    // Create breakdown text - only show winning side
    let breakdownLine = '';
    if (currentMarketStatus === 2 && currentWinningSide) {
        if (currentWinningSide === 'yes') {
            breakdownLine = `${sharesYes.toFixed(2)} shares × ${payoutPerWinningShare.toFixed(4)} = ${yesValue.toFixed(2)} XNT`;
        } else {
            breakdownLine = `${sharesNo.toFixed(2)} shares × ${payoutPerWinningShare.toFixed(4)} = ${noValue.toFixed(2)} XNT`;
        }
    } else {
        breakdownLine = 'Market not settled';
    }

    // Update sidebar breakdown
    if (document.getElementById('redeemableBreakdownSidebar')) {
        document.getElementById('redeemableBreakdownSidebar').innerHTML = breakdownLine;
    }
    // Update main breakdown (for proto1)
    if (document.getElementById('redeemableBreakdown')) {
        document.getElementById('redeemableBreakdown').innerHTML = breakdownLine;
    }
}

function updateLastTradeInfo(action, side, numShares, cost) {
    const actionEl = document.getElementById('lastTradeAction');
    const sizeEl = document.getElementById('lastTradeSize');

    if (actionEl) {
        const actionText = `${action.toUpperCase()} ${side.toUpperCase()}`;
        actionEl.textContent = actionText;

        // Color code the action
        if (action === 'buy') {
            actionEl.style.color = side === 'yes' ? '#00c896' : '#ff4757';
        } else {
            actionEl.style.color = '#ffa502';
        }
    }

    if (sizeEl) {
        sizeEl.textContent = `${numShares} shares (~${cost.toFixed(2)} XNT)`;
    }
}

// ============= HELPER FUNCTIONS =============

let cachedFeeDest = null;

async function getFeeDest() {
    // Fetch fee_dest from AMM account if not cached
    if (cachedFeeDest) {
        return cachedFeeDest;
    }

    try {
        const accountInfo = await connection.getAccountInfo(ammPda);
        if (!accountInfo) {
            throw new Error('AMM account not found');
        }

        const d = accountInfo.data;
        // AMM structure offsets:
        // discriminator(8) + bump(1) + decimals(1) + b(8) + fee_bps(2) + q_yes(8) + q_no(8) +
        // fees(8) + vault_e6(8) + status(1) + winner(1) + w_total_e6(8) + pps_e6(8) + fee_dest(32)
        const offset = 8 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 8;  // = 70
        const feeDestBytes = d.slice(offset, offset + 32);
        cachedFeeDest = new solanaWeb3.PublicKey(feeDestBytes);

        addLog('Fee destination: ' + cachedFeeDest.toString(), 'info');
        return cachedFeeDest;
    } catch (err) {
        console.error('Failed to get fee_dest:', err);
        // Fallback to user's pubkey
        return wallet.publicKey;
    }
}

function createComputeBudgetInstructions(units = 800000, microLamports = 1) {
    const { ComputeBudgetProgram } = solanaWeb3;
    return [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
    ];
}

// ============= TRADING FUNCTIONS =============

// Pure JavaScript SHA256 implementation (fallback for non-secure contexts)
function sha256Pure(data) {
    // Implementation based on https://github.com/emn178/js-sha256
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bitLen = bytes.length * 8;

    // Padding
    const paddingLen = (bytes.length % 64 < 56) ? (56 - bytes.length % 64) : (120 - bytes.length % 64);
    const padded = new Uint8Array(bytes.length + paddingLen + 8);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    // Append length as 64-bit big-endian (using DataView for proper 64-bit handling)
    const view = new DataView(padded.buffer, padded.byteOffset + padded.length - 8, 8);
    // JavaScript doesn't have native 64-bit int, so we write upper 32 bits (always 0 for our use case) and lower 32 bits
    view.setUint32(0, 0, false); // Upper 32 bits = 0 (big-endian)
    view.setUint32(4, bitLen, false); // Lower 32 bits = bitLen (big-endian)

    // Process 512-bit chunks
    for (let chunk = 0; chunk < padded.length; chunk += 64) {
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) {
            w[i] = (padded[chunk + i*4] << 24) | (padded[chunk + i*4 + 1] << 16) |
                   (padded[chunk + i*4 + 2] << 8) | padded[chunk + i*4 + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = ((w[i-15] >>> 7) | (w[i-15] << 25)) ^ ((w[i-15] >>> 18) | (w[i-15] << 14)) ^ (w[i-15] >>> 3);
            const s1 = ((w[i-2] >>> 17) | (w[i-2] << 15)) ^ ((w[i-2] >>> 19) | (w[i-2] << 13)) ^ (w[i-2] >>> 10);
            w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }

        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    const hash = new Uint8Array(32);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((h, i) => {
        hash[i*4] = (h >>> 24) & 0xff;
        hash[i*4 + 1] = (h >>> 16) & 0xff;
        hash[i*4 + 2] = (h >>> 8) & 0xff;
        hash[i*4 + 3] = h & 0xff;
    });

    return hash;
}

async function createDiscriminator(name) {
    const data = stringToUint8Array('global:' + name);

    // Try to use Web Crypto API first (faster and native)
    const cryptoObj = window.crypto || window.msCrypto || self.crypto;

    if (cryptoObj && cryptoObj.subtle && window.isSecureContext) {
        try {
            const hashBuffer = await cryptoObj.subtle.digest('SHA-256', data);
            const hashArray = new Uint8Array(hashBuffer);
            return hashArray.slice(0, 8);
        } catch (err) {
            console.warn('Web Crypto API failed, using pure JS fallback:', err);
        }
    }

    // Fallback to pure JavaScript SHA256 implementation
    // This works in all contexts (HTTP, HTTPS, localhost, IP addresses)
    console.log('Using pure JS SHA256 (Web Crypto not available in this context)');
    const hashArray = sha256Pure(data);
    return hashArray.slice(0, 8);
}

// ============= TOAST NOTIFICATIONS =============
function showToast(type, title, message) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.error('Toast container not found');
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    toast.innerHTML = `
        <div class="toast-header">
            <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ⓘ'}</span>
            <span class="toast-title">${title}</span>
        </div>
        <div class="toast-message">${message}</div>
    `;

    container.appendChild(toast);

    // Auto-remove after 2 seconds
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => {
            container.removeChild(toast);
        }, 300);
    }, 2000);
}

// ============= LIMIT ORDER FUNCTIONS =============

// Serialize order to bytes (Borsh format) - matches orderbook.html implementation
function serializeOrder(order, marketPubkey, userPubkey) {
    const buffers = [];

    // Helper functions
    function writeU8(value) {
        return new Uint8Array([value]);
    }

    function writeI64LE(value) {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setBigInt64(0, BigInt(value), true);
        return new Uint8Array(buf);
    }

    function writeU64LE(value) {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setBigUint64(0, BigInt(value), true);
        return new Uint8Array(buf);
    }

    function writeU16LE(value) {
        const buf = new ArrayBuffer(2);
        const view = new DataView(buf);
        view.setUint16(0, value, true);
        return new Uint8Array(buf);
    }

    // Serialize in order (matches Borsh struct layout)
    buffers.push(marketPubkey.toBytes());
    buffers.push(userPubkey.toBytes());
    buffers.push(writeU8(order.action));
    buffers.push(writeU8(order.side));
    buffers.push(writeI64LE(order.shares_e6));
    buffers.push(writeI64LE(order.limit_price_e6));
    buffers.push(writeI64LE(order.max_cost_e6));
    buffers.push(writeI64LE(order.min_proceeds_e6));
    buffers.push(writeI64LE(order.expiry_ts));
    buffers.push(writeU64LE(order.nonce));
    buffers.push(writeU16LE(order.keeper_fee_bps));
    buffers.push(writeU16LE(order.min_fill_bps));

    // Concatenate all buffers
    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
        result.set(buf, offset);
        offset += buf.length;
    }

    return result;
}

// Submit limit order to orderbook API
async function submitLimitOrder(tradeData) {
    const { action, side, numShares, limitPrice } = tradeData;

    if (!wallet || !wallet.publicKey) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    try {
        addLog(`Submitting limit order: ${action.toUpperCase()} ${numShares} ${side.toUpperCase()} @ $${limitPrice.toFixed(4)}`, 'info');

        // Get market PDA
        const programId = new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID);
        const ammSeedBytes = new TextEncoder().encode(CONFIG.AMM_SEED);
        const [marketPda] = await solanaWeb3.PublicKey.findProgramAddress(
            [ammSeedBytes],
            programId
        );

        // Create order with default parameters
        const now = Math.floor(Date.now() / 1000);
        const ttl = 86400; // 24 hours default
        const keeperFeeBps = 10; // 0.1% default
        const slippagePct = 0.5; // 0.5% default slippage

        // Get fill strategy from UI (default: all-or-none)
        const selectedFillStrategy = typeof window.fillStrategy !== 'undefined' ? window.fillStrategy : 'all-or-none';
        const minFillBps = selectedFillStrategy === 'all-or-none' ? 10000 : 0; // 10000 = 100% (must fill completely), 0 = partial OK

        // Adjust limit price for slippage tolerance
        const slippageFactor = slippagePct / 100;
        const actionNum = action === 'buy' ? 1 : 2;
        const adjustedLimitPrice = actionNum === 1
            ? limitPrice * (1 + slippageFactor)  // BUY: increase limit
            : limitPrice * (1 - slippageFactor); // SELL: decrease limit

        console.log(`[LIMIT ORDER] Slippage adjustment: ${limitPrice.toFixed(4)} → ${adjustedLimitPrice.toFixed(4)} (${slippagePct}%)`);

        const order = {
            market: marketPda.toString(),
            user: wallet.publicKey.toString(),
            action: actionNum,
            side: side === 'yes' ? 1 : 2,
            shares_e6: Math.floor(numShares * 10_000_000),
            limit_price_e6: Math.floor(adjustedLimitPrice * 1e6),
            max_cost_e6: Number.MAX_SAFE_INTEGER,
            min_proceeds_e6: 0,
            expiry_ts: now + ttl,
            nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            keeper_fee_bps: keeperFeeBps,
            min_fill_bps: minFillBps
        };

        // Serialize order (Borsh encoding)
        const messageBytes = serializeOrder(order, marketPda, wallet.publicKey);

        // Sign with Ed25519 using session wallet
        const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
        const signatureHex = Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

        // Submit to orderbook API
        const API_BASE = `${window.location.protocol}//${window.location.host}/orderbook-api`;
        const response = await fetch(`${API_BASE}/api/orders/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order, signature: signatureHex })
        });

        const data = await response.json();

        if (response.ok) {
            const priceInfo = adjustedLimitPrice !== limitPrice
                ? `$${limitPrice.toFixed(4)} (adjusted to $${adjustedLimitPrice.toFixed(4)} with ${slippagePct}% slippage)`
                : `$${limitPrice.toFixed(4)}`;
            const strategyText = selectedFillStrategy === 'all-or-none' ? ' [All-or-None]' : ' [Partial OK]';
            addLog(`✅ Order #${data.order_id} submitted: ${action.toUpperCase()} ${numShares} ${side.toUpperCase()} @ ${priceInfo}${strategyText}`, 'success');
            showToast('success', '📋 Order Submitted', `Limit order #${data.order_id} placed successfully${strategyText}`);

            // Reload open orders if the function exists
            if (typeof loadOpenOrders === 'function') {
                loadOpenOrders();
            }
        } else {
            addLog(`Failed to submit order: ${data.error}`, 'error');
            showError(`Order failed: ${data.error}`);
        }
    } catch (err) {
        console.error('Error submitting limit order:', err);
        addLog(`ERROR: ${err.message}`, 'error');
        showError(`Order error: ${err.message}`);
    }
}

// ============= END LIMIT ORDER FUNCTIONS =============

async function executeTrade() {
    // Check if we're in limit order mode
    if (typeof currentOrderType !== 'undefined' && currentOrderType === 'limit') {
        // Get limit price from UI
        const limitPriceInput = document.getElementById('limitPriceInput');
        const limitPriceValue = limitPriceInput ? parseFloat(limitPriceInput.value) : null;

        if (!limitPriceValue || isNaN(limitPriceValue) || limitPriceValue <= 0) {
            addLog('ERROR: Invalid limit price', 'error');
            showError('Invalid limit price');
            return;
        }

        // Get number of shares
        const numShares = parseFloat(document.getElementById('tradeAmountShares').value);
        if (isNaN(numShares) || numShares <= 0) {
            addLog('ERROR: Invalid number of shares', 'error');
            showError('Invalid shares');
            return;
        }

        // Submit limit order instead of market order
        const tradeData = {
            action: currentAction,
            side: currentSide,
            numShares,
            limitPrice: limitPriceValue
        };

        await submitLimitOrder(tradeData);
        return;
    }

    // Original market order logic below...
    // Check if market is open (status 0 = Premarket, 1 = Open, 2 = Stopped)
    // Trading is allowed in both Premarket (0) and Open (1) states
    if (currentMarketStatus !== 0 && currentMarketStatus !== 1) {
        addLog('ERROR: Market is not open for trading (status: ' + currentMarketStatus + ')', 'error');
        showError('Market closed');
        return;
    }

    // Check if trading is locked (90 slots before market end)
    if (await isTradingLocked()) {
        addLog('ERROR: Trading is locked - market is closing soon', 'error');
        showToast('error', '🔒 Trading Locked', 'Market is closing soon. Trading locked to prevent last-second manipulation.');
        return;
    }

    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    // Get number of shares from input
    const numShares = parseFloat(document.getElementById('tradeAmountShares').value);
    if (isNaN(numShares) || numShares <= 0) {
        addLog('ERROR: Invalid number of shares', 'error');
        showError('Invalid shares');
        return;
    }

    // Use current action and side
    const action = currentAction;
    const side = currentSide;
    const sharePrice = side === 'yes' ? currentYesPrice : currentNoPrice;

    // For BUY: pass spending amount in e6. For SELL: pass number of shares in e6
    let amount_e6;
    let estimatedCost;

    if (action === 'buy') {
        // NEW: For BUY, send SHARES (not spend) - on-chain will calculate exact cost
        console.log(`[BUY CALCULATION DEBUG] Buying exact shares: ${numShares}`);
        console.log(`[BUY CALCULATION DEBUG] Current B (e6): ${currentB} → ${(currentB/10_000_000).toFixed(2)} shares`);
        console.log(`[BUY CALCULATION DEBUG] Current Q_YES (e6): ${currentQYes} → ${(currentQYes/10_000_000).toFixed(2)} shares`);
        console.log(`[BUY CALCULATION DEBUG] Current Q_NO (e6): ${currentQNo} → ${(currentQNo/10_000_000).toFixed(2)} shares`);

        // Convert shares to e6 units (amount now represents SHARES, not spend!)
        amount_e6 = Math.floor(numShares * 10_000_000);

        // Estimate cost for display purposes only (on-chain does exact calculation)
        estimatedCost = calculateSpendForShares(side, numShares);

        console.log(`[BUY CALCULATION DEBUG] Shares to buy (e6): ${amount_e6}`);
        console.log(`[BUY CALCULATION DEBUG] Estimated cost: ${estimatedCost.toFixed(6)} XNT (on-chain will calculate exact)`);

        // Validate against contract limits (shares now, not spend)
        const MAX_SHARES_E6 = 50_000_000_000; // 50k shares max
        const MIN_SHARES_E6 = 100_000; // 0.1 shares min

        if (amount_e6 > MAX_SHARES_E6) {
            addLog(`ERROR: Share amount ${amount_e6} exceeds max ${MAX_SHARES_E6}`, 'error');
            showError(`Trade too large (max 50k shares)`);
            return;
        }
        if (amount_e6 < MIN_SHARES_E6) {
            addLog(`ERROR: Share amount ${amount_e6} below min ${MIN_SHARES_E6}`, 'error');
            showError(`Trade too small (min 0.1 shares)`);
            return;
        }

        // Check if user has sufficient balance IN VAULT (not session wallet)
        const currentBalance = window.walletBalance || 0;
        console.log(`[BUY CALCULATION DEBUG] User vault balance: ${currentBalance.toFixed(6)} XNT`);
        console.log(`[BUY CALCULATION DEBUG] Required (with slippage): ${estimatedCost.toFixed(6)} XNT`);

        if (estimatedCost > currentBalance) {
            const shortfall = estimatedCost - currentBalance;
            addLog(`ERROR: Insufficient VAULT balance. Need ${estimatedCost.toFixed(4)} XNT in vault, have ${currentBalance.toFixed(4)} XNT (short ${shortfall.toFixed(4)} XNT)`, 'error');
            addLog(`💡 TIP: Use the DEPOSIT button to transfer XNT from your wallet to your trading vault`, 'info');
            showError(`Insufficient vault: need ${estimatedCost.toFixed(2)} XNT, have ${currentBalance.toFixed(2)} XNT. Click DEPOSIT.`);
            showToast(
                'error',
                '🚫 Not Enough Funds',
                `Need ${estimatedCost.toFixed(2)} XNT in vault, have ${currentBalance.toFixed(2)} XNT. Use DEPOSIT to add funds.`
            );
            return;
        }

        addLog(`Calculated: ${numShares} shares → ${estimatedCost.toFixed(4)} XNT (${amount_e6} e6)`, 'info');
    } else {
        // For selling, pass number of shares
        // 1 share = 10_000_000 e6 units (LAMPORTS scale matching contract)
        amount_e6 = Math.floor(numShares * 10_000_000);

        // Calculate expected proceeds using LMSR formula
        const expectedProceeds = calculateSellProceeds(side, numShares);
        const expectedProceedsE6 = Math.floor(expectedProceeds * 10_000_000);

        console.log(`[SELL VALIDATION]`);
        console.log(`  Selling: ${numShares} ${side.toUpperCase()} shares`);
        console.log(`  Expected proceeds: ${expectedProceeds.toFixed(6)} XNT (${expectedProceedsE6} e6)`);
        console.log(`  Vault balance: ${(currentVaultE6/10_000_000).toFixed(6)} XNT (${currentVaultE6} e6)`);
        console.log(`  Current Q_YES: ${(currentQYes/10_000_000).toFixed(2)}, Q_NO: ${(currentQNo/10_000_000).toFixed(2)}`);
        console.log(`  Current B: ${(currentB/10_000_000).toFixed(2)}`);

        // Removed preflight vault coverage check - let the on-chain program handle it
        // This allows sells to proceed and get proper error messages from the contract

        estimatedCost = expectedProceeds;

        console.log(`[SELL] Proceeding with transaction (on-chain validation will check vault coverage)`);
    }

    // Prepare trade data
    const tradeData = {
        action,
        side,
        numShares,
        shares: numShares,
        pricePerShare: sharePrice,
        totalCost: estimatedCost,
        amount_e6
    };

    // Check rapid fire mode (use window.rapidFireMode to support both inline and external usage)
    const isRapidFire = typeof window !== 'undefined' && window.rapidFireMode !== undefined
        ? window.rapidFireMode
        : rapidFireMode;

    if (!isRapidFire) {
        // Show confirmation modal
        if (debugMode) {
            console.log('[Trade] Rapid fire OFF - showing confirmation modal');
        }
        openTradeConfirmModal(tradeData);
        return;
    }

    // Rapid fire mode ON - execute immediately
    if (debugMode) {
        console.log('[Trade] Rapid fire ON - executing immediately');
    }
    await executeTradeInternal(tradeData);
}

// Internal function that performs the actual trade execution
// Expose to window for index.html inline script
async function executeTradeInternal(tradeData) {
    const { action, side, numShares, pricePerShare, totalCost, amount_e6 } = tradeData;
    const sharePrice = pricePerShare;
    const estimatedCost = totalCost;

    const tradeDesc = `${action.toUpperCase()} ${numShares} ${side.toUpperCase()} shares (~${estimatedCost.toFixed(2)} XNT)`;
    const startTime = new Date();
    const startTimestamp = startTime.toTimeString().split(' ')[0] + '.' + startTime.getMilliseconds().toString().padStart(3, '0');
    addLog(`Executing trade [${startTimestamp}]: ${tradeDesc}`, 'info');
    showStatus('Executing trade...');

    // Get position before trade for comparison
    const positionBefore = await getPositionShares();

    try {
        const sideNum = side === 'yes' ? 1 : 2;
        const actionNum = action === 'buy' ? 1 : 2;

        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        // Check if position account exists, if not initialize it
        const positionExists = await connection.getAccountInfo(posPda);
        if (!positionExists) {
            addLog('Position not initialized. Initializing now...', 'info');
            const initSuccess = await initPosition();
            if (!initSuccess) {
                addLog('ERROR: Failed to initialize position. Cannot trade.', 'error');
                showError('Position initialization failed');
                return;
            }
            // Wait a bit for the position to be created
            await new Promise(r => setTimeout(r, 1000));
            addLog('Position initialized successfully! Proceeding with trade...', 'success');
        }

        const discriminator = await createDiscriminator('trade');

        // Create amount buffer (8 bytes, little endian)
        const amountBuf = new Uint8Array(8);
        const view = new DataView(amountBuf.buffer);
        view.setBigInt64(0, BigInt(amount_e6), true); // true = little endian

        console.log(`[TRANSACTION DATA]`);
        console.log(`  Side: ${side} (${sideNum}), Action: ${action} (${actionNum})`);
        console.log(`  Amount e6: ${amount_e6} → ${(amount_e6/10_000_000).toFixed(6)} XNT`);
        console.log(`  Amount BigInt: ${BigInt(amount_e6)}`);

        const data = concatUint8Arrays(
            discriminator,
            new Uint8Array([sideNum]),
            new Uint8Array([actionNum]),
            amountBuf
        );

        const feeDest = await getFeeDest();

        // Calculate user_vault PDA
        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },  // user_vault PDA
            { pubkey: feeDest, isSigner: false, isWritable: true },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: new solanaWeb3.PublicKey(CONFIG.ORACLE_STATE), isSigner: false, isWritable: false },  // oracle_state for timestamp
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: solanaWeb3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        // Add unique memo instruction to prevent duplicate transaction signatures
        const nonce = Math.floor(Math.random() * 256).toString();
        const encoder = new TextEncoder();
        const memoInstruction = new solanaWeb3.TransactionInstruction({
            keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
            programId: new solanaWeb3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            data: encoder.encode(nonce)
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, memoInstruction, instruction);
        transaction.feePayer = wallet.publicKey;  // Session wallet pays fees (has 1.01 XNT reserve)
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        const submitTime = new Date();
        const submitTimestamp = submitTime.toTimeString().split(' ')[0] + '.' + submitTime.getMilliseconds().toString().padStart(3, '0');
        addLog(`Submitting transaction [${submitTimestamp}]...`, 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        addLog('TX: ' + signature, 'tx');

        const confirmTime = new Date();
        const confirmTimestamp = confirmTime.toTimeString().split(' ')[0] + '.' + confirmTime.getMilliseconds().toString().padStart(3, '0');
        addLog(`Confirming transaction [${confirmTimestamp}]...`, 'info');

        // Use a longer timeout (60 seconds) and better error handling
        let confirmed = false;
        try {
            await connection.confirmTransaction({
                signature,
                blockhash: transaction.recentBlockhash,
                lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
            }, 'confirmed');
            confirmed = true;
        } catch (confirmErr) {
            // Confirmation timed out - check if transaction actually succeeded
            addLog('Confirmation timeout - checking transaction status...', 'info');
            try {
                const status = await connection.getSignatureStatus(signature);
                if (status && status.value && status.value.confirmationStatus) {
                    confirmed = true;
                    addLog(`Transaction succeeded (status: ${status.value.confirmationStatus})`, 'success');
                } else {
                    // Re-throw if transaction genuinely failed
                    throw confirmErr;
                }
            } catch (statusErr) {
                // If we can't check status, throw original error
                throw confirmErr;
            }
        }

        if (confirmed) {
            // Get current time with milliseconds
            const now = new Date();
            const timestamp = now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');
            addLog(`Trade SUCCESS [${timestamp}]: ${tradeDesc}`, 'success');
            showStatus(`Trade success: ${signature.substring(0, 16)}... [${timestamp}]`);

            // Show toast notification
            const estimatedPrice = numShares > 0 ? Math.abs(estimatedCost) / numShares : 0;
            const actionText = action.toUpperCase();
            const sideText = side === 'yes' ? 'UP' : 'DOWN';
            const toastTitle = `${actionText} ${sideText} Success`;
            const toastMessage = `${numShares.toFixed(2)} shares @ ~$${estimatedPrice.toFixed(4)}`;
            showToast('success', toastTitle, toastMessage);

            // Note: Position will be updated via SSE with ACTUAL avgPrice from on-chain logs
            // SSE provides accurate execution prices - we don't use client-side estimates

            // Volume is updated by trade_monitor.js (reads from on-chain logs)
            // Don't update here to avoid double-counting
        }

        // Update last trade info
        updateLastTradeInfo(action, side, numShares, estimatedCost);

        // Refresh data after trade
        setTimeout(async () => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();
        }, 1000);

    } catch (err) {
        // Better error messages
        const now = new Date();
        const timestamp = now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');
        let errorMsg = err.message;
        if (errorMsg.includes('TransactionExpiredTimeoutError') || errorMsg.includes('was not confirmed')) {
            errorMsg = 'Transaction confirmation timed out. Check Explorer to verify if transaction succeeded.';
            addLog(`ERROR [${timestamp}]: ${errorMsg}`, 'error');
        } else {
            addLog(`Trade FAILED [${timestamp}]: ${errorMsg}`, 'error');
        }

        showError(`Trade error [${timestamp}] - check logs`);

        // Show error toast
        const actionText = currentAction ? currentAction.toUpperCase() : 'TRADE';
        const sideText = currentSide === 'yes' ? 'UP' : 'DOWN';
        const shortError = errorMsg.length > 60 ? errorMsg.substring(0, 60) + '...' : errorMsg;
        showToast('error', `${actionText} ${sideText} Issue`, shortError);

        console.error('ERROR: Trade failed:', err);
    }
}

// Expose executeTradeInternal to window for index.html inline script
if (typeof window !== 'undefined') {
    window.executeTradeInternal = executeTradeInternal;
}

// Open close position modal with estimates (called by button click)
async function closePosition() {
    console.log('[CLOSE POSITION MODAL] Opening confirmation modal...');

    // Check if market is open
    if (currentMarketStatus !== 0 && currentMarketStatus !== 1) {
        addLog('ERROR: Market is not open for trading (status: ' + currentMarketStatus + ')', 'error');
        showError('Market closed');
        return;
    }

    // Check if trading is locked (90 slots before market end)
    if (await isTradingLocked()) {
        addLog('ERROR: Trading is locked - market is closing soon', 'error');
        showToast('error', '🔒 Trading Locked', 'Market is closing soon. Trading locked to prevent last-second manipulation.');
        return;
    }

    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    // Get current positions
    const yesSharesE6 = parseFloat(document.getElementById('posYesDisplay').textContent.replace(/[^\d.-]/g, '')) || 0;
    const noSharesE6 = parseFloat(document.getElementById('posNoDisplay').textContent.replace(/[^\d.-]/g, '')) || 0;

    console.log('[CLOSE POSITION MODAL] Current positions - YES:', yesSharesE6, 'NO:', noSharesE6);

    if (yesSharesE6 === 0 && noSharesE6 === 0) {
        addLog('ERROR: No positions to close', 'error');
        showError('No positions');
        return;
    }

    // Calculate estimated proceeds
    let estimatedProceeds = 0;

    // Estimate YES shares sell proceeds
    if (yesSharesE6 > 0) {
        const yesSharesCount = yesSharesE6;
        const yesProceeds = calculateSellProceeds('yes', yesSharesCount);
        estimatedProceeds += yesProceeds;
        console.log('[CLOSE POSITION MODAL] YES estimated proceeds:', yesProceeds.toFixed(6), 'XNT');
    }

    // Estimate NO shares sell proceeds
    if (noSharesE6 > 0) {
        const noSharesCount = noSharesE6;
        const noProceeds = calculateSellProceeds('no', noSharesCount);
        estimatedProceeds += noProceeds;
        console.log('[CLOSE POSITION MODAL] NO estimated proceeds:', noProceeds.toFixed(6), 'XNT');
    }

    console.log('[CLOSE POSITION MODAL] Total estimated proceeds:', estimatedProceeds.toFixed(6), 'XNT');

    // Update modal content
    document.getElementById('closeYesShares').textContent = yesSharesE6.toFixed(2);
    document.getElementById('closeNoShares').textContent = noSharesE6.toFixed(2);
    document.getElementById('closeEstimatedProceeds').textContent = '~' + estimatedProceeds.toFixed(4) + ' XNT';

    // Show modal
    document.getElementById('closePositionModal').classList.remove('hidden');
}

// Close the close position modal
function closeClosePositionModal() {
    document.getElementById('closePositionModal').classList.add('hidden');
}

// Execute close position (called from modal confirm button)
async function executeClosePosition() {
    console.log('[CLOSE POSITION] Executing position closure...');

    // Close modal immediately
    closeClosePositionModal();

    try {
        addLog('🔒 Closing all positions...', 'info');
        console.log('[CLOSE POSITION] Building transaction...');

        // Derive PDAs
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const feeDest = await getFeeDest();

        console.log('[CLOSE POSITION] AMM PDA:', ammPda.toString());
        console.log('[CLOSE POSITION] Position PDA:', posPda.toString());
        console.log('[CLOSE POSITION] User Vault PDA:', userVaultPda.toString());
        console.log('[CLOSE POSITION] Vault SOL PDA:', vaultPda.toString());

        // Build close_position instruction
        const discriminator = await createDiscriminator('close_position');
        const oraclePk = new solanaWeb3.PublicKey(CONFIG.ORACLE_STATE);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },
            { pubkey: feeDest, isSigner: false, isWritable: true },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: oraclePk, isSigner: false, isWritable: false },  // Oracle for lockout check
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: solanaWeb3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator  // No additional data needed
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        console.log('[CLOSE POSITION] Submitting transaction...');
        addLog('Submitting transaction...', 'tx');

        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        addLog('TX: ' + signature, 'tx');

        addLog('Confirming transaction...', 'info');
        console.log('[CLOSE POSITION] Waiting for confirmation...');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog('✅ Position closed successfully!', 'success');
        console.log('[CLOSE POSITION] Position closed successfully! TX:', signature);

        showToast('success', '🔒 Position Closed', `All shares sold. TX: ${signature.substring(0, 8)}...`);

        // Refresh UI data
        setTimeout(() => {
            fetchMarketData();
        }, 1000);

    } catch (err) {
        console.error('[CLOSE POSITION] Error:', err);
        addLog('ERROR: Failed to close position - ' + err.message, 'error');

        let errorMsg = err.message || 'Unknown error';
        if (err.logs) {
            console.error('[CLOSE POSITION] Transaction logs:', err.logs);
            errorMsg = err.logs.join(' | ');
        }

        const shortError = errorMsg.length > 60 ? errorMsg.substring(0, 60) + '...' : errorMsg;
        showToast('error', 'Close Position Failed', shortError);
    }
}

async function snapshotStart() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    addLog('Taking oracle price snapshot...', 'info');
    showStatus('Taking snapshot...');

    try {
        const discriminator = await createDiscriminator('snapshot_start');
        const oraclePk = new solanaWeb3.PublicKey(CONFIG.ORACLE_STATE);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: oraclePk, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        const transaction = new solanaWeb3.Transaction().add(instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting snapshot transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog('Snapshot SUCCESS: Oracle price recorded', 'success');
        showStatus('Snapshot taken: ' + signature.substring(0, 16) + '...');
        setTimeout(fetchMarketData, 1000);

    } catch (err) {
        addLog('Snapshot FAILED: ' + err.message, 'error');
        showError('Snapshot failed: ' + err.message);
        console.error(err);
    }
}

async function stopMarket() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    addLog('Stopping market trading...', 'info');
    showStatus('Stopping market...');

    try {
        const discriminator = await createDiscriminator('stop_market');

        // Debug: log discriminator
        const discHex = Array.from(discriminator).map(b => b.toString(16).padStart(2, '0')).join('');
        addLog(`Discriminator: ${discHex}`, 'info');

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        const budgetIxs = createComputeBudgetInstructions(200000, 0);
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting stop market transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog('Stop Market SUCCESS: Trading halted', 'success');
        showStatus('Market stopped: ' + signature.substring(0, 16) + '...');
        setTimeout(fetchMarketData, 1000);

    } catch (err) {
        addLog('Stop Market FAILED: ' + err.message, 'error');
        showError('Stop failed: ' + err.message);
        console.error(err);
    }
}

async function redeemWinnings() {
    // Check if market is settled
    if (currentMarketStatus !== 2) {
        addLog('ERROR: Market is not settled yet', 'error');
        showError('Market not settled');
        return;
    }

    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    try {
        // Capture position data BEFORE redemption
        const balanceBefore = await connection.getBalance(wallet.publicKey);
        const positionBefore = await getPositionShares();
        const yesShares = positionBefore ? positionBefore.yes : 0;
        const noShares = positionBefore ? positionBefore.no : 0;
        const vaultBalance = positionBefore ? positionBefore.vault : 0;
        const totalShares = yesShares + noShares;

        addLog('Redeeming winnings...', 'info');
        showStatus('Redeeming...');

        const discriminator = await createDiscriminator('redeem');
        const feeDest = await getFeeDest();

        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: feeDest, isSigner: false, isWritable: true },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: solanaWeb3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');

        // Calculate profit/loss
        setTimeout(async () => {
            const balanceAfter = await connection.getBalance(wallet.publicKey);
            const balanceChange = (balanceAfter - balanceBefore) / 1e9; // Convert lamports to SOL
            const winningsXNT = balanceChange; // In XNT (assuming 1 SOL = 1 XNT for display)

            // Determine which side won based on current winning_side
            const winningSide = currentWinningSide; // 'yes' or 'no'
            const winningSideText = winningSide === 'yes' ? 'UP' : 'DOWN';
            const userWinningShares = winningSide === 'yes' ? yesShares : noShares;
            const userLosingShares = winningSide === 'yes' ? noShares : yesShares;

            if (balanceChange > 0.001) {
                // USER WON
                addLog(`✅ WINNER! ${userWinningShares.toFixed(2)} ${winningSideText} shares won ${winningsXNT.toFixed(4)} XNT`, 'success');
                showToast('success', '🎉 You Won!', `${userWinningShares.toFixed(2)} ${winningSideText} shares → +${winningsXNT.toFixed(4)} XNT`);
            } else if (balanceChange < -0.001) {
                // USER LOST (unlikely, but handle edge cases like fees)
                const lossAmount = Math.abs(balanceChange);
                addLog(`❌ LOSS: ${totalShares.toFixed(2)} shares lost ${lossAmount.toFixed(4)} XNT`, 'error');
                showToast('error', '📉 You Lost', `Lost ${lossAmount.toFixed(4)} XNT`);
            } else {
                // BREAK EVEN or had no winning shares
                if (totalShares > 0.01) {
                    addLog(`➖ Position closed. ${totalShares.toFixed(2)} shares had no value (wrong side won)`, 'info');
                    showToast('info', '📊 Position Closed', `${userLosingShares.toFixed(2)} ${winningSide === 'yes' ? 'DOWN' : 'UP'} shares were worthless`);
                } else {
                    addLog('Position redeemed (no shares)', 'info');
                    showToast('info', '✓ Redeemed', 'Position cleared');
                }
            }

            addLog('Redeem SUCCESS! Position wiped.', 'success');
            showStatus('Redeem success');

            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();
        }, 1500);

    } catch (err) {
        addLog('Redeem FAILED: ' + err.message, 'error');
        showError('Redeem failed');
        console.error(err);
    }
}

async function settleByOracle() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    addLog('Settling market by oracle price...', 'info');
    showStatus('Settling by oracle...');

    try {
        const discriminator = await createDiscriminator('settle_by_oracle');
        const oraclePk = new solanaWeb3.PublicKey(CONFIG.ORACLE_STATE);

        const data = concatUint8Arrays(
            discriminator,
            new Uint8Array([1]) // ge_wins_yes
        );

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: oraclePk, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        const budgetIxs = createComputeBudgetInstructions(200000, 0);
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting settlement transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog('Settlement SUCCESS: Market resolved by oracle', 'success');
        addLog('Winners can now click "Redeem Winnings" to claim', 'info');
        showStatus('Market settled: ' + signature.substring(0, 16) + '...');

    } catch (err) {
        addLog('Settlement FAILED: ' + err.message, 'error');
        showError('Settle failed: ' + err.message);
        console.error(err);
    }
}

// ============= WITHDRAWAL =============

async function withdrawToBackpack() {
    if (!wallet || !backpackWallet) {
        addLog('ERROR: No wallet connected for withdrawal', 'error');
        showError('No wallet connected');
        return;
    }

    const amountInput = document.getElementById('withdrawAmount').value;
    const amount = parseFloat(amountInput);

    if (!amountInput || isNaN(amount) || amount <= 0) {
        addLog('ERROR: Invalid withdrawal amount', 'error');
        showError('Invalid withdrawal amount');
        return;
    }

    const lamports = Math.floor(amount * solanaWeb3.LAMPORTS_PER_SOL);

    try {
        // Get Position account
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const positionAccount = await connection.getAccountInfo(posPda);
        if (!positionAccount) {
            addLog('ERROR: Position account not found', 'error');
            showError('Position not initialized');
            return;
        }

        // Check vault balance
        const position = await fetchPositionAccount();
        if (!position || position.vault_balance_e6 === undefined) {
            addLog('ERROR: Could not read vault balance', 'error');
            showError('Failed to read vault balance');
            return;
        }

        const vaultBalanceLamports = Math.floor((position.vault_balance_e6 / 1e7) * solanaWeb3.LAMPORTS_PER_SOL);

        console.log('[withdrawToBackpack] Vault balance:', position.vault_balance_e6, 'e6 =', vaultBalanceLamports, 'lamports');
        console.log('[withdrawToBackpack] Requested withdrawal:', lamports, 'lamports');

        if (lamports > vaultBalanceLamports) {
            addLog(`ERROR: Insufficient vault balance. Have ${(vaultBalanceLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4)} XNT, need ${amount.toFixed(4)} XNT`, 'error');
            showError('Insufficient vault balance');
            return;
        }

        // Get user_vault PDA
        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        console.log('[withdrawToBackpack] Position PDA:', posPda.toString());
        console.log('[withdrawToBackpack] User Vault PDA:', userVaultPda.toString());

        // SECURITY: Verify wallet ownership before withdrawal
        addLog('Requesting signature for withdrawal verification...', 'info');
        showStatus('Please sign the verification message in your wallet...');

        try {
            const timestamp = Date.now();
            const verificationMessage = `X1 Markets Withdrawal Verification\n\nWithdraw: ${amount.toFixed(4)} XNT\nTo: ${backpackWallet.publicKey.toString()}\nFrom Session: ${wallet.publicKey.toString()}\nTimestamp: ${timestamp}\n\nSign to confirm you own this wallet.`;
            const encodedMessage = new TextEncoder().encode(verificationMessage);

            const verificationSignature = await backpackWallet.signMessage(encodedMessage);

            if (!verificationSignature || verificationSignature.length === 0) {
                addLog('ERROR: Invalid signature response from wallet', 'error');
                showError('Security error: Invalid signature');
                return;
            }

            addLog('✓ Wallet verified successfully', 'success');
        } catch (err) {
            addLog('ERROR: User rejected signature or verification failed', 'error');
            showError('Withdrawal cancelled: ' + err.message);
            return;
        }

        addLog(`Withdrawing ${amount.toFixed(4)} XNT from vault to your wallet...`, 'info');
        showStatus('Withdrawing ' + amount.toFixed(4) + ' XNT from vault to your wallet...');

        // Create withdraw instruction
        const discriminator = await createDiscriminator('withdraw');
        const amountBuffer = new ArrayBuffer(8);
        const amountView = new DataView(amountBuffer);
        amountView.setBigUint64(0, BigInt(lamports), true);

        const data = new Uint8Array(discriminator.length + 8);
        data.set(discriminator, 0);
        data.set(new Uint8Array(amountBuffer), discriminator.length);

        console.log('[withdrawToBackpack] Instruction data:', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },  // session wallet (mut in Rust)
            { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true },  // master wallet receives
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const withdrawIx = new solanaWeb3.TransactionInstruction({
            keys,
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            data,
        });

        const tx = new solanaWeb3.Transaction().add(withdrawIx);
        tx.feePayer = backpackWallet.publicKey;  // Backpack pays transaction fees
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        // Sign with session wallet first
        tx.sign(wallet);

        addLog('Requesting signature for withdrawal transaction...', 'info');
        showStatus('Please approve withdrawal in your wallet...');

        // Then sign with Backpack
        const fullySignedTx = await backpackWallet.signTransaction(tx);

        addLog('Submitting withdrawal transaction...', 'tx');
        const signature = await connection.sendRawTransaction(fullySignedTx.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        addLog('TX: ' + signature, 'tx');

        addLog('Confirming transaction...', 'info');
        await connection.confirmTransaction(signature, 'confirmed');

        addLog(`Withdrawal SUCCESS: ${amount.toFixed(4)} XNT transferred from vault to your wallet`, 'success');
        showStatus('Withdrawal success! Tx: ' + signature.substring(0, 16) + '...');

        // Show toast notification
        showToast('success', 'Withdrawal Complete', `${amount.toFixed(4)} XNT transferred to your wallet`);

        // Clear input and update balance
        document.getElementById('withdrawAmount').value = '';

        // Update balance multiple times to ensure it catches the on-chain update
        setTimeout(async () => {
            await updateWalletBalance();
        }, 1000);
        setTimeout(async () => {
            await updateWalletBalance();
        }, 3000);
        setTimeout(async () => {
            await updateWalletBalance();
        }, 6000);

    } catch (err) {
        addLog('Withdrawal FAILED: ' + err.message, 'error');
        showError('Withdrawal failed: ' + err.message);
        showToast('error', 'Withdrawal Failed', err.message);
        console.error('Withdrawal error:', err);
    }
}

// ============= INITIALIZATION FUNCTIONS =============

async function initAmm(bScaled = 500_000_000, feeBps = 25) {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        return false;
    }

    try {
        addLog(`Initializing AMM: b=${bScaled/1_000_000}, fee=${feeBps}bps`, 'info');

        const discriminator = await createDiscriminator('init_amm');
        const feeDest = wallet.publicKey; // Use wallet pubkey as fee dest during initialization

        // Create b_scaled buffer (8 bytes, little endian)
        const bBuf = new Uint8Array(8);
        const bView = new DataView(bBuf.buffer);
        bView.setBigInt64(0, BigInt(bScaled), true);

        // Create fee_bps buffer (2 bytes, little endian)
        const feeBuf = new Uint8Array(2);
        const feeView = new DataView(feeBuf.buffer);
        feeView.setUint16(0, feeBps, true);

        const data = concatUint8Arrays(discriminator, bBuf, feeBuf);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: feeDest, isSigner: false, isWritable: true },
            { pubkey: vaultPda, isSigner: false, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting init AMM transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');
        addLog('AMM initialized successfully!', 'success');

        // Cache the fee dest for future transactions
        cachedFeeDest = feeDest;

        return true;

    } catch (err) {
        addLog('Init AMM FAILED: ' + err.message, 'error');
        console.error('Init AMM error:', err);
        return false;
    }
}

async function initPosition() {
    if (!wallet || !backpackWallet) {
        addLog('ERROR: No wallet connected', 'error');
        return false;
    }

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        // Check if position already exists
        const accountInfo = await connection.getAccountInfo(posPda);
        if (accountInfo) {
            addLog('Position already exists', 'info');
            return true;
        }

        addLog('Initializing position account...', 'info');

        // Calculate user_vault PDA
        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const discriminator = await createDiscriminator('init_position');

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: false }, // user_vault PDA
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true }, // master_wallet (pays rent)
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        // Also fund session wallet with small amount for transaction fees (1.01 XNT)
        const feeReserve = 1.01 * solanaWeb3.LAMPORTS_PER_SOL;
        const fundSessionIx = solanaWeb3.SystemProgram.transfer({
            fromPubkey: backpackWallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: feeReserve
        });

        const budgetIxs = createComputeBudgetInstructions(200000, 0);
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, fundSessionIx, instruction);
        transaction.feePayer = backpackWallet.publicKey; // Backpack pays fees
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        // Sign with session wallet first
        transaction.sign(wallet);

        // Then sign with Backpack
        const signedTx = await backpackWallet.signTransaction(transaction);

        addLog('Submitting init position transaction (+ funding session wallet with 1.01 XNT for fees)...', 'tx');
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');
        addLog('Position initialized! Session wallet funded with 1.01 XNT for transaction fees.', 'success');
        return true;

    } catch (err) {
        addLog('Init Position FAILED: ' + err.message, 'error');
        console.error('Init position error:', err);
        return false;
    }
}

async function wipePosition() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        return false;
    }

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        // Check if position exists
        const posInfo = await connection.getAccountInfo(posPda);
        if (!posInfo) {
            addLog('Position does not exist, nothing to wipe', 'info');
            return true;
        }

        addLog('Wiping position shares...', 'info');

        const discriminator = await createDiscriminator('wipe_position');

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // admin
            { pubkey: wallet.publicKey, isSigner: false, isWritable: false }, // owner (can be same as admin)
            { pubkey: posPda, isSigner: false, isWritable: true },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting wipe position transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');
        addLog('Position wiped successfully!', 'success');
        return true;

    } catch (err) {
        addLog('Wipe Position FAILED: ' + err.message, 'error');
        console.error('Wipe position error:', err);
        return false;
    }
}

async function closeAmm() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        return false;
    }

    try {
        // Check if AMM exists
        const ammInfo = await connection.getAccountInfo(ammPda);
        if (!ammInfo) {
            addLog('AMM does not exist, nothing to close', 'info');
            return false;
        }

        addLog('Closing AMM account...', 'info');

        const discriminator = await createDiscriminator('close_amm');

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data: discriminator
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting close AMM transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');
        addLog('AMM closed successfully!', 'success');
        return true;

    } catch (err) {
        addLog('Close AMM FAILED: ' + err.message, 'error');
        console.error('Close AMM error:', err);
        return false;
    }
}

async function restartMarket() {
    if (!wallet) {
        addLog('ERROR: Connect wallet first!', 'error');
        return;
    }

    addLog('=== Restarting market ===', 'info');

    // Clear cached fee destination since we're creating a new market
    cachedFeeDest = null;

    try {
        // Step 1: Close existing market
        const closeSuccess = await closeAmm();
        if (!closeSuccess) {
            addLog('Could not close market, attempting to initialize anyway...', 'warning');
        }

        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Initialize new market with default parameters
        const initSuccess = await initAmm(500_000_000, 25);
        if (!initSuccess) {
            addLog('Failed to initialize new market', 'error');
            return;
        }

        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Initialize position for current user (creates new if doesn't exist)
        const posSuccess = await initPosition();
        if (!posSuccess) {
            addLog('Failed to initialize position', 'error');
            return;
        }

        await new Promise(r => setTimeout(r, 1000));

        // Step 4: Take snapshot automatically
        addLog('Taking oracle snapshot...', 'info');
        await snapshotStart();

        addLog('=== Market restarted successfully! ===', 'success');

        setTimeout(() => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();

            // If positions tab is active, reload it immediately
            if (currentFeedTab === 'positions') {
                loadPositions();
            }
        }, 1000);

    } catch (err) {
        addLog('Restart FAILED: ' + err.message, 'error');
        console.error('Restart error:', err);
    }
}

async function debugInit() {
    if (!wallet) {
        addLog('ERROR: Connect wallet first!', 'error');
        return;
    }

    addLog('=== DEBUG: Starting market initialization ===', 'info');

    // Clear cached fee destination in case we're reinitializing
    cachedFeeDest = null;

    try {
        // Step 1: Check wallet balance
        const balance = await connection.getBalance(wallet.publicKey);
        const solBalance = balance / solanaWeb3.LAMPORTS_PER_SOL;
        addLog(`Wallet balance: ${solBalance.toFixed(4)} XNT`, 'info');

        if (solBalance < 0.1) {
            addLog(`WARNING: Low balance! You need at least 0.1 XNT. Please fund from your wallet.`, 'warning');
            addLog(`Current session wallet: ${wallet.publicKey.toString()}`, 'info');
            return;
        }

        // Step 2: Check if AMM exists, if not create it
        const ammInfo = await connection.getAccountInfo(ammPda);
        if (!ammInfo) {
            addLog('AMM not found, initializing...', 'info');
            const initSuccess = await initAmm(500_000_000, 25);
            if (!initSuccess) {
                addLog('Failed to initialize AMM', 'error');
                return;
            }
            await new Promise(r => setTimeout(r, 1000));
        } else {
            addLog('AMM already exists', 'success');
        }

        // Step 3: Initialize position
        const posSuccess = await initPosition();
        if (!posSuccess) {
            addLog('Failed to initialize position', 'error');
            return;
        }

        await new Promise(r => setTimeout(r, 1000));

        // Step 4: Test BUY YES trade
        addLog('Testing BUY YES $1.00 trade...', 'info');
        document.getElementById('tradeAmountShares').value = '10';
        selectOutcome('yes');
        switchTab('buy');
        await executeTrade();

        await new Promise(r => setTimeout(r, 2000));

        // Step 5: Test BUY NO trade
        addLog('Testing BUY NO $1.00 trade...', 'info');
        document.getElementById('tradeAmountShares').value = '10';
        selectOutcome('no');
        switchTab('buy');
        await executeTrade();

        addLog('=== DEBUG: Initialization complete! ===', 'success');
        setTimeout(() => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();
        }, 2000);

    } catch (err) {
        addLog('DEBUG FAILED: ' + err.message, 'error');
        console.error('Debug error:', err);
    }
}

// ============= MARKET CYCLE STATUS =============

async function displaySettledMarketWinner(winner, startPriceE6) {
    const bannerEl = document.getElementById('winnerBanner');
    const outcomeEl = document.getElementById('winnerOutcome');
    const reasonEl = document.getElementById('winnerReason');

    if (!bannerEl || !outcomeEl || !reasonEl) return;

    try {
        // Fetch current oracle price as settle price
        const response = await fetch(`${CONFIG.API_PREFIX}/current-price?t=${Date.now()}`);
        if (!response.ok) return;

        const oracle = await response.json();
        const settlePriceE6 = oracle.price_e6;

        const startPrice = startPriceE6 / 1_000_000;
        const settlePrice = settlePriceE6 / 1_000_000;

        const startPriceStr = startPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const settlePriceStr = settlePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const winnerText = winner === 1 ? 'UP' : 'DOWN';
        const arrow = settlePrice > startPrice ? '↗' : settlePrice < startPrice ? '↘' : '→';

        // Winner banner disabled - no longer showing "UP WON" / "DOWN WON" messages
        bannerEl.style.display = 'none';
    } catch (err) {
        console.error('Failed to display winner banner:', err);
    }
}

// SSE connection for market status updates
let statusEventSource = null;

function initStatusStream() {
    const streamUrl = `${CONFIG.API_PREFIX}/cycle-stream`;
    console.log('Connecting to market status stream:', streamUrl);

    statusEventSource = new EventSource(streamUrl);

    statusEventSource.onmessage = (event) => {
        try {
            const status = JSON.parse(event.data);
            updateCycleDisplay(status);
        } catch (err) {
            console.error('Failed to parse status update:', err);
        }
    };

    statusEventSource.onerror = (err) => {
        console.error('Status stream error:', err);
        updateCycleDisplay({ state: 'OFFLINE' });

        // Reconnect after 5 seconds
        setTimeout(() => {
            if (statusEventSource) {
                statusEventSource.close();
            }
            initStatusStream();
        }, 5000);
    };

    statusEventSource.onopen = () => {
        console.log('Market status stream connected');
    };
}

// Legacy polling function (kept for fallback)
async function fetchCycleStatus() {
    try {
        const response = await fetch(CONFIG.STATUS_URL + '?t=' + Date.now());
        if (!response.ok) {
            throw new Error('Status file not found');
        }
        const status = await response.json();
        updateCycleDisplay(status);
    } catch (err) {
        // Status file doesn't exist yet or settlement bot not running
        updateCycleDisplay({ state: 'OFFLINE' });
    }
}

// Track which resolution has been shown to prevent multiple timeouts
let lastShownResolutionTimestamp = null;

function updateWinnerBanner(status) {
    // Winner banner disabled
    const bannerEl = document.getElementById('winnerBanner');
    if (bannerEl) bannerEl.style.display = 'none';
    return;

    const outcomeEl = document.getElementById('winnerOutcome');
    const reasonEl = document.getElementById('winnerReason');

    if (!bannerEl || !outcomeEl || !reasonEl) return;

    // Show banner if we have lastResolution data and we're in WAITING or PREMARKET state
    if ((status.state === 'WAITING' || status.state === 'PREMARKET') && status.lastResolution) {
        const res = status.lastResolution;

        // Skip if we've already shown this resolution
        if (res.timestamp && res.timestamp === lastShownResolutionTimestamp) {
            return; // Already showing/shown this resolution
        }

        // Validate prices exist and are numbers
        const startPriceNum = parseFloat(res.startPrice) || 0;
        const settlePriceNum = parseFloat(res.settlePrice) || 0;

        // Skip if prices are invalid
        if (startPriceNum <= 0 || settlePriceNum <= 0) {
            bannerEl.style.display = 'none';
            return;
        }

        // Mark this resolution as being shown
        lastShownResolutionTimestamp = res.timestamp;

        // Winner banner disabled - no longer showing "UP WON" / "DOWN WON" messages
        bannerEl.style.display = 'none';
    } else {
        bannerEl.style.display = 'none';
    }
}

// Play alarm sound using Web Audio API (urgent - market closing)
function playAlarmSound() {
    try {
        console.log('🔊 playAlarmSound() called - creating audio context...');
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('✅ AudioContext created:', audioContext.state);

        // Create a sequence of beeps (3 beeps, urgent tone)
        const beepTimes = [0, 0.2, 0.4]; // Three beeps 200ms apart

        beepTimes.forEach((time, index) => {
            // Create oscillator for beep sound
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // High-pitched urgent beep (880 Hz = A5)
            oscillator.frequency.value = 880;
            oscillator.type = 'sine';

            // Envelope: quick attack and decay
            const now = audioContext.currentTime + time;
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01); // Attack
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15); // Decay

            oscillator.start(now);
            oscillator.stop(now + 0.15);
            console.log(`🔔 Beep ${index + 1}/3 scheduled at ${now.toFixed(2)}s`);
        });

        console.log('✅ Market close alarm played successfully!');
    } catch (err) {
        console.error('❌ Failed to play alarm sound:', err);
    }
}

// Expose to window for manual testing
window.testAlarm = playAlarmSound;
window.testNotification = async () => {
    console.log('🧪 Testing notification...');
    console.log('Current permission:', Notification.permission);
    console.log('Alarm enabled:', alarmEnabled);
    console.log('notificationPermission var:', notificationPermission);

    // Request permission if needed
    if (Notification.permission === 'default') {
        console.log('Requesting permission...');
        await requestNotificationPermission();
    }

    // Update our tracking variable
    notificationPermission = Notification.permission;

    // Try to show notification
    showMarketCloseNotification(15);
};

/**
 * Request notification permission from the user
 * Called on page load and when alarm is first enabled
 */
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.log('❌ Browser does not support notifications');
        return 'denied';
    }

    // If already granted or denied, return current status
    if (Notification.permission !== 'default') {
        notificationPermission = Notification.permission;
        console.log(`🔔 Notification permission already set: ${notificationPermission}`);
        return notificationPermission;
    }

    // Request permission
    try {
        notificationPermission = await Notification.requestPermission();
        console.log(`🔔 Notification permission requested: ${notificationPermission}`);
        return notificationPermission;
    } catch (err) {
        console.error('❌ Failed to request notification permission:', err);
        notificationPermission = 'denied';
        return 'denied';
    }
}

/**
 * Show browser notification for market close warning
 * @param {number} seconds - Seconds remaining until market close
 */
function showMarketCloseNotification(seconds) {
    if (!alarmEnabled) {
        console.log('🔕 Notification skipped (alarm disabled)');
        return;
    }

    if (!('Notification' in window)) {
        console.log('❌ Notifications not supported in this browser');
        return;
    }

    if (notificationPermission !== 'granted') {
        console.log(`🔕 Notification permission not granted (status: ${notificationPermission})`);
        return;
    }

    try {
        const notification = new Notification('⏰ Market Closing Soon!', {
            body: `Market closes in ${seconds} seconds`,
            icon: '/favicon.ico',
            tag: 'market-close', // Replace previous notification with same tag
            requireInteraction: false, // Don't require user to dismiss
            silent: true // Don't play system sound (we have our own alarm)
        });

        console.log('✅ Browser notification shown');

        // Auto-close notification after 8 seconds
        setTimeout(() => {
            notification.close();
        }, 8000);
    } catch (err) {
        console.error('❌ Failed to show notification:', err);
    }
}

// Play snapshot notification sound (gentle, informative)
function playSnapshotSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Create a pleasant two-tone notification (like a camera shutter)
        const notes = [
            { freq: 523.25, time: 0, duration: 0.1 },    // C5
            { freq: 659.25, time: 0.08, duration: 0.12 }  // E5
        ];

        notes.forEach(note => {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Smooth sine wave for pleasant tone
            oscillator.frequency.value = note.freq;
            oscillator.type = 'sine';

            // Gentle envelope
            const now = audioContext.currentTime + note.time;
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(0.2, now + 0.02); // Soft attack
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + note.duration); // Gentle decay

            oscillator.start(now);
            oscillator.stop(now + note.duration);
        });

        console.log('📸 Snapshot notification played!');
    } catch (err) {
        console.error('Failed to play snapshot sound:', err);
    }
}

// Update countdown timer display (called every second for smooth countdown)
function updateCountdownDisplay() {
    const countdownTimer = document.getElementById('countdownTimer');
    if (!countdownTimer || !countdownEndTime) return;

    const now = new Date();
    const remainingMs = countdownEndTime - now;

    if (remainingMs > 0) {
        // Format countdown as MM:SS
        const minutes = Math.floor(remainingMs / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);
        const countdownText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        countdownTimer.textContent = countdownText;

        // Add urgent styling if less than 1 minute
        if (remainingMs < 60000) {
            countdownTimer.classList.add('urgent');
        } else {
            countdownTimer.classList.remove('urgent');
        }

        // Play alarm at 60 seconds remaining (only once per market, if enabled)
        // Widen window to 58-61 seconds to ensure it triggers
        if (remainingMs <= 61000 && remainingMs > 58000 && !alarmPlayed && alarmEnabled) {
            const secondsRemaining = Math.floor(remainingMs / 1000);
            console.log(`🔔 Triggering alarm at ${secondsRemaining}s remaining (enabled: ${alarmEnabled})`);
            playAlarmSound();
            showMarketCloseNotification(secondsRemaining);
            alarmPlayed = true;
            console.log('⏰ 60 seconds to market close! Alarm and notification sent.');
        }
    } else {
        // Countdown expired
        countdownTimer.textContent = '0:00';
        stopCountdownTimer();
    }
}

// Start smooth countdown timer
function startCountdownTimer(endTime) {
    // Stop any existing timer
    stopCountdownTimer();

    countdownEndTime = endTime;

    // Update immediately
    updateCountdownDisplay();

    // Then update every second
    countdownUpdateInterval = setInterval(updateCountdownDisplay, 1000);
}

// Stop countdown timer
function stopCountdownTimer() {
    if (countdownUpdateInterval) {
        clearInterval(countdownUpdateInterval);
        countdownUpdateInterval = null;
    }
    countdownEndTime = null;
}

function updateCycleDisplay(status) {
    console.log('[updateCycleDisplay] 🎯 Called with status:', status);

    const stateEl = document.getElementById('cycleState');
    const currentTimeEl = document.getElementById('currentTime');
    const nextMarketTimeEl = document.getElementById('nextMarketTime');

    console.log('[updateCycleDisplay] 🔍 DOM elements:', {
        stateEl: stateEl ? 'found' : 'NOT FOUND',
        currentTimeEl: currentTimeEl ? 'found' : 'NOT FOUND',
        nextMarketTimeEl: nextMarketTimeEl ? 'found' : 'NOT FOUND'
    });

    if (!stateEl || !currentTimeEl || !nextMarketTimeEl) {
        console.error('[updateCycleDisplay] ❌ Missing required DOM elements!');
        return;
    }

    // Update current time clock
    const now = new Date();
    const currentTimeStr = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    currentTimeEl.textContent = currentTimeStr;

    // Remove all state classes
    stateEl.classList.remove('active', 'waiting', 'error', 'premarket');
    console.log('[updateCycleDisplay] 🔄 Processing state:', status.state);

    // Update winner banner
    updateWinnerBanner(status);

    if (status.state === 'PREMARKET') {
        console.log('[updateCycleDisplay] 📋 State: PREMARKET');
        stateEl.textContent = 'PRE-MARKET';
        stateEl.classList.add('premarket');
        updateMarketEndSlot(0);

        // Reset alarm and snapshot sound for new market
        alarmPlayed = false;
        snapshotSoundPlayed = false;

        // Stop countdown timer
        stopCountdownTimer();

        // Hide countdown, show NEXT
        const countdownItem = document.getElementById('countdownItem');
        const nextMarketItem = nextMarketTimeEl.parentElement;
        if (countdownItem) {
            countdownItem.style.display = 'none';
        }
        if (nextMarketItem) {
            nextMarketItem.style.display = 'block';
        }

        // Hide the snapshot section entirely during premarket
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'none';
        }

        // Show when snapshot will be taken
        if (status.snapshotTime) {
            const snapshotTime = new Date(status.snapshotTime);
            const snapshotTimeStr = snapshotTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            nextMarketTimeEl.textContent = `Snapshot: ${snapshotTimeStr}`;
        } else {
            nextMarketTimeEl.textContent = 'Pre-market betting';
        }
    } else if (status.state === 'ACTIVE') {
        console.log('[updateCycleDisplay] 📋 State: ACTIVE');
        stateEl.textContent = 'MARKET ACTIVE';
        stateEl.classList.add('active');

        // Play snapshot sound on transition from PREMARKET to ACTIVE (only once, if alarm enabled)
        if (lastMarketState === 'PREMARKET' && !snapshotSoundPlayed && alarmEnabled) {
            playSnapshotSound();
            snapshotSoundPlayed = true;
        }

        // Show the snapshot section for active markets
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'block';
        }

        // Show snapshot price with label
        if (document.getElementById('snapshotLabel')) {
            document.getElementById('snapshotLabel').textContent = 'START PRICE';
        }
        if (document.getElementById('oracleSnapshotPrice')) {
            if (currentSnapshotPrice !== null) {
                const formattedPrice = '$' + currentSnapshotPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                document.getElementById('oracleSnapshotPrice').textContent = formattedPrice;
                document.getElementById('oracleSnapshotPrice').style.color = '#00ff00';
            } else {
                document.getElementById('oracleSnapshotPrice').textContent = 'Not taken';
                document.getElementById('oracleSnapshotPrice').style.color = '#888';
            }
        }

        // Show countdown timer and end time
        const countdownItem = document.getElementById('countdownItem');
        const countdownTimer = document.getElementById('countdownTimer');
        const nextMarketItem = nextMarketTimeEl.parentElement;
        const nextMarketLabel = document.getElementById('nextMarketLabel');

        if (status.marketEndTime) {
            const endTime = new Date(status.marketEndTime);
            const now = new Date();
            const remainingMs = endTime - now;

            // Note: market_end_slot comes from on-chain AMM data (fetched by fetchMarketData)
            // We don't calculate it here to avoid drift - settlement bot sets it authoritatively

            // Reset alarm if market end time changed (new market started)
            if (lastMarketEndTime !== status.marketEndTime) {
                lastMarketEndTime = status.marketEndTime;
                alarmPlayed = false;
                console.log('🔄 New market detected, alarm reset');
            }

            if (remainingMs > 0) {
                // Show countdown timer
                if (countdownItem) {
                    countdownItem.style.display = 'block';
                }
                if (nextMarketItem) {
                    nextMarketItem.style.display = 'none';
                }

                // Start smooth countdown timer (updates every second)
                startCountdownTimer(endTime);
            } else {
                // Market should have closed - hide countdown
                stopCountdownTimer();
                if (countdownItem) {
                    countdownItem.style.display = 'none';
                }
                if (nextMarketItem) {
                    nextMarketItem.style.display = 'block';
                }
                nextMarketTimeEl.textContent = 'Closing...';
            }
        } else {
            // No end time - hide countdown, show NEXT
            stopCountdownTimer();
            if (countdownItem) {
                countdownItem.style.display = 'none';
            }
            if (nextMarketItem) {
                nextMarketItem.style.display = 'block';
            }
            nextMarketTimeEl.textContent = 'Market open';
        }
    } else if (status.state === 'SETTLED' || status.state === 'STOPPED_SETTLED') {
        console.log('[updateCycleDisplay] 📋 State: SETTLED/STOPPED_SETTLED');
        stateEl.textContent = 'SETTLED';
        stateEl.classList.add('settled');
        updateMarketEndSlot(0);

        // Stop countdown timer
        stopCountdownTimer();

        // Hide countdown, show NEXT
        const countdownItem = document.getElementById('countdownItem');
        const nextMarketItem = nextMarketTimeEl.parentElement;
        if (countdownItem) {
            countdownItem.style.display = 'none';
        }
        if (nextMarketItem) {
            nextMarketItem.style.display = 'block';
        }

        // Hide the snapshot section
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'none';
        }

        // Show when next market starts
        if (status.nextCycleStartTime) {
            let nextStartTime = new Date(status.nextCycleStartTime);
            const now = new Date();

            // If the next cycle start time is in the past, calculate the next future occurrence
            // Market cycles are 5 minutes (300000ms)
            const CYCLE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
            while (nextStartTime <= now) {
                nextStartTime = new Date(nextStartTime.getTime() + CYCLE_DURATION);
            }

            const nextTimeStr = nextStartTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            nextMarketTimeEl.textContent = `Next: ${nextTimeStr}`;
        } else {
            nextMarketTimeEl.textContent = 'Market settled';
        }
    } else if (status.state === 'WAITING') {
        console.log('[updateCycleDisplay] 📋 State: WAITING');
        stateEl.textContent = 'PRE-MARKET';
        stateEl.classList.add('premarket');  // Use premarket styling (orange)
        updateMarketEndSlot(0);

        // Hide the snapshot section - previous market is over, new one hasn't started
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'none';
        }

        // Show when next snapshot will be taken
        if (status.nextCycleStartTime) {
            let nextStartTime = new Date(status.nextCycleStartTime);
            const now = new Date();

            // If the next cycle start time is in the past, calculate the next future occurrence
            // Market cycles are 5 minutes (300000ms)
            const CYCLE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
            while (nextStartTime <= now) {
                nextStartTime = new Date(nextStartTime.getTime() + CYCLE_DURATION);
            }

            const nextTimeStr = nextStartTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            nextMarketTimeEl.textContent = `Next snapshot: ${nextTimeStr}`;
        } else {
            nextMarketTimeEl.textContent = 'Pre-market betting';
        }
    } else if (status.state === 'ERROR') {
        console.log('[updateCycleDisplay] 📋 State: ERROR');
        stateEl.textContent = 'ERROR';
        stateEl.classList.add('error');
        updateMarketEndSlot(0);
        nextMarketTimeEl.textContent = 'Check bot';
    } else {
        // OFFLINE or unknown
        console.log('[updateCycleDisplay] 📋 State: OFFLINE or unknown:', status.state);
        stateEl.textContent = 'OFFLINE';
        stateEl.classList.add('waiting');
        updateMarketEndSlot(0);
        nextMarketTimeEl.textContent = 'Bot not running';

        // Show current snapshot price if available
        if (document.getElementById('snapshotLabel')) {
            document.getElementById('snapshotLabel').textContent = 'START PRICE';
        }
        if (document.getElementById('oracleSnapshotPrice')) {
            if (currentSnapshotPrice !== null) {
                const formattedPrice = '$' + currentSnapshotPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                document.getElementById('oracleSnapshotPrice').textContent = formattedPrice;
                document.getElementById('oracleSnapshotPrice').style.color = '#00ff00';
            } else {
                document.getElementById('oracleSnapshotPrice').textContent = 'Not taken';
                document.getElementById('oracleSnapshotPrice').style.color = '#888';
            }
        }
    }

    // Track state for next update (to detect transitions)
    lastMarketState = status.state;

    console.log('[updateCycleDisplay] ✅ Display updated. Current text:', stateEl.textContent);
}

function formatCountdown(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ============= POLLING =============

function startPolling() {
    // console.log('[startPolling] 🚀 Initializing all SSE streams...');
    // Connect to all SSE streams (replaces polling for price, market, volume, and cycle)
    connectPriceStream();
    connectMarketStream();
    connectVolumeStream();
    // console.log('[startPolling] 📅 Connecting to cycle stream...');
    connectCycleStream();
    // console.log('[startPolling] ✅ All SSE streams initialized');

    // Update clock every second
    setInterval(() => {
        const currentTimeEl = document.getElementById('currentTime');
        if (currentTimeEl) {
            const now = new Date();
            const currentTimeStr = now.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            currentTimeEl.textContent = currentTimeStr;
        }
    }, 1000);

    setInterval(() => {
        // Note: Price, market, volume, and cycle updates come via SSE
        // Only poll wallet-specific data
        if (wallet) {
            updateWalletBalance();
            fetchPositionData();
        } else {
            // Even without wallet, update redeemable section visibility
            updateRedeemableBalance(0, 0);
        }
    }, 1000);
}

// ============= UI HELPERS =============

function showStatus(message) {
    // Status is now shown in log only
    console.log('STATUS:', message);
}

function showError(message) {
    // Errors are now shown in log only
    console.error('ERROR:', message);
}

// ============= UI HELPERS FOR PREDICTION MARKET =============

let currentAction = 'buy';
let currentSide = 'yes';
let userYesShares = 0;
let userNoShares = 0;

// Validate if user can sell based on their position
function validateSellButtons() {
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');
    const tradeBtn = document.getElementById('tradeBtn');

    if (!yesBtn || !noBtn) return;

    // Only validate when selling
    if (currentAction !== 'sell') {
        // Enable both buttons for BUY
        yesBtn.disabled = false;
        yesBtn.classList.remove('disabled');
        noBtn.disabled = false;
        noBtn.classList.remove('disabled');
        if (tradeBtn && tradeBtn.disabled) {
            tradeBtn.disabled = false;
            tradeBtn.classList.remove('disabled');
        }
        return;
    }

    // For SELL, check if user has shares
    const requestedShares = parseFloat(document.getElementById('tradeAmountShares')?.value) || 0;

    console.log('[VALIDATION] SELL mode - User has YES:', userYesShares, 'NO:', userNoShares, 'Requested:', requestedShares, 'Current side:', currentSide);

    // Disable YES button if no YES shares
    if (userYesShares <= 0) {
        yesBtn.disabled = true;
        yesBtn.classList.add('disabled');
    } else {
        yesBtn.disabled = false;
        yesBtn.classList.remove('disabled');
    }

    // Disable NO button if no NO shares
    if (userNoShares <= 0) {
        noBtn.disabled = true;
        noBtn.classList.add('disabled');
    } else {
        noBtn.disabled = false;
        noBtn.classList.remove('disabled');
    }

    // Disable execute button if trying to sell more than available
    if (tradeBtn && requestedShares > 0) {
        const availableShares = currentSide === 'yes' ? userYesShares : userNoShares;
        // Use epsilon for floating point comparison (allow selling up to 0.01 more than available due to rounding)
        const EPSILON = 0.01;
        if (requestedShares > availableShares + EPSILON) {
            tradeBtn.disabled = true;
            tradeBtn.classList.add('disabled');
            console.log('[VALIDATION] Execute button disabled - trying to sell', requestedShares, 'but only have', availableShares);
        } else {
            tradeBtn.disabled = false;
            tradeBtn.classList.remove('disabled');
        }
    }

    // If current side is disabled, switch to the enabled side (if any)
    if (currentSide === 'yes' && yesBtn.disabled && !noBtn.disabled) {
        selectOutcome('no');
    } else if (currentSide === 'no' && noBtn.disabled && !yesBtn.disabled) {
        selectOutcome('yes');
    }
}

function switchTab(action) {
    currentAction = action;
    const buyTab = document.getElementById('buyTab');
    const sellTab = document.getElementById('sellTab');

    if (action === 'buy') {
        buyTab.classList.add('active');
        sellTab.classList.remove('active');
        document.getElementById('tradeBtn').style.background = '#00c896';
    } else {
        sellTab.classList.add('active');
        buyTab.classList.remove('active');
        document.getElementById('tradeBtn').style.background = '#ff4757';
    }
    validateSellButtons();
    updateTradeButton();
}

function selectOutcome(side) {
    currentSide = side;
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');

    if (side === 'yes') {
        yesBtn.classList.add('active');
        noBtn.classList.remove('active');
    } else {
        noBtn.classList.add('active');
        yesBtn.classList.remove('active');
    }
    validateSellButtons();
    updateTradeButton();
    updateSliderMax(); // Update max shares for new side's price
}

function setShares(shares) {
    document.getElementById('tradeAmountShares').value = shares;
    validateSellButtons();
    updateTradeButton();
}

function addShares(amount) {
    const currentShares = parseFloat(document.getElementById('tradeAmountShares').value) || 0;
    const newShares = currentShares + amount;
    document.getElementById('tradeAmountShares').value = newShares;

    // Update slider if it exists
    const sharesSlider = document.getElementById('sharesSlider');
    if (sharesSlider) {
        const maxVal = parseInt(sharesSlider.max) || 500;
        sharesSlider.value = Math.min(Math.max(newShares, 0), maxVal);
    }

    validateSellButtons();
    updateTradeButton();
}

function resetShares() {
    document.getElementById('tradeAmountShares').value = 0;

    // Reset slider if it exists
    const sharesSlider = document.getElementById('sharesSlider');
    if (sharesSlider) {
        sharesSlider.value = 0;
    }

    validateSellButtons();
    updateTradeButton();
}

function updateTradeButton() {
    const shares = parseFloat(document.getElementById('tradeAmountShares').value) || 0;

    let cost;
    if (currentAction === 'buy') {
        // Calculate base cost for desired shares
        const baseCost = calculateSpendForShares(currentSide, shares);

        // Predict price impact: larger trades need more buffer
        // As we buy, price moves against us (slippage)
        // Add dynamic buffer based on trade size relative to liquidity
        const bShares = currentB / 10_000_000;
        const tradeImpact = shares / bShares; // Ratio of trade to liquidity

        // Dynamic slippage buffer:
        // - Small trades (<1% of liquidity): 0.5% buffer
        // - Medium trades (1-5% of liquidity): 1-3% buffer
        // - Large trades (>5% of liquidity): 3-10% buffer
        let slippageBuffer;
        if (tradeImpact < 0.01) {
            slippageBuffer = 1.005; // 0.5%
        } else if (tradeImpact < 0.05) {
            slippageBuffer = 1.01 + (tradeImpact * 0.4); // 1-3%
        } else {
            slippageBuffer = 1.03 + (tradeImpact * 1.4); // 3-10%+
        }

        // Cap maximum buffer at 15% for extreme cases
        slippageBuffer = Math.min(slippageBuffer, 1.15);

        cost = baseCost * slippageBuffer;

        // Safety check
        if (!isFinite(cost) || cost <= 0) {
            cost = shares * (currentSide === 'yes' ? currentYesPrice : currentNoPrice);
        }

        console.log(`[UI Estimate] ${shares} shares: base=${baseCost.toFixed(4)}, impact=${(tradeImpact*100).toFixed(2)}%, buffer=${((slippageBuffer-1)*100).toFixed(2)}%, total=${cost.toFixed(4)} XNT`);
    } else {
        // Sell: use LMSR calculation for accurate proceeds
        cost = calculateSellProceeds(currentSide, shares);

        // Safety check
        if (!isFinite(cost) || cost <= 0) {
            const sharePrice = currentSide === 'yes' ? currentYesPrice : currentNoPrice;
            cost = shares * sharePrice;
        }

        console.log(`[UI Estimate SELL] ${shares} shares → ${cost.toFixed(4)} XNT proceeds`);
    }

    const action = currentAction === 'buy' ? 'BUY' : 'SELL';
    const sideDisplay = currentSide === 'yes' ? 'UP' : 'DOWN';
    const text = `${action} ${shares} ${sideDisplay}`;
    document.getElementById('tradeBtnText').textContent = text;

    // Update cost display
    if (document.getElementById('tradeCost')) {
        document.getElementById('tradeCost').textContent = `~${cost.toFixed(2)} XNT`;
    }
}

function clearLog() {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = '<div class="log-entry log-info"><span class="log-time">--:--:--</span><span class="log-message">Log cleared</span></div>';
}

// ============= SETTLEMENT HISTORY =============

async function loadSettlementHistory() {
    console.log('[Settlement] Loading settlement history...');
    console.log('[Settlement] API endpoint:', `${CONFIG.API_PREFIX}/settlement-history`);

    try {
        const response = await fetch(`${CONFIG.API_PREFIX}/settlement-history`);
        console.log('[Settlement] Response status:', response.status);

        if (!response.ok) {
            console.warn('[Settlement] Failed to load settlement history:', response.status);
            return;
        }

        const data = await response.json();
        console.log('[Settlement] Raw response data:', data);
        console.log('[Settlement] Number of settlements:', data.history?.length || 0);

        if (data.history && Array.isArray(data.history)) {
            displaySettlementHistory(data.history);
        } else {
            console.warn('[Settlement] No history array in response');
        }
    } catch (err) {
        console.error('[Settlement] Error loading settlement history:', err);
    }
}

function displaySettlementHistory(history) {
    console.log('[Settlement Display] Processing', history.length, 'settlement records');

    const settlementFeed = document.getElementById('settlementFeed');
    if (!settlementFeed) {
        console.error('[Settlement Display] settlementFeed element not found');
        return;
    }

    settlementFeed.innerHTML = '';

    // Show all settlements (both winners and losers)
    const allSettlements = history;

    if (allSettlements.length === 0) {
        console.log('[Settlement Display] No settlements to display');
        settlementFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">📜</span><span class="empty-text">No settlements</span></div>';
        return;
    }

    console.log('[Settlement Display] First settlement record:', allSettlements[0]);

    // Create table structure
    const table = document.createElement('div');
    table.className = 'settlement-table';

    // Add header with BTC movement and financial columns
    table.innerHTML = `
        <div class="settlement-table-header">
            <div class="col-time">TIME</div>
            <div class="col-user">USER</div>
            <div class="col-market">MARKET</div>
            <div class="col-btcmove">BTC MOVE</div>
            <div class="col-spent">SPENT</div>
            <div class="col-shares">SHARES</div>
            <div class="col-payout">PAYOUT</div>
            <div class="col-profit">PROFIT</div>
            <div class="col-roi">ROI</div>
        </div>
    `;

    // Add rows
    const tbody = document.createElement('div');
    tbody.className = 'settlement-table-body';

    allSettlements.forEach((item, index) => {
        console.log(`[Settlement ${index + 1}] Processing settlement for user ${item.user_prefix}`);
        console.log(`  Raw data:`, {
            result: item.result,
            side: item.side,
            amount: item.amount,
            net_spent: item.net_spent,
            snapshot_price: item.snapshot_price,
            settle_price: item.settle_price,
            timestamp: item.timestamp
        });

        const isWin = item.result === 'WIN';
        const sideDisplay = item.side === 'YES' ? 'UP' : 'DOWN';
        const payout = parseFloat(item.amount).toFixed(4);

        // Get financial data
        const netSpent = parseFloat(item.net_spent || 0);
        const profit = payout - netSpent;

        console.log(`  Calculations:`, {
            isWin,
            sideDisplay,
            payout,
            netSpent,
            profit: profit.toFixed(4)
        });

        const time = new Date(item.timestamp);
        const dateStr = time.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
        const timeStr = time.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        // Calculate BTC movement
        let btcMove = '?';
        let btcMoveClass = 'btc-unknown';

        if (item.snapshot_price && item.settle_price) {
            const snapshotPrice = parseFloat(item.snapshot_price);
            const settlePrice = parseFloat(item.settle_price);
            const priceDiff = settlePrice - snapshotPrice;

            console.log(`  BTC Price Movement:`, {
                snapshotPrice,
                settlePrice,
                priceDiff,
                direction: priceDiff > 0 ? 'UP' : priceDiff < 0 ? 'DOWN' : 'FLAT'
            });

            // Format prices with K suffix for compact display
            const formatPrice = (price) => {
                if (price >= 100000) {
                    return '$' + (price / 1000).toFixed(1) + 'K';
                }
                return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 });
            };

            const snapStr = formatPrice(snapshotPrice);
            const settleStr = formatPrice(settlePrice);
            const diffAbs = Math.abs(priceDiff);
            const diffStr = diffAbs >= 1000 ? '$' + (diffAbs / 1000).toFixed(2) + 'K' : '$' + diffAbs.toFixed(0);

            if (settlePrice > snapshotPrice) {
                btcMove = `↑ ${diffStr}`;
                btcMoveClass = 'btc-up';
            } else if (settlePrice < snapshotPrice) {
                btcMove = `↓ ${diffStr}`;
                btcMoveClass = 'btc-down';
            } else {
                btcMove = `→ $0`;
                btcMoveClass = 'btc-flat';
            }
        }

        // Determine which side won the market (based on BTC movement)
        let marketWinner = '?';
        let marketWinnerClass = 'market-unknown';
        if (item.snapshot_price && item.settle_price) {
            const snapshotPrice = parseFloat(item.snapshot_price);
            const settlePrice = parseFloat(item.settle_price);
            if (settlePrice > snapshotPrice) {
                marketWinner = '↑ UP';
                marketWinnerClass = 'market-up';
            } else if (settlePrice < snapshotPrice) {
                marketWinner = '↓ DOWN';
                marketWinnerClass = 'market-down';
            } else {
                marketWinner = '→ FLAT';
                marketWinnerClass = 'market-flat';
            }
        }

        // Format profit/loss with color
        let profitClass = 'profit-neutral';
        let profitDisplay = profit.toFixed(2);
        if (profit > 0.001) {
            profitClass = 'profit-positive';
            profitDisplay = '+' + profit.toFixed(2);
        } else if (profit < -0.001) {
            profitClass = 'profit-negative';
        }

        // Calculate ROI percentage
        let roiDisplay = '0%';
        let roiClass = 'profit-neutral';
        if (netSpent > 0) {
            const roiPercent = (profit / netSpent) * 100;
            if (roiPercent > 0.1) {
                roiClass = 'profit-positive';
                roiDisplay = '+' + roiPercent.toFixed(1) + '%';
            } else if (roiPercent < -0.1) {
                roiClass = 'profit-negative';
                roiDisplay = roiPercent.toFixed(1) + '%';
            } else {
                roiDisplay = '0%';
            }
        }

        console.log(`  Display values:`, {
            dateStr,
            timeStr,
            user_prefix: item.user_prefix,
            btcMove,
            btcMoveClass,
            netSpent: netSpent.toFixed(4),
            payout,
            profitDisplay,
            profitClass,
            roiDisplay
        });

        // Format shares with side indicator (UP/DOWN)
        const shares = parseFloat(item.shares || 0);
        const sharesDisplay = shares > 0 ? `${shares.toFixed(2)} ${sideDisplay}` : '-';

        const row = document.createElement('div');
        row.className = 'settlement-table-row';
        row.innerHTML = `
            <div class="col-time">${dateStr} ${timeStr}</div>
            <div class="col-user"><a href="/leaderboard/${item.user_prefix}" class="user-link">${item.user_prefix}</a></div>
            <div class="col-market ${marketWinnerClass}">${marketWinner}</div>
            <div class="col-btcmove ${btcMoveClass}">${btcMove}</div>
            <div class="col-spent">${netSpent.toFixed(4)}</div>
            <div class="col-shares">${sharesDisplay}</div>
            <div class="col-payout">${payout}</div>
            <div class="col-profit ${profitClass}">${profitDisplay}</div>
            <div class="col-roi ${roiClass}">${roiDisplay}</div>
        `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    settlementFeed.appendChild(table);
}

// ============= TRADING HISTORY =============

let currentFeedTab = 'live'; // Track active feed tab

async function loadTradingHistory() {
    const tradingFeed = document.getElementById('tradingFeed');
    if (!tradingFeed) return;

    // Check if wallet is connected
    if (!wallet || !wallet.publicKey) {
        tradingFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">📈</span><span class="empty-text">Connect wallet to view your trading history</span></div>';
        return;
    }

    const userPrefix = wallet.publicKey.toString().slice(0, 6);

    try {
        const response = await fetch(`${CONFIG.API_PREFIX}/trading-history/${userPrefix}`);
        if (!response.ok) {
            console.warn('Failed to load trading history:', response.status);
            return;
        }

        const data = await response.json();
        if (data.history && Array.isArray(data.history)) {
            displayTradingHistory(data.history);
        }
    } catch (err) {
        console.warn('Failed to load trading history:', err);
    }
}

function displayTradingHistory(history) {
    const tradingFeed = document.getElementById('tradingFeed');
    if (!tradingFeed) return;

    // Clear existing items
    tradingFeed.innerHTML = '';

    if (history.length === 0) {
        tradingFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">📈</span><span class="empty-text">No trading history yet</span></div>';
        return;
    }

    // Create table structure
    const table = document.createElement('div');
    table.className = 'trading-table';

    // Add header
    table.innerHTML = `
        <div class="trading-table-header">
            <div class="col-time">TIME</div>
            <div class="col-type">TYPE</div>
            <div class="col-direction">DIRECTION</div>
            <div class="col-price">PRICE</div>
            <div class="col-size">SIZE</div>
            <div class="col-value">VALUE</div>
            <div class="col-fees">FEES</div>
        </div>
    `;

    // Add rows
    const tbody = document.createElement('div');
    tbody.className = 'trading-table-body';

    // Sort by timestamp descending (newest first)
    const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);

    sortedHistory.forEach(item => {
        const isBuy = item.action === 'BUY';
        const time = new Date(item.timestamp);
        const dateStr = time.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
        const timeStr = time.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const shares = parseFloat(item.shares);
        const costUsd = parseFloat(item.cost_usd);
        const avgPrice = parseFloat(item.avg_price);

        // Calculate approximate fees (25 bps = 0.25%)
        const feeRate = 0.0025;
        const fees = isBuy ? (costUsd * feeRate) : (costUsd * feeRate);

        const typeClass = item.side === 'UP' ? 'type-up' : 'type-down';
        const directionClass = isBuy ? 'direction-open' : 'direction-close';

        const row = document.createElement('div');
        row.className = 'trading-table-row';
        row.innerHTML = `
            <div class="col-time">${dateStr} ${timeStr}</div>
            <div class="col-type ${typeClass}">${item.side}</div>
            <div class="col-direction ${directionClass}">${isBuy ? 'OPENED' : 'CLOSED'}</div>
            <div class="col-price">${avgPrice.toFixed(4)}</div>
            <div class="col-size">${shares.toFixed(2)}</div>
            <div class="col-value">${costUsd.toFixed(4)}</div>
            <div class="col-fees">-${fees.toFixed(4)}</div>
        `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tradingFeed.appendChild(table);
}

function addSingleTradeToHistory(tradeData) {
    const tradingFeed = document.getElementById('tradingFeed');
    if (!tradingFeed) return;

    // Remove empty state if present
    const emptyState = tradingFeed.querySelector('.trade-feed-empty');
    if (emptyState) {
        emptyState.remove();
    }

    // Find the table body, or create the table structure if it doesn't exist
    let tableBody = tradingFeed.querySelector('.trading-table-body');
    if (!tableBody) {
        const table = document.createElement('div');
        table.className = 'trading-table';
        table.innerHTML = `
            <div class="trading-table-header">
                <div class="col-time">TIME</div>
                <div class="col-type">TYPE</div>
                <div class="col-direction">DIRECTION</div>
                <div class="col-price">PRICE</div>
                <div class="col-size">SIZE</div>
                <div class="col-value">VALUE</div>
                <div class="col-fees">FEES</div>
            </div>
        `;
        tableBody = document.createElement('div');
        tableBody.className = 'trading-table-body';
        table.appendChild(tableBody);
        tradingFeed.appendChild(table);
    }

    const isBuy = tradeData.action === 'BUY';
    const time = new Date(tradeData.timestamp);
    const dateStr = time.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
    const timeStr = time.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const shares = parseFloat(tradeData.shares);
    const costUsd = parseFloat(tradeData.cost_usd || tradeData.costUsd);
    const avgPrice = parseFloat(tradeData.avg_price || tradeData.avgPrice);

    // Calculate fees (25 bps = 0.25%)
    const feeRate = 0.0025;
    const fees = costUsd * feeRate;

    const typeClass = tradeData.side === 'UP' ? 'type-up' : 'type-down';
    const directionClass = isBuy ? 'direction-open' : 'direction-close';

    const row = document.createElement('div');
    row.className = 'trading-table-row fade-in';
    row.innerHTML = `
        <div class="col-time">${dateStr} ${timeStr}</div>
        <div class="col-type ${typeClass}">${tradeData.side}</div>
        <div class="col-direction ${directionClass}">${isBuy ? 'OPENED' : 'CLOSED'}</div>
        <div class="col-price">${avgPrice.toFixed(4)}</div>
        <div class="col-size">${shares.toFixed(2)}</div>
        <div class="col-value">${costUsd.toFixed(4)}</div>
        <div class="col-fees">-${fees.toFixed(4)}</div>
    `;

    // Prepend to show newest first (at top)
    tableBody.insertBefore(row, tableBody.firstChild);

    // Remove oldest items if we have too many (keep last 50)
    const allRows = tableBody.querySelectorAll('.trading-table-row');
    if (allRows.length > 50) {
        allRows[allRows.length - 1].remove();
    }
}

// ============= OPEN ORDERS =============

async function loadOpenOrders() {
    const ordersFeed = document.getElementById('ordersFeed');
    if (!ordersFeed) return;

    // Check if wallet is connected
    if (!wallet || !wallet.publicKey) {
        ordersFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">📋</span><span class="empty-text">Connect wallet to view your open orders</span></div>';
        return;
    }

    const userAddress = wallet.publicKey.toString();

    try {
        const API_BASE = `${window.location.protocol}//${window.location.host}/orderbook-api`;
        const response = await fetch(`${API_BASE}/api/orders/user/${userAddress}`);

        if (!response.ok) {
            console.warn('Failed to load open orders:', response.status);
            ordersFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">⚠️</span><span class="empty-text">Failed to load orders</span></div>';
            return;
        }

        const data = await response.json();
        if (data.orders && Array.isArray(data.orders)) {
            displayOpenOrders(data.orders);
        }
    } catch (err) {
        console.warn('Failed to load open orders:', err);
        ordersFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">⚠️</span><span class="empty-text">Error loading orders</span></div>';
    }
}

function displayOpenOrders(orders) {
    const ordersFeed = document.getElementById('ordersFeed');
    if (!ordersFeed) return;

    // Filter for pending orders only
    const pendingOrders = orders.filter(o => o.status === 'pending');

    // Clear existing items
    ordersFeed.innerHTML = '';

    if (pendingOrders.length === 0) {
        ordersFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">📋</span><span class="empty-text">No open orders</span></div>';
        return;
    }

    // Create table structure
    const table = document.createElement('div');
    table.className = 'trading-table';

    // Add header
    table.innerHTML = `
        <div class="trading-table-header">
            <div class="col-id" style="width: 50px;">#</div>
            <div class="col-type" style="width: 50px;">TYPE</div>
            <div class="col-direction" style="width: 60px;">SIDE</div>
            <div class="col-price" style="width: 80px;">LIMIT</div>
            <div class="col-size" style="width: 70px;">SIZE</div>
            <div class="col-time" style="width: 80px;">CREATED</div>
            <div class="col-actions" style="width: 70px;">ACTION</div>
        </div>
    `;

    // Add rows
    const tbody = document.createElement('div');
    tbody.className = 'trading-table-body';

    // Sort by submission time descending (newest first)
    const sortedOrders = [...pendingOrders].sort((a, b) =>
        new Date(b.submitted_at) - new Date(a.submitted_at)
    );

    sortedOrders.forEach(orderData => {
        const order = orderData.order;
        const isBuy = order.action === 1;
        const sideText = order.side === 1 ? 'YES' : 'NO';
        const shares = (order.shares_e6 / 10_000_000).toFixed(2);
        const price = (order.limit_price_e6 / 1e6).toFixed(4);
        const time = new Date(orderData.submitted_at);
        const timeStr = time.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const row = document.createElement('div');
        row.className = 'trading-table-row';
        row.style.color = isBuy ? '#10b981' : '#ef4444';

        row.innerHTML = `
            <div class="col-id" style="width: 50px; font-weight: 600;">#${orderData.order_id}</div>
            <div class="col-type" style="width: 50px;">${isBuy ? 'BUY' : 'SELL'}</div>
            <div class="col-direction" style="width: 60px;">
                <span class="badge ${order.side === 1 ? 'badge-yes' : 'badge-no'}" style="font-size: 10px; padding: 2px 6px;">${sideText}</span>
            </div>
            <div class="col-price" style="width: 80px; color: #a855f7;">$${price}</div>
            <div class="col-size" style="width: 70px; color: #fff;">${shares}</div>
            <div class="col-time" style="width: 80px; color: #6b7280; font-size: 11px;">${timeStr}</div>
            <div class="col-actions" style="width: 70px;">
                <button onclick="cancelOrder(${orderData.order_id})" style="font-size: 10px; padding: 3px 8px; background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid #ef4444; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
        `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    ordersFeed.appendChild(table);
}

async function cancelOrder(orderId) {
    if (!wallet || !wallet.publicKey) {
        showError('No wallet connected');
        return;
    }

    if (!confirm(`Cancel order #${orderId}?`)) {
        return;
    }

    try {
        const API_BASE = `${window.location.protocol}//${window.location.host}/orderbook-api`;
        const response = await fetch(`${API_BASE}/api/orders/${orderId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (response.ok) {
            addLog(`✅ Order #${orderId} cancelled`, 'success');
            showToast('success', '✅ Order Cancelled', `Order #${orderId} has been cancelled`);

            // Reload open orders
            loadOpenOrders();
        } else {
            addLog(`Failed to cancel order: ${data.error}`, 'error');
            showError(`Cancel failed: ${data.error}`);
        }
    } catch (err) {
        console.error('Error cancelling order:', err);
        addLog(`ERROR: ${err.message}`, 'error');
        showError(`Cancel error: ${err.message}`);
    }
}

// ============= END OPEN ORDERS =============

// ============= FILLED ORDERS =============

async function loadFilledOrders() {
    const filledFeed = document.getElementById('filledFeed');
    if (!filledFeed) return;

    // Check if wallet is connected
    if (!wallet || !wallet.publicKey) {
        filledFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">✅</span><span class="empty-text">Connect wallet to view your filled orders</span></div>';
        return;
    }

    const userAddress = wallet.publicKey.toString();

    try {
        const API_BASE = `${window.location.protocol}//${window.location.host}/orderbook-api`;
        // Use the filled orders endpoint like orderbook.html does
        const response = await fetch(`${API_BASE}/api/orders/filled?limit=100`);

        if (!response.ok) {
            console.warn('Failed to load filled orders:', response.status);
            filledFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">⚠️</span><span class="empty-text">Failed to load orders</span></div>';
            return;
        }

        const data = await response.json();
        if (data.orders && Array.isArray(data.orders)) {
            // Filter for current user's orders
            const userOrders = data.orders.filter(o => o.order && o.order.user === userAddress);
            displayFilledOrders(userOrders);
        }
    } catch (err) {
        console.warn('Failed to load filled orders:', err);
        filledFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">⚠️</span><span class="empty-text">Error loading orders</span></div>';
    }
}

function displayFilledOrders(orders) {
    const filledFeed = document.getElementById('filledFeed');
    if (!filledFeed) return;

    // Clear existing items
    filledFeed.innerHTML = '';

    if (!orders || orders.length === 0) {
        filledFeed.innerHTML = '<div class="trade-feed-empty"><span class="empty-icon">✅</span><span class="empty-text">No filled orders</span></div>';
        return;
    }

    // Create table structure
    const table = document.createElement('div');
    table.className = 'trading-table';

    // Add header with increased widths
    table.innerHTML = `
        <div class="trading-table-header" style="display: flex; flex-wrap: nowrap; align-items: center;">
            <div class="col-id" style="width: 60px; flex-shrink: 0; white-space: nowrap;">#</div>
            <div class="col-type" style="width: 60px; flex-shrink: 0; white-space: nowrap;">TYPE</div>
            <div class="col-direction" style="width: 60px; flex-shrink: 0; white-space: nowrap;">SIDE</div>
            <div class="col-size" style="width: 80px; flex-shrink: 0; white-space: nowrap;">SIZE</div>
            <div class="col-price" style="width: 90px; flex-shrink: 0; white-space: nowrap;">EXEC</div>
            <div class="col-value" style="width: 100px; flex-shrink: 0; white-space: nowrap;">COST</div>
            <div class="col-time" style="width: 80px; flex-shrink: 0; white-space: nowrap;">FILLED</div>
            <div class="col-tx" style="flex: 1; text-align: right; min-width: 0; white-space: nowrap;">TX</div>
        </div>
    `;

    // Add rows
    const tbody = document.createElement('div');
    tbody.className = 'trading-table-body';

    // Sort by filled_at descending (newest first)
    const sortedOrders = [...orders].sort((a, b) =>
        new Date(b.filled_at) - new Date(a.filled_at)
    );

    sortedOrders.forEach(orderData => {
        const order = orderData.order;
        const isBuy = order.action === 1;
        const sideText = order.side === 1 ? 'YES' : 'NO';
        // Use 6 decimals like orderbook.html for better precision
        const shares = orderData.filled_shares ? orderData.filled_shares.toFixed(2) : '0.00';
        const execPrice = orderData.execution_price ? orderData.execution_price.toFixed(6) : '0.000000';
        const totalCost = orderData.total_cost ? orderData.total_cost.toFixed(6) : '0.000000';
        const time = new Date(orderData.filled_at);
        const timeStr = time.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const txShort = orderData.filled_tx ? orderData.filled_tx.slice(0, 8) + '...' : '-';
        const txLink = orderData.filled_tx
            ? `https://explorer.mainnet.x1.xyz/tx/${orderData.filled_tx}`
            : '#';

        const row = document.createElement('div');
        row.className = 'trading-table-row';
        row.style.color = isBuy ? '#10b981' : '#ef4444';
        row.style.display = 'flex';
        row.style.flexWrap = 'nowrap';
        row.style.alignItems = 'center';

        row.innerHTML = `
            <div class="col-id" style="width: 60px; flex-shrink: 0; font-weight: 600; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">#${orderData.order_id}</div>
            <div class="col-type" style="width: 60px; flex-shrink: 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${isBuy ? 'BUY' : 'SELL'}</div>
            <div class="col-direction" style="width: 60px; flex-shrink: 0; white-space: nowrap; overflow: hidden;">
                <span class="badge ${order.side === 1 ? 'badge-yes' : 'badge-no'}" style="font-size: 10px; padding: 2px 6px; white-space: nowrap;">${sideText}</span>
            </div>
            <div class="col-size" style="width: 80px; flex-shrink: 0; color: #fff; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${shares}</div>
            <div class="col-price" style="width: 90px; flex-shrink: 0; color: #10b981; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">$${execPrice}</div>
            <div class="col-value" style="width: 100px; flex-shrink: 0; color: #a855f7; font-weight: 600; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">$${totalCost}</div>
            <div class="col-time" style="width: 80px; flex-shrink: 0; color: #6b7280; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${timeStr}</div>
            <div class="col-tx" style="flex: 1; min-width: 0; font-size: 10px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${orderData.filled_tx ? `<a href="${txLink}" target="_blank" style="color: #5b9eff; text-decoration: none; font-family: monospace;">${txShort}</a>` : '-'}
            </div>
        `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    filledFeed.appendChild(table);
}

// ============= END FILLED ORDERS =============

// ============= POSITIONS =============

// Positions refresh interval
let positionsRefreshInterval = null;

// ============= TRADE LOG PARSING =============
// Parse trade data from on-chain logs (browser version of trade_monitor.js logic)
function parseTradeFromLogs(logs, signature) {
    // Look for "Program data: " log which contains base64 encoded event
    for (const log of logs) {
        if (log.startsWith('Program data: ')) {
            try {
                const base64Data = log.substring('Program data: '.length);
                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // TradeSnapshot event structure (after 8-byte discriminator):
                // side: u8, action: u8, net_e6: i64, dq_e6: i64, avg_price_e6: i64, ...
                if (bytes.length < 8 + 1 + 1 + 8 + 8 + 8) continue;

                const view = new DataView(bytes.buffer);
                let offset = 8; // Skip discriminator
                const side = view.getUint8(offset); offset += 1;
                const action = view.getUint8(offset); offset += 1;
                const net_e6 = Number(view.getBigInt64(offset, true)); offset += 8;
                const dq_e6 = Number(view.getBigInt64(offset, true)); offset += 8;
                const avg_price_e6 = Number(view.getBigInt64(offset, true)); offset += 8;

                return {
                    side: side === 1 ? 'YES' : 'NO',
                    action: action === 1 ? 'BUY' : 'SELL',
                    amount: parseFloat((net_e6 / 10_000_000).toFixed(4)),
                    shares: parseFloat((dq_e6 / 10_000_000).toFixed(2)),
                    avgPrice: parseFloat((avg_price_e6 / 1_000_000).toFixed(4)),
                    signature,
                    timestamp: Date.now()
                };
            } catch (err) {
                console.error('[POSITIONS] Failed to parse trade data:', err);
            }
        }
    }
    return null;
}

// ============= LIVE POSITION TRACKING =============
// This tracks positions using live trade execution prices
// Format: { UP: { shares, totalCost, entries: [{ shares, price }] }, DOWN: { ... } }
// IMPORTANT: Initialize with numeric 0, not null, to prevent string concatenation bugs
let livePositions = {
    UP: { shares: 0, totalCost: 0, entries: [] },
    DOWN: { shares: 0, totalCost: 0, entries: [] }
};

// Track pending trades that were added optimistically but not yet confirmed by SSE
// Format: Map<signature, {side, action, shares, estimatedPrice, timestamp}>
let pendingTrades = new Map();

// Load positions from localStorage on page load
function loadLivePositionsFromStorage() {
    try {
        const stored = localStorage.getItem('livePositions');
        if (stored) {
            const parsed = JSON.parse(stored);

            // Validate and repair data - ensure numeric values
            livePositions = {
                UP: {
                    shares: Number(parsed.UP?.shares) || 0,
                    totalCost: Number(parsed.UP?.totalCost) || 0,
                    entries: Array.isArray(parsed.UP?.entries) ? parsed.UP.entries : []
                },
                DOWN: {
                    shares: Number(parsed.DOWN?.shares) || 0,
                    totalCost: Number(parsed.DOWN?.totalCost) || 0,
                    entries: Array.isArray(parsed.DOWN?.entries) ? parsed.DOWN.entries : []
                }
            };

            console.log('[Live Positions] Loaded and validated from storage:', livePositions);
        }
    } catch (err) {
        console.error('[Live Positions] Failed to load from storage:', err);
        // Reset to defaults on error
        livePositions = {
            UP: { shares: 0, totalCost: 0, entries: [] },
            DOWN: { shares: 0, totalCost: 0, entries: [] }
        };
    }
}

// Save positions to localStorage
function saveLivePositionsToStorage() {
    try {
        localStorage.setItem('livePositions', JSON.stringify(livePositions));
    } catch (err) {
        console.error('[Live Positions] Failed to save to storage:', err);
    }
}

// Update position with a new trade (uses live execution price from SSE)
function updateLivePosition(side, action, shares, avgPrice) {
    const positionSide = side === 'YES' ? 'UP' : 'DOWN';
    const position = livePositions[positionSide];

    console.log(`[POSITION-MONITOR] ========================================`);
    console.log(`[POSITION-MONITOR] 🔄 updateLivePosition() called:`);
    console.log(`[POSITION-MONITOR]   📥 Input Parameters:`);
    console.log(`[POSITION-MONITOR]      side: "${side}" → positionSide: "${positionSide}"`);
    console.log(`[POSITION-MONITOR]      action: "${action}"`);
    console.log(`[POSITION-MONITOR]      shares: ${shares} (type: ${typeof shares})`);
    console.log(`[POSITION-MONITOR]      avgPrice: ${avgPrice} (type: ${typeof avgPrice})`);
    console.log('[POSITION-MONITOR]');
    console.log('[POSITION-MONITOR]   📊 FULL STATE BEFORE UPDATE:');
    console.log('[POSITION-MONITOR]      livePositions.UP.shares:', livePositions.UP.shares);
    console.log('[POSITION-MONITOR]      livePositions.UP.totalCost:', livePositions.UP.totalCost);
    console.log('[POSITION-MONITOR]      livePositions.UP.entries:', JSON.stringify(livePositions.UP.entries));
    console.log('[POSITION-MONITOR]      livePositions.DOWN.shares:', livePositions.DOWN.shares);
    console.log('[POSITION-MONITOR]      livePositions.DOWN.totalCost:', livePositions.DOWN.totalCost);
    console.log('[POSITION-MONITOR]      livePositions.DOWN.entries:', JSON.stringify(livePositions.DOWN.entries));
    console.log('[POSITION-MONITOR]');
    console.log(`[POSITION-MONITOR]   🎯 Target Position (${positionSide}) Before:`);
    console.log('[POSITION-MONITOR]      totalShares:', position.shares);
    console.log('[POSITION-MONITOR]      totalCost:', position.totalCost);
    console.log('[POSITION-MONITOR]      entries:', JSON.parse(JSON.stringify(position.entries)));

    if (action === 'BUY') {
        // Add to position using FIFO queue
        // Ensure numeric types to prevent string concatenation bugs
        const numericShares = Number(shares);
        const numericAvgPrice = Number(avgPrice);
        const costOfTrade = numericShares * numericAvgPrice;

        console.log('[POSITION-MONITOR]');
        console.log('[POSITION-MONITOR]   ✅ BUY Action - Executing:');
        console.log('[POSITION-MONITOR]      numericShares:', numericShares, '(converted from', shares, ')');
        console.log('[POSITION-MONITOR]      numericAvgPrice:', numericAvgPrice, '(converted from', avgPrice, ')');
        console.log('[POSITION-MONITOR]      costOfTrade:', costOfTrade, '(shares * avgPrice)');

        position.shares = Number(position.shares) + numericShares;
        position.totalCost = Number(position.totalCost) + costOfTrade;
        position.entries.push({ shares: numericShares, price: numericAvgPrice });

        console.log(`[POSITION-MONITOR]      NEW position.shares: ${Number(position.shares)} (was ${Number(position.shares) - numericShares})`);
        console.log(`[POSITION-MONITOR]      NEW position.totalCost: ${Number(position.totalCost)} (was ${Number(position.totalCost) - costOfTrade})`);
        console.log(`[POSITION-MONITOR]      PUSHED entry: { shares: ${numericShares}, price: ${numericAvgPrice} }`);
    } else if (action === 'SELL') {
        // Remove from position using FIFO
        let remainingToSell = shares;

        console.log('[POSITION-MONITOR]');
        console.log('[POSITION-MONITOR]   ❌ SELL Action - Executing:');
        console.log('[POSITION-MONITOR]      remainingToSell:', remainingToSell);

        while (remainingToSell > 0 && position.entries.length > 0) {
            const entry = position.entries[0];
            console.log(`[POSITION-MONITOR]      Processing entry: { shares: ${entry.shares}, price: ${entry.price} }`);

            if (entry.shares <= remainingToSell) {
                // Consume entire entry
                console.log(`[POSITION-MONITOR]      → Consuming ENTIRE entry (${entry.shares} shares)`);
                remainingToSell -= entry.shares;
                position.shares -= entry.shares;
                position.totalCost -= entry.shares * entry.price;
                position.entries.shift();
                console.log(`[POSITION-MONITOR]      → Removed entry, remainingToSell: ${remainingToSell}`);
            } else {
                // Partial consume
                console.log(`[POSITION-MONITOR]      → PARTIAL consume (${remainingToSell} of ${entry.shares} shares)`);
                entry.shares -= remainingToSell;
                position.shares -= remainingToSell;
                position.totalCost -= remainingToSell * entry.price;
                console.log(`[POSITION-MONITOR]      → Entry reduced to ${entry.shares} shares`);
                remainingToSell = 0;
            }
        }

        // If we sold more than we had, zero out
        if (position.shares < 0) {
            console.log(`[POSITION-MONITOR]      ⚠️  OVERSOLD! position.shares was ${position.shares}, zeroing out`);
            position.shares = 0;
            position.totalCost = 0;
            position.entries = [];
        }
    }

    console.log('[POSITION-MONITOR]');
    console.log('[POSITION-MONITOR]   📊 FULL STATE AFTER UPDATE:');
    console.log('[POSITION-MONITOR]      livePositions.UP.shares:', livePositions.UP.shares);
    console.log('[POSITION-MONITOR]      livePositions.UP.totalCost:', livePositions.UP.totalCost);
    console.log('[POSITION-MONITOR]      livePositions.UP.entries:', JSON.stringify(livePositions.UP.entries));
    console.log('[POSITION-MONITOR]      livePositions.DOWN.shares:', livePositions.DOWN.shares);
    console.log('[POSITION-MONITOR]      livePositions.DOWN.totalCost:', livePositions.DOWN.totalCost);
    console.log('[POSITION-MONITOR]      livePositions.DOWN.entries:', JSON.stringify(livePositions.DOWN.entries));
    console.log('[POSITION-MONITOR]');
    console.log(`[POSITION-MONITOR]   🎯 Target Position (${positionSide}) After:`);
    console.log('[POSITION-MONITOR]      totalShares:', position.shares);
    console.log('[POSITION-MONITOR]      totalCost:', position.totalCost);
    console.log('[POSITION-MONITOR]      avgEntryPrice:', position.shares > 0 ? position.totalCost / position.shares : 0);
    console.log('[POSITION-MONITOR]      entries:', JSON.parse(JSON.stringify(position.entries)));
    console.log(`[POSITION-MONITOR] ========================================`);
    saveLivePositionsToStorage();
}

// Get average entry price for a side
function getLiveEntryPrice(side) {
    const position = livePositions[side];
    if (position.shares === 0) return 0;
    return position.totalCost / position.shares;
}

// Clear positions (for resets or to fix corrupted data)
function clearLivePositions() {
    livePositions = {
        UP: { shares: 0, totalCost: 0, entries: [] },
        DOWN: { shares: 0, totalCost: 0, entries: [] }
    };
    localStorage.removeItem('livePositions');
    saveLivePositionsToStorage();
    console.log('[POSITIONS] ✅ Cleared all live position data');
}

// Expose to window for debugging
window.clearLivePositions = clearLivePositions;

// Initialize on page load
loadLivePositionsFromStorage();

// Function to get current quotes from global state
// Note: currentYesPrice and currentNoPrice are defined at line ~2819 and updated by SSE
function getCurrentQuotes() {
    // Use the global price variables that are updated by the market data stream
    const yesQuote = currentYesPrice || 0.5;
    const noQuote = currentNoPrice || 0.5;
    console.log('[Quotes] Using global prices - YES:', yesQuote, 'NO:', noQuote);
    return { yesQuote, noQuote };
}

// Update positions display directly from livePositions (NO blockchain lookup!)
// This is the equivalent of addTradeToHistory() for positions - instant DOM update
function updatePositionsDisplay() {
    console.log('[POSITION-MONITOR] 💨 updatePositionsDisplay() called');
    const positionsFeed = document.getElementById('positionsFeed');
    if (!positionsFeed) {
        console.log('[POSITION-MONITOR] ⚠️  positionsFeed element not found, exiting');
        return;
    }

    const { yesQuote, noQuote } = getCurrentQuotes();
    console.log('[POSITION-MONITOR]   📈 Current Quotes: YES:', yesQuote, 'NO:', noQuote);
    const positions = [];

    console.log('[POSITION-MONITOR]   🔍 Checking UP position...');
    console.log('[POSITION-MONITOR]      livePositions.UP.shares:', livePositions.UP.shares, '(type:', typeof livePositions.UP.shares, ')');

    // Build positions from livePositions data
    if (livePositions.UP.shares > 0) {
        console.log('[POSITION-MONITOR]      ✅ UP position has shares, building display data...');
        const entryPrice = livePositions.UP.totalCost / livePositions.UP.shares;
        const shares = livePositions.UP.shares;
        const cost = livePositions.UP.totalCost;
        const currentValue = shares * yesQuote;
        const pnl = currentValue - cost;
        const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

        const upPosition = {
            side: 'UP',
            shares: shares,
            entryPrice: entryPrice,
            markPrice: yesQuote,
            value: currentValue,
            cost: cost,
            pnl: pnl,
            pnlPercent: pnlPercent
        };
        console.log('[POSITION-MONITOR]      UP position data:', JSON.stringify(upPosition, null, 2));
        positions.push(upPosition);
    } else {
        console.log('[POSITION-MONITOR]      ⏭️  UP position has 0 shares, skipping');
    }

    console.log('[POSITION-MONITOR]   🔍 Checking DOWN position...');
    console.log('[POSITION-MONITOR]      livePositions.DOWN.shares:', livePositions.DOWN.shares, '(type:', typeof livePositions.DOWN.shares, ')');

    if (livePositions.DOWN.shares > 0) {
        console.log('[POSITION-MONITOR]      ✅ DOWN position has shares, building display data...');
        const entryPrice = livePositions.DOWN.totalCost / livePositions.DOWN.shares;
        const shares = livePositions.DOWN.shares;
        const cost = livePositions.DOWN.totalCost;
        const currentValue = shares * noQuote;
        const pnl = currentValue - cost;
        const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

        const downPosition = {
            side: 'DOWN',
            shares: shares,
            entryPrice: entryPrice,
            markPrice: noQuote,
            value: currentValue,
            cost: cost,
            pnl: pnl,
            pnlPercent: pnlPercent
        };
        console.log('[POSITION-MONITOR]      DOWN position data:', JSON.stringify(downPosition, null, 2));
        positions.push(downPosition);
    } else {
        console.log('[POSITION-MONITOR]      ⏭️  DOWN position has 0 shares, skipping');
    }

    console.log('[POSITION-MONITOR]   📊 Total positions to display:', positions.length);

    // Render positions
    if (positions.length === 0) {
        console.log('[POSITION-MONITOR]   ℹ️  No positions to display, showing empty state');
        positionsFeed.innerHTML = `
            <div class="trade-feed-empty">
                <span class="empty-icon">💼</span>
                <span class="empty-text">No open positions</span>
            </div>
        `;
        return;
    }

    let html = `
        <div class="positions-header">
            <div class="pos-side">SIDE</div>
            <div class="pos-shares">SHARES</div>
            <div class="pos-entry">ENTRY</div>
            <div class="pos-mark">MARK</div>
            <div class="pos-value">VALUE</div>
            <div class="pos-cost">COST</div>
            <div class="pos-pnl">PNL</div>
        </div>
    `;

    for (const pos of positions) {
        const sideClass = pos.side === 'UP' ? 'type-up' : 'type-down';
        const pnlClass = pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlSign = pos.pnl >= 0 ? '+' : '';

        html += `
            <div class="position-row">
                <div class="pos-side ${sideClass}">${pos.side}</div>
                <div class="pos-shares">${pos.shares.toFixed(2)}</div>
                <div class="pos-entry">${pos.entryPrice.toFixed(4)}</div>
                <div class="pos-mark">${pos.markPrice.toFixed(4)}</div>
                <div class="pos-value">${pos.value.toFixed(2)}</div>
                <div class="pos-cost">${pos.cost.toFixed(2)}</div>
                <div class="pos-pnl ${pnlClass}">
                    ${pnlSign}${pos.pnl.toFixed(2)}
                    <span class="pnl-percent">(${pnlSign}${pos.pnlPercent.toFixed(1)}%)</span>
                </div>
            </div>
        `;
    }

    positionsFeed.innerHTML = html;
    console.log('[POSITION-MONITOR]   ✅ DOM updated! Rendered', positions.length, 'position(s)');
    console.log('[POSITION-MONITOR] ========================================');
}

// Expose to window
window.updatePositionsDisplay = updatePositionsDisplay;

async function loadPositions() {
    const positionsFeed = document.getElementById('positionsFeed');

    if (!wallet || !wallet.publicKey) {
        positionsFeed.innerHTML = `
            <div class="trade-feed-empty">
                <span class="empty-icon">💼</span>
                <span class="empty-text">Connect wallet to view your positions</span>
            </div>
        `;
        return;
    }

    const walletPubkey = wallet.publicKey.toString();
    console.log('[POSITIONS] 🔄 Loading positions for wallet:', walletPubkey);

    try {
        // Fetch ONLY from position API - single source of truth (use relative URL for same-origin)
        const positionUrl = `/api/position/${walletPubkey}`;
        console.log('[POSITIONS] 📡 Fetching:', positionUrl);

        const positionResponse = await fetch(positionUrl);
        if (!positionResponse.ok) {
            throw new Error(`Position API returned ${positionResponse.status}`);
        }

        const positionData = await positionResponse.json();
        console.log('[POSITIONS] 🔗 Position data:', positionData);

        // Get current market quotes for mark-to-market
        const { yesQuote, noQuote } = getCurrentQuotes();
        console.log('[POSITIONS] 💹 Market quotes - YES:', yesQuote, 'NO:', noQuote);

        // Build positions array from API data only
        const positions = [];

        // Build UP position if exists
        if (positionData.yesShares > 0) {
            // Use cost basis from SQLite for accurate entry price
            const entryPrice = positionData.yesAvgEntry || 0;
            const costBasis = positionData.yesCostBasis || 0;
            const currentValue = positionData.yesShares * yesQuote;
            const pnl = currentValue - costBasis;
            const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

            positions.push({
                side: 'UP',
                shares: positionData.yesShares,
                entryPrice: entryPrice,
                markPrice: yesQuote,
                value: currentValue,
                cost: costBasis,
                pnl: pnl,
                pnlPercent: pnlPercent
            });

            console.log('[POSITIONS] ✅ UP Position:', {
                shares: positionData.yesShares,
                entry: entryPrice.toFixed(4),
                mark: yesQuote.toFixed(4),
                costBasis: costBasis.toFixed(2),
                value: currentValue.toFixed(2),
                pnl: pnl.toFixed(2)
            });
        }

        // Build DOWN position if exists
        if (positionData.noShares > 0) {
            // Use cost basis from SQLite for accurate entry price
            const entryPrice = positionData.noAvgEntry || 0;
            const costBasis = positionData.noCostBasis || 0;
            const currentValue = positionData.noShares * noQuote;
            const pnl = currentValue - costBasis;
            const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

            positions.push({
                side: 'DOWN',
                shares: positionData.noShares,
                entryPrice: entryPrice,
                markPrice: noQuote,
                value: currentValue,
                cost: costBasis,
                pnl: pnl,
                pnlPercent: pnlPercent
            });

            console.log('[POSITIONS] ✅ DOWN Position:', {
                shares: positionData.noShares,
                entry: entryPrice.toFixed(4),
                mark: noQuote.toFixed(4),
                costBasis: costBasis.toFixed(2),
                value: currentValue.toFixed(2),
                pnl: pnl.toFixed(2)
            });
        }

        // Render positions
        if (positions.length === 0) {
            positionsFeed.innerHTML = `
                <div class="trade-feed-empty">
                    <span class="empty-icon">💼</span>
                    <span class="empty-text">No open positions</span>
                </div>
            `;
        } else {
            let html = `
                <div class="positions-header">
                    <div class="pos-side">SIDE</div>
                    <div class="pos-shares">SHARES</div>
                    <div class="pos-entry">ENTRY</div>
                    <div class="pos-mark">MARK</div>
                    <div class="pos-value">VALUE</div>
                    <div class="pos-cost">COST</div>
                    <div class="pos-pnl">PNL</div>
                </div>
            `;

            for (const pos of positions) {
                const sideClass = pos.side === 'UP' ? 'type-up' : 'type-down';
                const pnlClass = pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                const pnlSign = pos.pnl >= 0 ? '+' : '';

                html += `
                    <div class="position-row">
                        <div class="pos-side ${sideClass}">${pos.side}</div>
                        <div class="pos-shares">${pos.shares.toFixed(2)}</div>
                        <div class="pos-entry">${pos.entryPrice.toFixed(4)}</div>
                        <div class="pos-mark">${pos.markPrice.toFixed(4)}</div>
                        <div class="pos-value">${pos.value.toFixed(2)}</div>
                        <div class="pos-cost">${pos.cost.toFixed(2)}</div>
                        <div class="pos-pnl ${pnlClass}">
                            ${pnlSign}${pos.pnl.toFixed(2)}
                            <span class="pnl-percent">(${pnlSign}${pos.pnlPercent.toFixed(1)}%)</span>
                        </div>
                    </div>
                `;
            }

            positionsFeed.innerHTML = html;
        }
    } catch (err) {
        console.error('Failed to load positions:', err);
        positionsFeed.innerHTML = `
            <div class="trade-feed-empty">
                <span class="empty-icon">❌</span>
                <span class="empty-text">Failed to load positions: ${err.message}</span>
            </div>
        `;
    }
}

// Helper function to get cost basis and entry price from trading history
// This calculates the cost basis for the CURRENT position using FIFO accounting
// Returns { costBasis, entryPrice } where entryPrice is the weighted average
async function getCostBasisAndEntry(userPrefix, side) {
    try {
        // Always use /api endpoint for trading history
        const response = await fetch(`/api/trading-history/${userPrefix}`);
        if (!response.ok) return { costBasis: 0, entryPrice: 0 };

        const data = await response.json();

        console.log(`[Cost Basis] Calculating for ${side}, found ${data.history?.length || 0} trades`);

        // FIFO queue: each entry is { shares, costPerShare }
        const fifoQueue = [];

        for (const trade of data.history) {
            if (trade.side === side) {
                if (trade.action === 'BUY') {
                    // Add to FIFO queue
                    const cost = Math.abs(trade.cost_usd);
                    const costPerShare = cost / trade.shares;
                    fifoQueue.push({ shares: trade.shares, costPerShare });
                    console.log(`  BUY: +${trade.shares} shares @ $${costPerShare.toFixed(4)}/share (total cost: $${cost.toFixed(2)})`);
                } else if (trade.action === 'SELL') {
                    // Remove from FIFO queue
                    let sharesToSell = trade.shares;
                    console.log(`  SELL: -${trade.shares} shares`);

                    while (sharesToSell > 0 && fifoQueue.length > 0) {
                        const oldest = fifoQueue[0];
                        if (oldest.shares <= sharesToSell) {
                            // Consume entire lot
                            sharesToSell -= oldest.shares;
                            console.log(`    Consumed lot: ${oldest.shares} shares @ $${oldest.costPerShare.toFixed(4)}/share`);
                            fifoQueue.shift();
                        } else {
                            // Partial consumption
                            oldest.shares -= sharesToSell;
                            console.log(`    Partial lot: ${sharesToSell} shares @ $${oldest.costPerShare.toFixed(4)}/share (${oldest.shares} remaining)`);
                            sharesToSell = 0;
                        }
                    }
                }
            }
        }

        // Calculate total cost basis and weighted average entry price from remaining lots
        let totalCost = 0;
        let totalShares = 0;
        for (const lot of fifoQueue) {
            totalCost += lot.shares * lot.costPerShare;
            totalShares += lot.shares;
        }

        const entryPrice = totalShares > 0 ? totalCost / totalShares : 0;

        console.log(`[Cost Basis] Final: ${totalShares.toFixed(2)} shares, total cost: $${totalCost.toFixed(2)}, avg entry: $${entryPrice.toFixed(4)}/share`);
        return { costBasis: totalCost, entryPrice };
    } catch (err) {
        console.error('Failed to get cost basis:', err);
        return { costBasis: 0, entryPrice: 0 };
    }
}

// Load all positions for current cycle (all players)
async function loadAllPositions() {
    const feed = document.getElementById('allPositionsFeed');
    if (!feed) return;

    try {
        const response = await fetch('/api/cycle-positions');
        if (!response.ok) throw new Error('Failed to fetch all positions');

        const data = await response.json();
        const positions = data.positions || [];

        if (positions.length === 0) {
            feed.innerHTML = `
                <div class="trade-feed-empty">
                    <span class="empty-icon">👥</span>
                    <span class="empty-text">No positions in current cycle</span>
                </div>
            `;
            return;
        }

        // Sort by total position value (up_cost + down_cost absolute values)
        positions.sort((a, b) => {
            const aTotal = Math.abs(a.up_cost) + Math.abs(a.down_cost);
            const bTotal = Math.abs(b.up_cost) + Math.abs(b.down_cost);
            return bTotal - aTotal;
        });

        // Calculate totals for UP and DOWN
        let totalUpShares = 0;
        let totalDownShares = 0;
        let totalUpCost = 0;
        let totalDownCost = 0;
        for (const pos of positions) {
            totalUpShares += Math.abs(pos.up_shares || 0);
            totalDownShares += Math.abs(pos.down_shares || 0);
            totalUpCost += Math.abs(pos.up_cost || 0);
            totalDownCost += Math.abs(pos.down_cost || 0);
        }

        let html = `<div class="all-positions-header" style="padding: 8px 12px; font-size: 11px; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.1);">
            <span>Cycle: ${data.cycleId || 'Current'}</span>
            <span style="float: right;">${positions.length} player${positions.length !== 1 ? 's' : ''}</span>
        </div>`;

        // Add totals summary
        html += `<div class="all-positions-totals" style="padding: 12px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.1);">
            <div style="display: flex; justify-content: space-around; gap: 20px;">
                <div style="text-align: center;">
                    <div style="font-size: 10px; color: rgba(255,255,255,0.5); margin-bottom: 4px;">🟢 TOTAL UP</div>
                    <div style="font-size: 16px; font-weight: 600; color: #00c853;">${totalUpShares.toFixed(2)}</div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.5);">${totalUpCost.toFixed(4)} XNT</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 10px; color: rgba(255,255,255,0.5); margin-bottom: 4px;">🔴 TOTAL DOWN</div>
                    <div style="font-size: 16px; font-weight: 600; color: #ff5252;">${totalDownShares.toFixed(2)}</div>
                    <div style="font-size: 11px; color: rgba(255,255,255,0.5);">${totalDownCost.toFixed(4)} XNT</div>
                </div>
            </div>
        </div>`;

        for (const pos of positions) {
            const userPrefix = pos.user_prefix || 'Unknown';
            const upShares = pos.up_shares || 0;
            const downShares = pos.down_shares || 0;
            const upCost = pos.up_cost || 0;
            const downCost = pos.down_cost || 0;

            // Determine which side they're on
            let sideClass = '';
            let sideText = '';
            let shares = 0;
            let cost = 0;

            if (Math.abs(upShares) > Math.abs(downShares)) {
                sideClass = upShares > 0 ? 'side-yes' : 'side-no';
                sideText = upShares > 0 ? 'UP' : 'UP (SHORT)';
                shares = upShares;
                cost = upCost;
            } else if (Math.abs(downShares) > 0) {
                sideClass = downShares > 0 ? 'side-no' : 'side-yes';
                sideText = downShares > 0 ? 'DOWN' : 'DOWN (SHORT)';
                shares = downShares;
                cost = downCost;
            } else {
                sideClass = '';
                sideText = 'NEUTRAL';
                shares = 0;
                cost = 0;
            }

            const sharesDisplay = Math.abs(shares).toFixed(2);
            const costDisplay = Math.abs(cost).toFixed(4);

            html += `
                <div class="position-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="user-badge" style="font-family: monospace; font-size: 12px; color: #5b9eff;">${userPrefix}</span>
                        <span class="${sideClass}" style="font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 3px; ${sideClass === 'side-yes' ? 'background: rgba(0,200,83,0.2); color: #00c853;' : sideClass === 'side-no' ? 'background: rgba(255,82,82,0.2); color: #ff5252;' : 'background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.5);'}">${sideText}</span>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 13px; font-weight: 500; color: #fff;">${sharesDisplay} shares</div>
                        <div style="font-size: 11px; color: rgba(255,255,255,0.5);">${costDisplay} XNT</div>
                    </div>
                </div>
            `;
        }

        feed.innerHTML = html;

    } catch (err) {
        console.error('Failed to load all positions:', err);
        feed.innerHTML = `
            <div class="trade-feed-empty">
                <span class="empty-icon">⚠️</span>
                <span class="empty-text">Failed to load positions</span>
            </div>
        `;
    }
}

// ============= END POSITIONS =============

function switchFeedTab(tab) {
    const liveFeedTab = document.getElementById('liveFeedTab');
    const positionsFeedTab = document.getElementById('positionsFeedTab');
    const allPositionsFeedTab = document.getElementById('allPositionsFeedTab');
    const settlementFeedTab = document.getElementById('settlementFeedTab');
    const tradingFeedTab = document.getElementById('tradingFeedTab');
    const ordersFeedTab = document.getElementById('ordersFeedTab');
    const filledFeedTab = document.getElementById('filledFeedTab');
    const tradeFeed = document.getElementById('tradeFeed');
    const positionsFeed = document.getElementById('positionsFeed');
    const allPositionsFeed = document.getElementById('allPositionsFeed');
    const settlementFeed = document.getElementById('settlementFeed');
    const tradingFeed = document.getElementById('tradingFeed');
    const ordersFeed = document.getElementById('ordersFeed');
    const filledFeed = document.getElementById('filledFeed');

    // Reset all tabs
    liveFeedTab.classList.remove('active');
    positionsFeedTab.classList.remove('active');
    allPositionsFeedTab.classList.remove('active');
    settlementFeedTab.classList.remove('active');
    tradingFeedTab.classList.remove('active');
    ordersFeedTab.classList.remove('active');
    filledFeedTab.classList.remove('active');
    tradeFeed.classList.add('hidden');
    positionsFeed.classList.add('hidden');
    allPositionsFeed.classList.add('hidden');
    settlementFeed.classList.add('hidden');
    tradingFeed.classList.add('hidden');
    ordersFeed.classList.add('hidden');
    filledFeed.classList.add('hidden');

    // Update current tab tracker
    currentFeedTab = tab;

    // Clear positions refresh interval when switching away
    if (positionsRefreshInterval) {
        clearInterval(positionsRefreshInterval);
        positionsRefreshInterval = null;
    }

    if (tab === 'live') {
        liveFeedTab.classList.add('active');
        tradeFeed.classList.remove('hidden');
    } else if (tab === 'positions') {
        positionsFeedTab.classList.add('active');
        positionsFeed.classList.remove('hidden');
        loadPositions();

        // Auto-refresh positions every 3 seconds
        positionsRefreshInterval = setInterval(() => {
            if (currentFeedTab === 'positions') {
                loadPositions();
            }
        }, 3000);
    } else if (tab === 'allPositions') {
        allPositionsFeedTab.classList.add('active');
        allPositionsFeed.classList.remove('hidden');
        loadAllPositions();

        // Auto-refresh all positions every 5 seconds
        positionsRefreshInterval = setInterval(() => {
            if (currentFeedTab === 'allPositions') {
                loadAllPositions();
            }
        }, 5000);
    } else if (tab === 'settlement') {
        settlementFeedTab.classList.add('active');
        settlementFeed.classList.remove('hidden');
        loadSettlementHistory();
    } else if (tab === 'trading') {
        tradingFeedTab.classList.add('active');
        tradingFeed.classList.remove('hidden');
        loadTradingHistory();
    } else if (tab === 'orders') {
        ordersFeedTab.classList.add('active');
        ordersFeed.classList.remove('hidden');
        loadOpenOrders();
    } else if (tab === 'filled') {
        filledFeedTab.classList.add('active');
        filledFeed.classList.remove('hidden');
        loadFilledOrders();
    }
}

// Auto-refresh settlement history if tab is active
// Only poll when using JavaScript API (/api) - TypeScript API uses SSE streams
if (CONFIG.API_PREFIX === '/api') {
    setInterval(() => {
        if (currentFeedTab === 'settlement') {
            loadSettlementHistory();
        }
    }, 10000); // Refresh every 10 seconds for JavaScript API only
}

// ============= INITIALIZATION =============

window.addEventListener('DOMContentLoaded', async () => {
    // Initialize rapid fire and debug toggles
    initToggles();

    // Initialize real-time market status stream (SSE)
    initStatusStream();

    // Initialize alarm toggle from localStorage
    const alarmToggle = document.getElementById('alarmToggle');

    // Load saved preference (default: enabled)
    const savedPref = localStorage.getItem('alarmEnabled');
    alarmEnabled = savedPref !== null ? savedPref === 'true' : true;
    console.log(`🔔 Alarm initialized: ${alarmEnabled ? 'ENABLED' : 'DISABLED'} (savedPref: ${savedPref})`);

    // Sync notification permission status
    if ('Notification' in window) {
        notificationPermission = Notification.permission;
        console.log(`🔔 Initial notification permission: ${notificationPermission}`);
    }

    // Request notification permission if alarm is enabled
    if (alarmEnabled) {
        await requestNotificationPermission();
    }

    // Initialize countdown toggle
    if (alarmToggle) {
        alarmToggle.checked = alarmEnabled;
        console.log(`✅ Alarm toggle element found and set to: ${alarmToggle.checked}`);

        alarmToggle.addEventListener('change', async (e) => {
            alarmEnabled = e.target.checked;
            localStorage.setItem('alarmEnabled', alarmEnabled);
            console.log(`🔔 Alarm toggled: ${alarmEnabled ? 'ENABLED' : 'DISABLED'}`);

            // Request notification permission when alarm is enabled
            if (alarmEnabled) {
                await requestNotificationPermission();
            }

            // Show brief visual feedback
            const label = e.target.parentElement;
            if (label) {
                const originalTransform = label.style.transform;
                label.style.transform = 'scale(1.08)';
                setTimeout(() => {
                    label.style.transform = originalTransform || '';
                }, 150);
            }
        });
    } else {
        console.warn('⚠️ Alarm toggle element NOT FOUND (#alarmToggle)');
    }

    // Add input listener for trade amount (shares)
    const tradeAmountInput = document.getElementById('tradeAmountShares');
    if (tradeAmountInput) {
        tradeAmountInput.addEventListener('input', () => {
            validateSellButtons();
            updateTradeButton();
        });
    }

    // Add input listener for XNT amount
    const tradeAmountXnt = document.getElementById('tradeAmountXnt');
    if (tradeAmountXnt) {
        tradeAmountXnt.addEventListener('input', () => {
            validateSellButtons();
            updateTradeButton();
        });
    }
});

// Update button states based on market status
function updateButtonStates() {
    const tradeBtn = document.getElementById('tradeBtn');
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');

    // Trade buttons - enable when market is PREMARKET (status = 0) or OPEN (status = 1)
    const canTrade = currentMarketStatus === 0 || currentMarketStatus === 1;
    
    if (tradeBtn) {
        tradeBtn.disabled = !canTrade;
        if (!canTrade) {
            tradeBtn.style.opacity = '0.5';
            tradeBtn.style.cursor = 'not-allowed';
        } else {
            tradeBtn.style.opacity = '1';
            tradeBtn.style.cursor = 'pointer';
        }
    }
    
    if (yesBtn) {
        yesBtn.disabled = !canTrade;
        if (!canTrade) {
            yesBtn.style.opacity = '0.5';
            yesBtn.style.cursor = 'not-allowed';
        } else {
            yesBtn.style.opacity = '1';
            yesBtn.style.cursor = 'pointer';
        }
    }
    
    if (noBtn) {
        noBtn.disabled = !canTrade;
        if (!canTrade) {
            noBtn.style.opacity = '0.5';
            noBtn.style.cursor = 'not-allowed';
        } else {
            noBtn.style.opacity = '1';
            noBtn.style.cursor = 'pointer';
        }
    }
    
    // Redeem button - enable only when market is SETTLED (status = 2)
    const redeemBtns = document.querySelectorAll('[onclick*="redeemWinnings"]');
    const canRedeem = currentMarketStatus === 2;
    
    redeemBtns.forEach(btn => {
        btn.disabled = !canRedeem;
        if (!canRedeem) {
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        } else {
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }
    });
}

// ============= DEPOSIT/WITHDRAW MODAL FUNCTIONS =============

async function openDepositModal() {
    remoteLog('[DEBUG] openDepositModal called');

    if (!backpackWallet || !wallet) {
        remoteLog('[DEBUG] Wallet not connected - backpackWallet:' + !!backpackWallet + ' wallet:' + !!wallet);
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    // Show modal
    const modal = document.getElementById('depositModal');
    remoteLog('[DEBUG] depositModal element: ' + (modal ? 'found' : 'NOT FOUND'));
    if (modal) {
        modal.classList.remove('hidden');
        remoteLog('[DEBUG] Modal shown');
    }

    // Update balances
    await updateDepositModalBalances();

    // Check if position exists and show/hide Create User button
    const createUserBtn = document.getElementById('createUserBtn');
    const depositBtn = document.getElementById('executeDepositBtn');
    remoteLog('[DEBUG] createUserBtn found: ' + !!createUserBtn + ', depositBtn found: ' + !!depositBtn);

    if (createUserBtn && depositBtn) {
        const positionExists = await checkPositionExists();
        remoteLog('[DEBUG] Position exists check result: ' + positionExists);
        if (positionExists) {
            createUserBtn.classList.add('hidden');
            depositBtn.classList.remove('hidden');
            remoteLog('[DEBUG] Showing Deposit button, hiding Create User');
        } else {
            createUserBtn.classList.remove('hidden');
            depositBtn.classList.add('hidden');
            remoteLog('[DEBUG] Showing Create User button, hiding Deposit');
        }
    }

    // Add button hover tracking for smart MAX button
    const navDepositBtn = document.getElementById('depositBtn');
    const withdrawBtn = document.getElementById('withdrawBtn');

    if (navDepositBtn) {
        navDepositBtn.addEventListener('mouseenter', () => { lastFocusedAction = 'deposit'; });
        navDepositBtn.addEventListener('focus', () => { lastFocusedAction = 'deposit'; });
    }

    if (withdrawBtn) {
        withdrawBtn.addEventListener('mouseenter', () => { lastFocusedAction = 'withdraw'; });
        withdrawBtn.addEventListener('focus', () => { lastFocusedAction = 'withdraw'; });
    }

    // Populate account addresses
    await populateAccountAddresses();
}

// Check if position account exists on-chain
async function checkPositionExists() {
    remoteLog('[DEBUG] checkPositionExists called, wallet: ' + !!wallet + ', ammPda: ' + !!ammPda);
    if (!wallet || !ammPda) {
        remoteLog('[DEBUG] checkPositionExists - no wallet or ammPda, returning false');
        return false;
    }

    try {
        const [posPda] = solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );
        remoteLog('[DEBUG] Position PDA: ' + posPda.toString().substring(0, 12) + '...');

        const accountInfo = await connection.getAccountInfo(posPda);
        const exists = accountInfo !== null;
        remoteLog('[DEBUG] Position exists: ' + exists);
        return exists;
    } catch (err) {
        remoteLog('[DEBUG] Check position error: ' + err.message);
        return false;
    }
}

// Create User - Initialize position and fund session wallet
async function createUser() {
    remoteLog('[DEBUG] createUser called');

    if (!backpackWallet || !wallet) {
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    // Get amount from input (default to 1.0 XNT if empty)
    const amountInput = document.getElementById('depositAmount');
    let amount = parseFloat(amountInput?.value || '1.0');
    if (isNaN(amount) || amount < 1.0) {
        amount = 1.0;
    }

    addLog(`Creating user account with ${amount} XNT...`, 'info');

    try {
        // Initialize position (this also funds session wallet with 1.01 XNT)
        const success = await initPosition();
        if (!success) {
            addLog('ERROR: Failed to create user account', 'error');
            showError('Failed to create user account');
            return;
        }

        addLog('User account created successfully!', 'success');
        showStatus('User account created!');

        // Refresh balances
        await updateDepositModalBalances();
        await fetchPositionData();

        // Hide Create User button, show Deposit button
        const createUserBtn = document.getElementById('createUserBtn');
        const depositBtn = document.getElementById('executeDepositBtn');
        if (createUserBtn) createUserBtn.classList.add('hidden');
        if (depositBtn) depositBtn.classList.remove('hidden');

        // Also hide the nav Create User button
        const createUserNavBtn = document.getElementById('createUserNavBtn');
        if (createUserNavBtn) createUserNavBtn.classList.add('hidden');

    } catch (err) {
        addLog('ERROR: ' + err.message, 'error');
        showError(err.message);
    }
}

// Open Create User Modal - same as deposit modal but focused on creating user
async function openCreateUserModal() {
    remoteLog('[DEBUG] openCreateUserModal called');

    if (!backpackWallet || !wallet) {
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    // Open the deposit modal
    const modal = document.getElementById('depositModal');
    if (modal) {
        modal.classList.remove('hidden');
    }

    // Update balances
    await updateDepositModalBalances();

    // Force show Create User button, hide Deposit button
    const createUserBtn = document.getElementById('createUserBtn');
    const depositBtn = document.getElementById('executeDepositBtn');
    if (createUserBtn) createUserBtn.classList.remove('hidden');
    if (depositBtn) depositBtn.classList.add('hidden');

    // Populate account addresses
    await populateAccountAddresses();
}

// Update nav Create User button visibility based on position existence
async function updateCreateUserNavButton() {
    const createUserNavBtn = document.getElementById('createUserNavBtn');
    if (!createUserNavBtn) return;

    if (!wallet || !ammPda) {
        createUserNavBtn.classList.add('hidden');
        return;
    }

    const positionExists = await checkPositionExists();
    if (positionExists) {
        createUserNavBtn.classList.add('hidden');
    } else {
        createUserNavBtn.classList.remove('hidden');
    }
}

async function toggleAccountsDisplay() {
    const checkbox = document.getElementById('showAccountsToggle');
    const section = document.getElementById('accountAddressesSection');

    if (checkbox && section) {
        if (checkbox.checked) {
            section.style.display = 'block';
            // Populate addresses when shown
            await populateAccountAddresses();
        } else {
            section.style.display = 'none';
        }
    }
}

async function populateAccountAddresses() {
    if (!wallet || !backpackWallet) return;

    try {
        // Backpack wallet
        const backpackAddr = backpackWallet.publicKey.toString();
        document.getElementById('backpackWalletAddr').textContent = backpackAddr;

        // Session wallet
        const sessionAddr = wallet.publicKey.toString();
        document.getElementById('sessionWalletAddr').textContent = sessionAddr;

        // Position PDA
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );
        document.getElementById('positionPdaAddr').textContent = posPda.toString();

        // User Vault PDA
        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );
        document.getElementById('userVaultPdaAddr').textContent = userVaultPda.toString();

    } catch (err) {
        console.error('Failed to populate account addresses:', err);
    }
}

function copyAddress(element) {
    const address = element.textContent;
    if (address && address !== '-') {
        navigator.clipboard.writeText(address).then(() => {
            // Visual feedback
            const originalText = element.textContent;
            element.textContent = '✓ Copied!';
            element.style.color = '#0f0';
            setTimeout(() => {
                element.textContent = originalText;
                element.style.color = '#0f0';
            }, 1000);
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    }
}

function closeDepositModal() {
    const modal = document.getElementById('depositModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    // Reset toggle state
    const checkbox = document.getElementById('showAccountsToggle');
    if (checkbox) checkbox.checked = false;
    const section = document.getElementById('accountAddressesSection');
    if (section) section.style.display = 'none';

    // Reset to default
    lastFocusedAction = 'deposit';
}

async function updateDepositModalBalances() {
    console.log('[updateDepositModalBalances] Starting balance refresh...');
    try {
        // Get Backpack wallet balance
        if (backpackWallet && backpackWallet.publicKey) {
            const balance = await connection.getBalance(backpackWallet.publicKey);
            const balanceXNT = balance / 1e9;
            const elem = document.getElementById('sessionWalletBalance');
            if (elem) {
                elem.textContent = `${balanceXNT.toFixed(4)} XNT`;
                console.log('[updateDepositModalBalances] Updated Backpack balance:', balanceXNT.toFixed(4));
            }
        }

        // Get session wallet balance (for TX fees)
        if (wallet && wallet.publicKey) {
            const balance = await connection.getBalance(wallet.publicKey);
            const balanceXNT = balance / 1e9;
            const elem = document.getElementById('tradingWalletBalance');
            if (elem) {
                elem.textContent = `${balanceXNT.toFixed(4)} XNT`;
                console.log('[updateDepositModalBalances] Updated Session wallet balance:', balanceXNT.toFixed(4));
            }
        }

        // Get vault balance (user_vault PDA)
        const vaultBalance = await getUserVaultBalance();
        const elem = document.getElementById('currentVaultBalance');
        if (elem) {
            elem.textContent = `${vaultBalance.toFixed(4)} XNT`;
            console.log('[updateDepositModalBalances] Updated Vault balance:', vaultBalance.toFixed(4));
        }
        console.log('[updateDepositModalBalances] ✅ Balance refresh complete');
    } catch (err) {
        console.error('[updateDepositModalBalances] ❌ Failed to update:', err);
        addLog('ERROR: Failed to load balances', 'error');
    }
}

async function getUserVaultBalance() {
    if (!wallet || !ammPda) {
        console.log('[getUserVaultBalance] Missing wallet or ammPda');
        return 0;
    }

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const positionInfo = await connection.getAccountInfo(posPda);
        if (!positionInfo || !positionInfo.data || positionInfo.data.length < 8 + 32 + 8 + 8 + 32 + 8) {
            console.log('[getUserVaultBalance] No position data found');
            return 0;
        }

        const data = positionInfo.data;
        const offset = 8 + 32 + 8 + 8 + 32; // Skip discriminator, owner, yes_shares, no_shares, master_wallet
        const vaultBalanceE6 = Number(data.readBigInt64LE(offset));

        // Convert e6 to XNT: 1 XNT = 10,000,000 e6 (LAMPORTS_PER_E6 = 100)
        const vaultBalanceXNT = vaultBalanceE6 / 10_000_000;
        console.log('[getUserVaultBalance] Raw e6:', vaultBalanceE6, '→ XNT:', vaultBalanceXNT);
        return vaultBalanceXNT;
    } catch (err) {
        console.error('[getUserVaultBalance] Error:', err);
        return 0;
    }
}

// Smart MAX button - sets max based on which button was last focused
let lastFocusedAction = 'deposit'; // default to deposit

function setMaxDeposit() {
    // Set to Backpack wallet balance (for deposits)
    if (backpackWallet && backpackWallet.publicKey) {
        connection.getBalance(backpackWallet.publicKey).then(balance => {
            const balanceXNT = balance / 1e9;
            // Leave a bit for fees
            const maxDeposit = Math.max(0, balanceXNT - 0.01);
            const input = document.getElementById('depositAmount');
            if (input) {
                input.value = maxDeposit.toFixed(4);
            }
        }).catch(err => {
            console.error('Failed to get balance:', err);
            addLog('ERROR: Failed to get balance', 'error');
        });
    }
}

async function setMaxWithdraw() {
    // Set to vault balance minus rent-exempt minimum (for withdrawals)
    const vaultBalance = await getUserVaultBalance();
    // Leave 0.001 XNT (1,000,000 lamports) for rent exemption
    const rentReserve = 0.001;
    const maxWithdrawable = Math.max(0, vaultBalance - rentReserve);
    const input = document.getElementById('depositAmount');
    if (input) {
        input.value = maxWithdrawable.toFixed(4);
    }
}

async function setMaxAmount() {
    // Smart MAX: set based on last focused button or input field
    const depositBtn = document.getElementById('depositBtn');
    const withdrawBtn = document.getElementById('withdrawBtn');

    // Check which button is currently highlighted/focused
    if (document.activeElement === withdrawBtn || lastFocusedAction === 'withdraw') {
        await setMaxWithdraw();
    } else {
        setMaxDeposit();
    }
}

async function executeDeposit() {
    remoteLog('[DEBUG] executeDeposit called');
    lastFocusedAction = 'deposit'; // Track action

    if (!backpackWallet || !wallet) {
        remoteLog('[DEBUG] executeDeposit - wallet not connected');
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput.value);
    remoteLog('[DEBUG] executeDeposit - amount: ' + amount);

    if (isNaN(amount) || amount <= 0) {
        remoteLog('[DEBUG] executeDeposit - invalid amount');
        addLog('ERROR: Invalid deposit amount', 'error');
        showError('Invalid amount');
        return;
    }

    const amountLamports = Math.floor(amount * 1e9);

    addLog(`Depositing ${amount.toFixed(4)} XNT to vault...`, 'info');
    showStatus('Depositing...');

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const discriminator = await createDiscriminator('deposit');

        // Create amount buffer (8 bytes, little endian, unsigned)
        const amountBuf = new Uint8Array(8);
        const view = new DataView(amountBuf.buffer);
        view.setBigUint64(0, BigInt(amountLamports), true);

        const data = concatUint8Arrays(discriminator, amountBuf);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },  // ✅ Make writable for session wallet funding
            { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        // ========================================
        // Add 1.0 XNT funding to session wallet
        // ========================================
        const sessionFunding = 1.0 * solanaWeb3.LAMPORTS_PER_SOL; // 1.0 XNT

        const fundSessionIx = solanaWeb3.SystemProgram.transfer({
            fromPubkey: backpackWallet.publicKey,  // Source: Backpack wallet
            toPubkey: wallet.publicKey,            // Destination: Session wallet
            lamports: sessionFunding               // Amount: 1.0 XNT
        });

        // Build transaction with TWO instructions:
        // 1. Fund session wallet (SystemProgram transfer)
        // 2. Deposit to vault (program instruction)
        const transaction = new solanaWeb3.Transaction().add(
            fundSessionIx,     // Transfer 1.0 XNT to session wallet
            instruction        // Deposit to vault
        );
        transaction.feePayer = backpackWallet.publicKey;

        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        remoteLog('[DEBUG] executeDeposit - got blockhash: ' + blockhash);

        // Sign with session wallet first
        remoteLog('[DEBUG] executeDeposit - signing with session wallet...');
        transaction.sign(wallet);
        remoteLog('[DEBUG] executeDeposit - session wallet signed');

        // Then sign with Backpack
        remoteLog('[DEBUG] executeDeposit - calling backpackWallet.signTransaction...');
        remoteLog('[DEBUG] backpackWallet type: ' + typeof backpackWallet);
        remoteLog('[DEBUG] backpackWallet.signTransaction: ' + typeof backpackWallet.signTransaction);
        const signedTx = await backpackWallet.signTransaction(transaction);
        remoteLog('[DEBUG] executeDeposit - got signed tx: ' + (signedTx ? 'yes' : 'null'));
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        remoteLog('[DEBUG] executeDeposit - tx sent, signature: ' + signature);

        addLog(`TX: ${signature}`, 'tx');
        showStatus('Confirming...');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog(`✓ Deposited ${amount.toFixed(4)} XNT to vault + funded session wallet with 1.0 XNT`, 'success');

        // Wait a moment for blockchain state to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // Update all balances in the modal
        await updateDepositModalBalances();

        // Update main wallet balance display
        await updateWalletBalance();

        // Clear input
        amountInput.value = '';

    } catch (err) {
        console.error('Deposit failed:', err);
        addLog(`ERROR: ${err.message}`, 'error');
        showError('Deposit failed');
    }
}

async function executeWithdraw() {
    lastFocusedAction = 'withdraw'; // Track action

    if (!backpackWallet || !wallet) {
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput.value);

    if (isNaN(amount) || amount <= 0) {
        addLog('ERROR: Invalid withdrawal amount', 'error');
        showError('Invalid amount');
        return;
    }

    const amountLamports = Math.floor(amount * 1e9);

    addLog(`Withdrawing ${amount.toFixed(4)} XNT from vault to Backpack...`, 'info');
    showStatus('Withdrawing...');

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const discriminator = await createDiscriminator('withdraw');

        // Create amount buffer (8 bytes, little endian, unsigned)
        const amountBuf = new Uint8Array(8);
        const view = new DataView(amountBuf.buffer);
        view.setBigUint64(0, BigInt(amountLamports), true);

        const data = concatUint8Arrays(discriminator, amountBuf);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        const transaction = new solanaWeb3.Transaction().add(instruction);
        transaction.feePayer = backpackWallet.publicKey;

        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;

        // Sign with both wallets (both need to sign for withdrawal security)
        transaction.partialSign(wallet);

        // Sign and send with Backpack
        const signed = await backpackWallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize());

        addLog(`TX: ${signature}`, 'tx');
        showStatus('Confirming...');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog(`✓ Withdrew ${amount.toFixed(4)} XNT to Backpack wallet`, 'success');

        // Wait a moment for blockchain state to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        console.log('[executeWithdraw] About to refresh balances...');
        // Update all balances in the modal
        await updateDepositModalBalances();

        // Update main wallet balance display
        await updateWalletBalance();

        // Clear input
        amountInput.value = '';
        console.log('[executeWithdraw] Balance refresh complete');

    } catch (err) {
        console.error('Withdrawal failed:', err);
        addLog(`ERROR: ${err.message}`, 'error');
        showError('Withdrawal failed');
    }
}

async function topupSessionWallet() {
    if (!backpackWallet || !wallet) {
        addLog('ERROR: Wallet not connected', 'error');
        showError('Connect wallet first');
        return;
    }

    const topupAmount = 0.1 * 1e9; // 0.1 XNT in lamports

    addLog('Topping up session wallet with 0.1 XNT...', 'info');
    showStatus('Topping up...');

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const [userVaultPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('user_vault'), posPda.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const discriminator = await createDiscriminator('topup_session_wallet');

        // Create amount buffer (8 bytes, little endian, unsigned)
        const amountBuf = new Uint8Array(8);
        const view = new DataView(amountBuf.buffer);
        view.setBigUint64(0, BigInt(topupAmount), true);

        const data = concatUint8Arrays(discriminator, amountBuf);

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: userVaultPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
            { pubkey: backpackWallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new solanaWeb3.TransactionInstruction({
            programId: new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID),
            keys,
            data
        });

        const transaction = new solanaWeb3.Transaction().add(instruction);
        transaction.feePayer = backpackWallet.publicKey;

        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;

        // Sign and send with Backpack only
        const signed = await backpackWallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize());

        addLog(`TX: ${signature}`, 'tx');
        showStatus('Confirming...');

        await connection.confirmTransaction(signature, 'confirmed');

        addLog('✓ Session wallet topped up with 0.1 XNT', 'success');

        // Wait a moment for blockchain state to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // Update all balances in the modal
        await updateDepositModalBalances();

    } catch (err) {
        console.error('Top-up failed:', err);
        addLog(`ERROR: ${err.message}`, 'error');
        showError('Top-up failed');
    }
}

// ============================================================================
// Trade Confirmation Modal Functions
// ============================================================================

function openTradeConfirmModal(tradeData) {
    // Store trade data for later execution
    pendingTradeData = tradeData;

    // Update modal content
    const modal = document.getElementById('tradeConfirmModal');
    if (!modal) return;

    // Set action (BUY or SELL)
    const actionEl = document.getElementById('confirmAction');
    actionEl.textContent = tradeData.action.toUpperCase();
    actionEl.className = 'confirm-value confirm-action ' + tradeData.action.toLowerCase();

    // Set outcome (UP or DOWN - converting yes/no to UP/DOWN)
    const outcomeEl = document.getElementById('confirmOutcome');
    const outcomeText = tradeData.side === 'yes' ? 'UP' : 'DOWN';
    outcomeEl.textContent = outcomeText;
    outcomeEl.className = 'confirm-value confirm-outcome ' + tradeData.side.toLowerCase();

    // Set shares
    document.getElementById('confirmShares').textContent = tradeData.shares.toFixed(2);

    // Set price per share
    document.getElementById('confirmPrice').textContent = tradeData.pricePerShare.toFixed(4) + ' XNT';

    // Set total cost/proceeds
    const costLabel = tradeData.action === 'buy' ? 'Total Cost' : 'Expected Proceeds';
    // Update the label using ID (index.html structure)
    const costLabelEl = document.getElementById('confirmCostLabel');
    if (costLabelEl) {
        costLabelEl.textContent = costLabel;
    }
    document.getElementById('confirmCost').textContent = '~' + tradeData.totalCost.toFixed(4) + ' XNT';

    // Update modal title based on action
    const titleEl = document.getElementById('confirmModalTitle');
    titleEl.textContent = tradeData.action === 'buy' ? 'Confirm Purchase' : 'Confirm Sale';

    // Show modal
    modal.classList.remove('hidden');

    if (debugMode) {
        console.log('[Trade Confirmation] Modal opened:', tradeData);
    }
}

function closeTradeConfirmModal() {
    const modal = document.getElementById('tradeConfirmModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    pendingTradeData = null;

    if (debugMode) {
        console.log('[Trade Confirmation] Modal closed');
    }
}

async function confirmTradeExecution() {
    if (!pendingTradeData) {
        console.error('[Trade Confirmation] No pending trade data');
        return;
    }

    if (debugMode) {
        console.log('[Trade Confirmation] User confirmed trade, executing...', pendingTradeData);
    }

    // Save trade data before closing modal (closeTradeConfirmModal sets pendingTradeData to null)
    const tradeData = pendingTradeData;

    // Close modal immediately
    closeTradeConfirmModal();

    // Execute the trade with the stored data
    await executeTradeInternal(tradeData);
}

// Expose modal functions to window for index.html
if (typeof window !== 'undefined') {
    window.openTradeConfirmModal = openTradeConfirmModal;
    window.closeTradeConfirmModal = closeTradeConfirmModal;
    window.confirmTradeExecution = confirmTradeExecution;
}

// ============================================================================
// Toggle Functions
// ============================================================================

function toggleRapidFire() {
    const toggle = document.getElementById('rapidFireToggle');
    if (!toggle) return;

    rapidFireMode = toggle.checked;
    // Sync with window.rapidFireMode for index.html
    if (typeof window !== 'undefined') {
        window.rapidFireMode = rapidFireMode;
    }
    localStorage.setItem('rapidFireMode', rapidFireMode.toString());

    if (rapidFireMode) {
        addLog('⚡ Rapid Fire enabled - trades will execute without confirmation', 'info');
        showToast('info', '⚡ Rapid Fire Enabled', 'Trades will execute immediately without confirmation');
    } else {
        addLog('🛡️ Rapid Fire disabled - trades will require confirmation', 'info');
        showToast('info', '🛡️ Rapid Fire Disabled', 'You will be asked to confirm each trade');
    }

    console.log('[Rapid Fire] Mode:', rapidFireMode ? 'ON' : 'OFF');
}

function toggleDebug() {
    const toggle = document.getElementById('debugToggle');
    if (!toggle) return;

    debugMode = toggle.checked;
    localStorage.setItem('debugMode', debugMode.toString());

    if (debugMode) {
        addLog('🔧 Debug mode enabled - detailed logging active', 'info');
    } else {
        addLog('🔧 Debug mode disabled', 'info');
    }

    console.log('[Debug] Mode:', debugMode ? 'ON' : 'OFF');
}

// Initialize toggles from localStorage on page load
function initToggles() {
    // Initialize rapid fire toggle
    const rapidFireToggle = document.getElementById('rapidFireToggle');
    if (rapidFireToggle) {
        const savedRapidFire = localStorage.getItem('rapidFireMode');
        rapidFireMode = savedRapidFire === 'true';
        // Also sync with window.rapidFireMode for index.html
        if (typeof window !== 'undefined') {
            window.rapidFireMode = rapidFireMode;
        }
        rapidFireToggle.checked = rapidFireMode;
        console.log('[Rapid Fire] Initialized:', rapidFireMode ? 'ON' : 'OFF');
    }

    // Initialize debug toggle
    const debugToggle = document.getElementById('debugToggle');
    if (debugToggle) {
        const savedDebug = localStorage.getItem('debugMode');
        debugMode = savedDebug === 'true';
        debugToggle.checked = debugMode;
        console.log('[Debug] Initialized:', debugMode ? 'ON' : 'OFF');
    }
}

// Expose toggle functions to window for index.html
if (typeof window !== 'undefined') {
    window.toggleRapidFire = toggleRapidFire;
    window.toggleDebug = toggleDebug;
}

// ============================================================================
// Debug Toggle Handler
// ============================================================================

// Initialize debug mode from localStorage or default to true (checked)
function initDebugToggle() {
    const debugToggle = document.getElementById('debugToggle');
    if (!debugToggle) return;

    // Load saved preference or default to true
    const savedDebugMode = localStorage.getItem('debugMode');
    const isDebugMode = savedDebugMode === null ? true : savedDebugMode === 'true';

    debugToggle.checked = isDebugMode;
    document.body.classList.toggle('debug-mode', isDebugMode);

    // Handle toggle changes
    debugToggle.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        document.body.classList.toggle('debug-mode', enabled);
        localStorage.setItem('debugMode', enabled.toString());
        console.log(`[Debug] Slot display ${enabled ? 'enabled' : 'disabled'}`);
    });

    console.log(`[Debug] Toggle initialized, mode: ${isDebugMode ? 'ON' : 'OFF'}`);
}

// Initialize on page load
if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDebugToggle);
    } else {
        initDebugToggle();
    }
}

// ============= POINTS SYSTEM =============

// Fetch and display user points
async function fetchUserPoints() {
    if (!backpackWallet || !backpackWallet.publicKey) {
        return;
    }

    try {
        // Use session wallet for points lookup (points are tracked by session wallet prefix)
        const cached = getCachedSessionWallet();
        const sessionPubkey = cached ? cached.address : backpackWallet.publicKey.toString();
        const response = await fetch(`/api/points/user/${sessionPubkey}`);

        if (!response.ok) {
            console.error('[POINTS] Failed to fetch points:', response.status);
            return;
        }

        const data = await response.json();
        const points = data.total_points || 0;

        // Update display
        const pointsElement = document.getElementById('navUserPoints');
        if (pointsElement) {
            pointsElement.textContent = formatPointsNumber(points);
        }

        console.log(`[POINTS] User ${sessionPubkey.slice(0,6)} has ${points} points`);
    } catch (err) {
        console.error('[POINTS] Error fetching points:', err);
    }
}

// Format points number (1000 -> 1K, 1000000 -> 1M)
function formatPointsNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

// Start points polling when wallet connects
let pointsPollingInterval = null;

function startPointsPolling() {
    // Fetch immediately
    fetchUserPoints();

    // Then poll every 30 seconds
    if (pointsPollingInterval) {
        clearInterval(pointsPollingInterval);
    }
    pointsPollingInterval = setInterval(fetchUserPoints, 30000);
}

function stopPointsPolling() {
    if (pointsPollingInterval) {
        clearInterval(pointsPollingInterval);
        pointsPollingInterval = null;
    }
}
