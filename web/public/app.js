// Configuration
const CONFIG = {
    RPC_URL: 'https://rpc.testnet.x1.xyz',
    PROGRAM_ID: 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF',
    ORACLE_STATE: '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq',
    AMM_SEED: 'amm_btc_v3',
    LAMPORTS_PER_E6: 100,
    STATUS_URL: '/market_status.json'
};

// Global state
let wallet = null; // Session wallet (Keypair)
let backpackWallet = null; // Backpack wallet provider
let currentFeeBps = 25; // Default fee in basis points (0.25%)

// BTC Price Chart
let btcChart = null;
let priceHistory = []; // Stores actual BTC prices (one per second)
let currentTimeRange = 60; // Current time range in seconds (default 1 minute)
const PRICE_HISTORY_KEY = 'btc_price_history';
const PRICE_HISTORY_MAX_AGE_MS = 60000; // Keep data for 60 seconds

// High-resolution chart for smooth scrolling
const CHART_UPDATE_INTERVAL_MS = 55; // Update chart every 55ms (~18 points/sec, 10% reduction)
const BASE_POINTS_PER_SECOND = 1000 / CHART_UPDATE_INTERVAL_MS; // ~18.18 points per second
const MAX_CHART_POINTS = 2000; // Maximum points to display to prevent memory issues
let chartDataPoints = []; // High-resolution data for smooth scrolling
let chartUpdateTimer = null;
let currentSamplingRate = 1; // How many data points to skip (1 = no skip, 2 = every other, etc.)

// Calculate optimal sampling rate based on time range to stay under MAX_CHART_POINTS
function getOptimalSamplingRate(timeRangeSeconds) {
    if (!timeRangeSeconds) {
        // For 'ALL', estimate based on current data
        const estimatedSeconds = Math.max(300, chartDataPoints.length / BASE_POINTS_PER_SECOND);
        timeRangeSeconds = estimatedSeconds;
    }

    const totalPoints = timeRangeSeconds * BASE_POINTS_PER_SECOND;
    const samplingRate = Math.max(1, Math.ceil(totalPoints / MAX_CHART_POINTS));
    return samplingRate;
}

// Get effective points per second after sampling
function getEffectivePointsPerSecond(timeRangeSeconds) {
    const samplingRate = getOptimalSamplingRate(timeRangeSeconds);
    return BASE_POINTS_PER_SECOND / samplingRate;
}

// Price interpolation
let lastActualPrice = null;
let currentTargetPrice = null;

// Market start price (for arrow indicator)
let marketStartPrice = null;

let connection = null;
let ammPda = null;
let vaultPda = null;

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
        link.href = `https://explorer.testnet.x1.xyz/tx/${signature}`;
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

    const [vault] = await solanaWeb3.PublicKey.findProgramAddressSync(
        [stringToUint8Array('vault_sol'), ammPda.toBytes()],
        new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
    );
    vaultPda = vault;

    addLog('AMM PDA: ' + ammPda.toString(), 'info');
    addLog('Vault PDA: ' + vaultPda.toString(), 'info');

    // Try to restore session if Backpack is already connected
    await restoreSession();

    // Load price history from localStorage
    loadPriceHistory();

    // Initialize BTC chart
    initBTCChart();

    // Start polling
    startPolling();
    addLog('System ready. Auto-refresh every 1s', 'success');

    // Set up Backpack account change listener
    setupBackpackAccountListener();
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
        // Check if Backpack is available
        if (!window.backpack) {
            console.log('Backpack not detected');
            showNoWallet();
            clearWalletCache(); // Clear cache if Backpack not available
            return;
        }

        // Check for cached wallet preference
        const cachedAddress = getCachedWalletAddress();

        // If Backpack is already connected, restore immediately
        if (window.backpack.isConnected) {
            console.log('[Restore] Backpack already connected, restoring session...');
            addLog('Restoring session...', 'info');

            backpackWallet = window.backpack;
            const backpackAddress = backpackWallet.publicKey.toString();

            console.log('[Restore] Backpack address:', backpackAddress);

            // Verify cached address matches current Backpack wallet (if cached)
            if (cachedAddress && cachedAddress !== backpackAddress) {
                console.log('[Restore] Cached wallet mismatch, updating cache');
                clearWalletCache();
            }

            // Cache the connection
            cacheWalletConnection(backpackAddress);

            // Derive session wallet (will request signature)
            addLog('Deriving session wallet...', 'info');
            wallet = await deriveSessionWalletFromBackpack(backpackWallet);

            const sessionAddr = wallet.publicKey.toString();
            console.log('[Restore] Session wallet restored:', sessionAddr);

            addLog('Session restored: ' + sessionAddr.substring(0, 12) + '...', 'success');

            // Update UI
            showHasWallet(backpackAddress);
            updateWalletBalance();
            fetchPositionData();
            showStatus('Session restored: ' + sessionAddr);

            return;
        }

        // If we have a cached connection preference but not connected, try to reconnect
        if (cachedAddress) {
            console.log('[Restore] Found cached wallet, attempting auto-reconnect...');
            addLog('Auto-reconnecting to Backpack...', 'info');

            try {
                // Attempt silent reconnection
                const response = await window.backpack.connect();
                backpackWallet = window.backpack;
                const backpackAddress = backpackWallet.publicKey.toString();

                // Verify it matches the cached address
                if (backpackAddress !== cachedAddress) {
                    console.log('[Restore] Wallet address changed, clearing cache');
                    clearWalletCache();
                }

                // Update cache
                cacheWalletConnection(backpackAddress);

                // Derive session wallet
                addLog('Deriving session wallet...', 'info');
                wallet = await deriveSessionWalletFromBackpack(backpackWallet);

                const sessionAddr = wallet.publicKey.toString();
                console.log('[Restore] Session wallet auto-restored:', sessionAddr);

                addLog('Wallet auto-reconnected: ' + sessionAddr.substring(0, 12) + '...', 'success');

                // Update UI
                showHasWallet(backpackAddress);
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

// ============= BACKPACK ACCOUNT SWITCHING =============

function setupBackpackAccountListener() {
    if (!window.backpack) {
        console.log('Backpack not detected, account listener not set up');
        return;
    }

    // Listen for account changes in Backpack
    window.backpack.on('accountChanged', async (publicKey) => {
        console.log('[Account Switch] Backpack account changed to:', publicKey?.toString());

        if (!publicKey) {
            // User disconnected
            addLog('Backpack disconnected', 'warning');
            disconnectWallet();
            return;
        }

        // Check if we're already connected
        if (!backpackWallet) {
            console.log('[Account Switch] Not connected yet, ignoring account change');
            return;
        }

        const newBackpackAddress = publicKey.toString();
        addLog('Backpack wallet switched to: ' + newBackpackAddress.substring(0, 12) + '...', 'info');

        try {
            // Update backpack wallet reference
            backpackWallet = window.backpack;

            // Clear old session wallet cache before deriving new one
            clearSessionWalletCache();

            // Re-derive session wallet for the new Backpack wallet
            addLog('Re-deriving session wallet for new Backpack account...', 'info');
            console.log('[Account Switch] Deriving new session wallet...');

            wallet = await deriveSessionWalletFromBackpack(backpackWallet);

            const sessionAddr = wallet.publicKey.toString();
            console.log('[Account Switch] New session wallet:', sessionAddr);

            addLog('Switched to session wallet: ' + sessionAddr.substring(0, 12) + '...', 'success');
            addLog('This is the deterministic session wallet for your new Backpack account', 'info');

            // Update cache with new wallet address
            cacheWalletConnection(newBackpackAddress);

            // Update UI
            showHasWallet(newBackpackAddress);
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

    console.log('Backpack account change listener installed');
}

async function connectBackpack() {
    console.log('[connectBackpack] Button clicked!');
    try {
        console.log('[connectBackpack] Checking for window.backpack...');
        console.log('[connectBackpack] window.backpack exists?', !!window.backpack);

        if (!window.backpack) {
            console.error('[connectBackpack] Backpack wallet not found in window object');
            addLog('ERROR: Backpack wallet not found!', 'error');
            addLog('Please open this page in the Backpack mobile browser', 'info');
            showError('Backpack wallet not found! Please open in Backpack browser');
            return;
        }

        console.log('[connectBackpack] Backpack detected, attempting to connect...');
        addLog('Connecting to Backpack wallet...', 'info');
        showStatus('Connecting to Backpack...');

        // Connect Backpack
        const response = await window.backpack.connect();
        backpackWallet = window.backpack;
        const backpackAddress = backpackWallet.publicKey.toString();

        addLog('Backpack connected: ' + backpackAddress.substring(0, 12) + '...', 'success');

        // Derive deterministic session wallet from Backpack signature
        // Same Backpack = Same signature = Same session wallet, ALWAYS!
        // No localStorage needed - completely reproducible from signature alone
        console.log('[DEBUG] About to derive session wallet...');
        wallet = await deriveSessionWalletFromBackpack(backpackWallet);
        console.log('[DEBUG] Wallet object:', wallet);
        console.log('[DEBUG] Wallet is null?', wallet === null);
        console.log('[DEBUG] Wallet publicKey:', wallet ? wallet.publicKey : 'NULL WALLET');

        const sessionAddr = wallet.publicKey.toString();
        console.log('[DEBUG] Session address:', sessionAddr);

        addLog('Session wallet: ' + sessionAddr.substring(0, 12) + '...', 'success');
        addLog('This wallet is deterministically derived from your Backpack signature', 'info');
        addLog('Same Backpack = Same session wallet, on any device!', 'info');

        // Cache the wallet connection for auto-reconnect on page navigation
        cacheWalletConnection(backpackAddress);

        console.log('[DEBUG] About to call showHasWallet...');
        showHasWallet(backpackAddress);
        console.log('[DEBUG] showHasWallet completed');

        updateWalletBalance();
        fetchPositionData();
        showStatus('Connected! Session wallet: ' + sessionAddr);

    } catch (err) {
        addLog('Connection failed: ' + err.message, 'error');
        showError('Failed to connect Backpack: ' + err.message);
        console.error(err);
        clearWalletCache(); // Clear cache on connection failure
    }
}

function disconnectWallet() {
    addLog('Disconnecting wallet...', 'info');

    // Clear wallet references and cache
    wallet = null;
    backpackWallet = null;

    // Clear wallet cache to prevent auto-reconnect
    clearWalletCache();

    // Clear session wallet cache
    clearSessionWalletCache();

    // Disconnect Backpack if connected
    if (window.backpack && window.backpack.disconnect) {
        window.backpack.disconnect();
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
            // Backpack returns {signature: Uint8Array, publicKey: PublicKey}
            signatureBytes = signature.signature;
        } else if (ArrayBuffer.isView(signature)) {
            signatureBytes = new Uint8Array(signature.buffer);
        } else {
            console.error('[DEBUG derive] Unexpected signature format:', signature);
            throw new Error('Unexpected signature format from Backpack');
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
        addLog('Same Backpack = Same session wallet, always!', 'info');

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

    console.log('[DEBUG showHasWallet] Function completed');
}

async function updateWalletBalance() {
    if (!wallet) {
        console.log('No wallet to update balance');
        return;
    }

    try {
        const balance = await connection.getBalance(wallet.publicKey);
        const solBalance = (balance / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
        const solBalanceShort = (balance / solanaWeb3.LAMPORTS_PER_SOL).toFixed(2);
        const balanceNum = balance / solanaWeb3.LAMPORTS_PER_SOL;

        // Update nav bar
        if (document.getElementById('navWalletBal')) {
            document.getElementById('navWalletBal').textContent = solBalanceShort;
        }

        // Update sidebar
        if (document.getElementById('walletBal')) {
            document.getElementById('walletBal').textContent = solBalance;
        }

        // Security warning for high balances
        const WARNING_THRESHOLD = 100; // 100 XNT
        const lastWarningKey = 'btc_market_balance_warning_shown';
        const lastWarningTime = localStorage.getItem(lastWarningKey);
        const now = Date.now();

        // Show warning if balance > threshold and no warning shown in last 24h
        if (balanceNum > WARNING_THRESHOLD) {
            if (!lastWarningTime || (now - parseInt(lastWarningTime)) > 24 * 60 * 60 * 1000) {
                showBalanceWarning(balanceNum);
                localStorage.setItem(lastWarningKey, now.toString());
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
• Withdraw excess to your Backpack wallet
• Session wallets are less secure than hardware wallets

This is a temporary wallet for trading only.
    `.trim();

    console.warn(warning);
    addLog(`⚠️ High balance warning: ${balance.toFixed(2)} XNT in session wallet`, 'warning');
}

// ============= BTC PRICE CHART =============

// Save price to server (no longer using localStorage)
async function savePriceToServer(price) {
    try {
        const response = await fetch('/api/price-history', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ price })
        });

        if (!response.ok) {
            console.warn('Failed to save price to server:', response.status);
        }
    } catch (err) {
        console.warn('Failed to save price to server:', err);
    }
}

// Load price history from server
async function loadPriceHistory(seconds = null) {
    try {
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
            priceHistory = data.prices.map(item => {
                return typeof item === 'number' ? item : item.price;
            });

            console.log('Loaded', priceHistory.length, 'price points from server (total available:', data.totalPoints || priceHistory.length, ')');

            // Update chart if already initialized
            if (btcChart && priceHistory.length > 0) {
                // Rebuild high-resolution chart data from price history
                rebuildChartFromHistory();
            }
        }
    } catch (err) {
        console.warn('Failed to load price history from server:', err);
    }
}

// Available time ranges (in order for cycling)
const TIME_RANGES = [60, 300, 900, 1800, 3600];
let currentTimeRangeIndex = 0;

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
    // Update active option in dropdown
    document.querySelectorAll('.timerange-option').forEach(opt => {
        opt.classList.remove('active');
    });
    const activeOpt = document.querySelector(`.timerange-option[data-seconds="${seconds}"]`);
    if (activeOpt) {
        activeOpt.classList.add('active');
    }

    // Update displayed value in trigger
    const selectedDisplay = document.getElementById('selectedTimeRange');
    if (selectedDisplay) {
        selectedDisplay.textContent = activeOpt ? activeOpt.textContent : seconds;
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

    // Recalculate sampling rate and restart chart update loop
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);
    console.log(`Time range changed to ${seconds}s - Sampling rate: ${currentSamplingRate} (${effectivePointsPerSecond.toFixed(2)} points/sec)`);

    // Restart chart update loop to reset counter
    if (chartUpdateTimer) {
        startChartUpdateLoop();
    }
}

// Cycle to next time range (for chart click)
async function cycleTimeRange() {
    currentTimeRangeIndex = (currentTimeRangeIndex + 1) % TIME_RANGES.length;
    const nextRange = TIME_RANGES[currentTimeRangeIndex];
    await selectTimeRange(nextRange);
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
        } else {
            // For > 1 hour, show HH:MM
            labels.push(`${hours}:${minutes}`);
        }
    }

    return labels;
}

// Rebuild high-resolution chart data from price history
function rebuildChartFromHistory() {
    if (priceHistory.length === 0) return;

    // Calculate optimal sampling rate for current time range
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);

    console.log(`Rebuilding chart with sampling rate: ${currentSamplingRate} (${effectivePointsPerSecond.toFixed(2)} points/sec)`);

    chartDataPoints = [];
    let sampleCounter = 0;

    // Interpolate between historical prices to create smooth chart
    for (let i = 0; i < priceHistory.length; i++) {
        const currentPrice = priceHistory[i];
        const nextPrice = i < priceHistory.length - 1 ? priceHistory[i + 1] : currentPrice;

        // Add interpolated points for this second (with sampling)
        for (let j = 0; j < BASE_POINTS_PER_SECOND; j++) {
            // Only add point if it passes sampling filter
            if (sampleCounter % currentSamplingRate === 0) {
                const t = j / BASE_POINTS_PER_SECOND;
                const interpolatedPrice = currentPrice + (nextPrice - currentPrice) * t;
                chartDataPoints.push(interpolatedPrice);
            }
            sampleCounter++;
        }
    }

    // Calculate max points based on current time range with effective rate
    const maxPoints = currentTimeRange
        ? Math.floor(currentTimeRange * effectivePointsPerSecond)
        : Math.min(chartDataPoints.length, MAX_CHART_POINTS);

    // Keep only last maxPoints
    if (chartDataPoints.length > maxPoints) {
        chartDataPoints = chartDataPoints.slice(-maxPoints);
    }

    // Update chart
    if (btcChart) {
        // Resize chart data arrays to match new time range
        const timeRange = currentTimeRange || (chartDataPoints.length / effectivePointsPerSecond);
        btcChart.data.labels = generateTimeLabels(maxPoints, timeRange);
        const chartData = [...Array(maxPoints - chartDataPoints.length).fill(null), ...chartDataPoints];
        btcChart.data.datasets[0].data = chartData;
        btcChart.update('none');
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

    // Calculate optimal sampling for initial chart setup
    currentSamplingRate = getOptimalSamplingRate(currentTimeRange);
    const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);

    // Initialize with empty data (using effective sampling rate)
    const initialPoints = currentTimeRange ? Math.floor(currentTimeRange * effectivePointsPerSecond) : Math.floor(60 * effectivePointsPerSecond);
    const initialTimeRange = currentTimeRange || 60;
    const labels = generateTimeLabels(initialPoints, initialTimeRange);
    const data = Array(initialPoints).fill(null);

    console.log(`Chart initialized: ${initialPoints} points, ${effectivePointsPerSecond.toFixed(2)} points/sec, sampling rate: ${currentSamplingRate}`);

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
                pointHoverBorderWidth: 0
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
        }
    });

    console.log('BTC Chart initialized successfully!');

    // Add click handler to chart canvas for cycling time ranges
    const canvas = document.getElementById('btcChart');
    if (canvas) {
        canvas.addEventListener('click', async () => {
            await cycleTimeRange();
        });
    }

    // Start the smooth scrolling update loop
    startChartUpdateLoop();
}

// Continuous chart update loop for butter-smooth scrolling
function startChartUpdateLoop() {
    if (chartUpdateTimer) {
        clearInterval(chartUpdateTimer);
    }

    let updateCounter = 0; // Counter for sampling

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

        // Only add point if it passes sampling filter
        if (updateCounter % currentSamplingRate === 0) {
            chartDataPoints.push(displayPrice);

            // Calculate effective points per second and max points
            const effectivePointsPerSecond = getEffectivePointsPerSecond(currentTimeRange);
            const maxPoints = currentTimeRange
                ? Math.floor(currentTimeRange * effectivePointsPerSecond)
                : Math.min(chartDataPoints.length, MAX_CHART_POINTS);

            // Keep only the last maxPoints
            if (chartDataPoints.length > maxPoints) {
                chartDataPoints.shift(); // Remove oldest point - this creates the scrolling effect!
            }

            // Pad with nulls if we don't have enough data yet
            const chartData = [...Array(maxPoints - chartDataPoints.length).fill(null), ...chartDataPoints];

            // Update time labels (regenerate every second to keep them fresh)
            const now = Date.now();
            if (!this.lastLabelUpdate || now - this.lastLabelUpdate > 1000) {
                const timeRange = currentTimeRange || (chartDataPoints.length / effectivePointsPerSecond);
                btcChart.data.labels = generateTimeLabels(maxPoints, timeRange);
                this.lastLabelUpdate = now;
            }

            // Update chart
            btcChart.data.datasets[0].data = chartData;
            btcChart.update('none'); // No animation - we handle smoothness manually
        }

        updateCounter++;

        // Always update price display (even if we skip chart update)
        updatePriceDisplay(displayPrice);
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
    if (!btcChart) {
        console.log('BTC Chart not initialized yet');
        return;
    }

    // Validate price
    if (!price || isNaN(price) || price <= 0) {
        console.warn('Invalid price for chart:', price);
        return;
    }

    console.log('New BTC price: $' + price.toFixed(2));

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
}

// ============= ORACLE DATA =============

async function fetchOracleData() {
    try {
        const oracleKey = new solanaWeb3.PublicKey(CONFIG.ORACLE_STATE);
        const accountInfo = await connection.getAccountInfo(oracleKey);

        if (!accountInfo) {
            console.error('Oracle account not found');
            return;
        }

        const d = accountInfo.data;
        if (d.length < 8 + 32 + 48*3 + 2) {
            console.error('Oracle data invalid');
            return;
        }

        let o = 8; // Skip discriminator
        o += 32; // Skip update_authority

        // Read triplet
        const readI64 = () => {
            const v = d.readBigInt64LE(o);
            o += 8;
            return v;
        };

        const p1 = readI64();
        const p2 = readI64();
        const p3 = readI64();
        const t1 = readI64();
        const t2 = readI64();
        const t3 = readI64();

        o += 96; // Skip ETH + SOL
        const decimals = d.readUInt8(o);

        // Calculate median
        const median3 = (a, b, c) => {
            const arr = [a, b, c].sort((x, y) => (x < y ? -1 : (x > y ? 1 : 0)));
            return arr[1];
        };

        const priceRaw = median3(p1, p2, p3);
        const scale = 10n ** BigInt(decimals);
        const price_e6 = (priceRaw * 1_000_000n) / scale;

        const maxTs = [t1, t2, t3].reduce((a, b) => a > b ? a : b);
        const age = Math.floor(Date.now() / 1000) - Number(maxTs);

        // Display current BTC price
        const btcPrice = Number(price_e6) / 1_000_000; // Numeric value for chart
        const priceFormatted = '$' + btcPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

        if (document.getElementById('oracleCurrentPrice')) {
            document.getElementById('oracleCurrentPrice').textContent = priceFormatted;
        }
        if (document.getElementById('tickerPrice')) {
            document.getElementById('tickerPrice').textContent = priceFormatted;
        }

        // Update BTC chart with numeric price
        updateBTCChart(btcPrice);

        // Update winning indicator
        // TODO: updateWinningIndicator(btcPrice); // Function not implemented yet

        // Display age
        const ageText = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
        if (document.getElementById('oracleAge')) {
            document.getElementById('oracleAge').textContent = ageText;
            document.getElementById('oracleAge').style.color = age > 90 ? '#ff4757' : (age > 30 ? '#ffa502' : '#778ca3');
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

async function fetchMarketData() {
    try {
        const accountInfo = await connection.getAccountInfo(ammPda);

        if (!accountInfo) {
            console.error('No market found');
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

        // Store start price for arrow indicator
        marketStartPrice = startPriceE6 > 0 ? startPriceE6 / 1_000_000 : null;

        // Update "Price to Beat" display
        const beatPriceEl = document.getElementById('chartBeatPrice');
        if (beatPriceEl) {
            if (marketStartPrice && marketStartPrice > 0) {
                const formattedPrice = marketStartPrice.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                beatPriceEl.textContent = `$${formattedPrice}`;
            } else {
                beatPriceEl.textContent = '--';
            }
        }

        // Store LMSR parameters globally
        currentB = bScaled;
        currentQYes = qY;
        currentQNo = qN;

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

        // Update outcome button prices
        if (document.getElementById('yesBtnPrice')) {
            document.getElementById('yesBtnPrice').textContent = yesProb.toFixed(2);
        }
        if (document.getElementById('noBtnPrice')) {
            document.getElementById('noBtnPrice').textContent = noProb.toFixed(2);
        }

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
    // Update new position status display
    if (document.getElementById('posYesDisplay')) {
        document.getElementById('posYesDisplay').textContent = sharesYes.toFixed(2);
    }
    if (document.getElementById('posNoDisplay')) {
        document.getElementById('posNoDisplay').textContent = sharesNo.toFixed(2);
    }

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

    // Create breakdown text
    const yesPayoutStr = (currentMarketStatus === 2 && currentWinningSide === 'yes') ? payoutPerWinningShare.toFixed(4) : '0.00';
    const noPayoutStr = (currentMarketStatus === 2 && currentWinningSide === 'no') ? payoutPerWinningShare.toFixed(4) : '0.00';
    const yesLine = `UP: ${sharesYes.toFixed(2)} × ${yesPayoutStr} = ${yesValue.toFixed(2)}`;
    const noLine = `DOWN: ${sharesNo.toFixed(2)} × ${noPayoutStr} = ${noValue.toFixed(2)}`;

    // Update sidebar breakdown
    if (document.getElementById('redeemableBreakdownSidebar')) {
        document.getElementById('redeemableBreakdownSidebar').innerHTML = `${yesLine}<br>${noLine}`;
    }
    // Update main breakdown (for proto1)
    if (document.getElementById('redeemableBreakdown')) {
        document.getElementById('redeemableBreakdown').innerHTML = `${yesLine}<br>${noLine}`;
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

    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => {
            container.removeChild(toast);
        }, 300);
    }, 4000);
}

async function executeTrade() {
    // Check if market is open
    if (currentMarketStatus !== 0) {
        addLog('ERROR: Market is not open for trading', 'error');
        showError('Market closed');
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
        // Use LMSR formula to calculate exact cost for numShares
        const netCost = calculateLMSRCost(side, numShares);

        // Check if calculation returned a valid number
        if (!isFinite(netCost) || netCost <= 0) {
            addLog(`ERROR: Invalid cost calculation: ${netCost}`, 'error');
            showError('Cannot calculate trade cost - market parameters may be invalid');
            return;
        }

        // Account for fees: grossAmount = netAmount / (1 - fee)
        const feeMultiplier = 1 - (currentFeeBps / 10000);
        estimatedCost = netCost / feeMultiplier; // Gross amount including fees
        // Convert to e6 units: 1 XNT = 10_000_000 e6 (due to LAMPORTS_PER_E6 = 100)
        amount_e6 = Math.floor(estimatedCost * 10_000_000);

        // Validate against contract limits (from CLAUDE.md)
        const MAX_SPEND_E6 = 50_000_000_000; // $50k max
        const MIN_BUY_E6 = 100_000; // $0.10 min

        if (amount_e6 > MAX_SPEND_E6) {
            addLog(`ERROR: Trade amount ${amount_e6} exceeds max ${MAX_SPEND_E6}`, 'error');
            showError(`Trade too large (max $50k)`);
            return;
        }
        if (amount_e6 < MIN_BUY_E6) {
            addLog(`ERROR: Trade amount ${amount_e6} below min ${MIN_BUY_E6}`, 'error');
            showError(`Trade too small (min $0.10)`);
            return;
        }

        addLog(`Calculated: ${numShares} shares → ${estimatedCost.toFixed(4)} XNT (${amount_e6} e6)`, 'info');
    } else {
        // For selling, pass number of shares
        // 1 share = 10_000_000 e6 units (LAMPORTS scale matching contract)
        amount_e6 = Math.floor(numShares * 10_000_000);
        estimatedCost = numShares * sharePrice;
    }

    const tradeDesc = `${action.toUpperCase()} ${numShares} ${side.toUpperCase()} shares (~${estimatedCost.toFixed(2)} XNT)`;
    addLog(`Executing trade: ${tradeDesc}`, 'info');
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

        const data = concatUint8Arrays(
            discriminator,
            new Uint8Array([sideNum]),
            new Uint8Array([actionNum]),
            amountBuf
        );

        const feeDest = await getFeeDest();

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
            data
        });

        const budgetIxs = createComputeBudgetInstructions();
        const transaction = new solanaWeb3.Transaction().add(...budgetIxs, instruction);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.sign(wallet);

        addLog('Submitting transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3
        });
        addLog('TX: ' + signature, 'tx');

        addLog('Confirming transaction...', 'info');

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
            addLog(`Trade SUCCESS: ${tradeDesc}`, 'success');
            showStatus('Trade success: ' + signature.substring(0, 16) + '...');

            // Show toast notification
            const actionText = action.toUpperCase();
            const sideText = side === 'yes' ? 'UP' : 'DOWN';
            const toastTitle = `${actionText} ${sideText} Success`;
            const toastMessage = `${numShares.toFixed(2)} shares @ $${sharePrice.toFixed(4)}`;
            showToast('success', toastTitle, toastMessage);
        }

        // Update last trade info
        updateLastTradeInfo(action, side, numShares, estimatedCost);

        // Fetch actual shares received after a short delay
        setTimeout(async () => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();

            // After another short delay, show actual shares received
            setTimeout(async () => {
                const positionAfter = await getPositionShares();
                if (positionBefore && positionAfter) {
                    const yesChange = positionAfter.yes - positionBefore.yes;
                    const noChange = positionAfter.no - positionBefore.no;
                    const actualShares = side === 'yes' ? yesChange : noChange;
                    if (action === 'buy' && Math.abs(actualShares) > 0.01) {
                        const percentDiff = ((actualShares - numShares) / numShares * 100).toFixed(1);
                        if (Math.abs(actualShares - numShares) > 0.5) {
                            addLog(`Actual shares received: ${actualShares.toFixed(2)} (${percentDiff}% ${percentDiff > 0 ? 'more' : 'less'} due to LMSR slippage)`, 'info');
                        } else {
                            addLog(`Actual shares received: ${actualShares.toFixed(2)}`, 'info');
                        }
                    }
                }
            }, 500);
        }, 1000);

    } catch (err) {
        // Better error messages
        let errorMsg = err.message;
        if (errorMsg.includes('TransactionExpiredTimeoutError') || errorMsg.includes('was not confirmed')) {
            errorMsg = 'Transaction confirmation timed out. Check Explorer to verify if transaction succeeded.';
            addLog('ERROR: ' + errorMsg, 'error');
        } else {
            addLog('Trade FAILED: ' + errorMsg, 'error');
        }

        showError('Trade error - check logs');

        // Show error toast
        const actionText = currentAction ? currentAction.toUpperCase() : 'TRADE';
        const sideText = currentSide === 'yes' ? 'UP' : 'DOWN';
        const shortError = errorMsg.length > 60 ? errorMsg.substring(0, 60) + '...' : errorMsg;
        showToast('error', `${actionText} ${sideText} Issue`, shortError);

        console.error('ERROR: Trade failed:', err);
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
        addLog('Redeem SUCCESS! Position wiped.', 'success');
        showStatus('Redeem success');

        setTimeout(() => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();
        }, 1000);

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

    // Check balance (need to leave enough for rent + transaction fees)
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        const minFeeBuffer = 0.001 * solanaWeb3.LAMPORTS_PER_SOL; // 0.001 SOL for fee

        if (lamports + minFeeBuffer >= balance) {
            addLog('ERROR: Insufficient balance for withdrawal', 'error');
            showError('Insufficient balance (need to keep ~0.001 XNT for fees)');
            return;
        }

        addLog(`Withdrawing ${amount.toFixed(4)} XNT to Backpack...`, 'info');
        showStatus('Withdrawing ' + amount.toFixed(4) + ' XNT to Backpack...');

        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: backpackWallet.publicKey,
                lamports: lamports
            })
        );

        transaction.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.sign(wallet);

        addLog('Submitting withdrawal transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        addLog('Confirming transaction...', 'info');
        await connection.confirmTransaction(signature, 'confirmed');

        addLog(`Withdrawal SUCCESS: ${amount.toFixed(4)} XNT transferred`, 'success');
        showStatus('Withdrawal success! Tx: ' + signature.substring(0, 16) + '...');

        // Clear input and update balance
        document.getElementById('withdrawAmount').value = '';
        setTimeout(() => {
            updateWalletBalance();
        }, 1000);

    } catch (err) {
        addLog('Withdrawal FAILED: ' + err.message, 'error');
        showError('Withdrawal failed: ' + err.message);
        console.error(err);
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
    if (!wallet) {
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

        const discriminator = await createDiscriminator('init_position');

        const keys = [
            { pubkey: ammPda, isSigner: false, isWritable: false },
            { pubkey: posPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
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

        addLog('Submitting init position transaction...', 'tx');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        await connection.confirmTransaction(signature, 'confirmed');
        addLog('Position initialized successfully!', 'success');
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
            addLog(`WARNING: Low balance! You need at least 0.1 XNT. Please fund from Backpack wallet.`, 'warning');
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
        const response = await fetch(CONFIG.ORACLE_URL + '?t=' + Date.now());
        if (!response.ok) return;

        const oracle = await response.json();
        const settlePriceE6 = oracle.price_e6;

        const startPrice = startPriceE6 / 1_000_000;
        const settlePrice = settlePriceE6 / 1_000_000;

        const startPriceStr = startPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const settlePriceStr = settlePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const winnerText = winner === 1 ? 'UP' : 'DOWN';
        const direction = settlePrice > startPrice ? 'UP' : settlePrice < startPrice ? 'DOWN' : 'SIDEWAYS';
        const arrow = settlePrice > startPrice ? '↗' : settlePrice < startPrice ? '↘' : '→';

        // Update banner content
        outcomeEl.textContent = `${winnerText} WON!`;
        reasonEl.textContent = `BTC went ${direction}: $${startPriceStr} ${arrow} $${settlePriceStr}`;

        // Add appropriate class
        if (winner === 2) {
            bannerEl.classList.add('no-winner');
        } else {
            bannerEl.classList.remove('no-winner');
        }

        bannerEl.style.display = 'block';
    } catch (err) {
        console.error('Failed to display winner banner:', err);
    }
}

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

function updateWinnerBanner(status) {
    const bannerEl = document.getElementById('winnerBanner');
    const outcomeEl = document.getElementById('winnerOutcome');
    const reasonEl = document.getElementById('winnerReason');

    if (!bannerEl || !outcomeEl || !reasonEl) return;

    // Show banner if we have lastResolution data and we're in WAITING or PREMARKET state
    if ((status.state === 'WAITING' || status.state === 'PREMARKET') && status.lastResolution) {
        const res = status.lastResolution;
        const startPrice = res.startPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const settlePrice = res.settlePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Determine if price went up or down
        const direction = res.settlePrice > res.startPrice ? 'UP' : res.settlePrice < res.startPrice ? 'DOWN' : 'SIDEWAYS';
        const arrow = res.settlePrice > res.startPrice ? '↑' : res.settlePrice < res.startPrice ? '↓' : '→';

        // Calculate correct winner based on price movement
        // UP or SAME → UP wins, DOWN → DOWN wins
        const displayWinner = res.settlePrice >= res.startPrice ? 'UP' : 'DOWN';

        // Update banner content with prices
        outcomeEl.textContent = `${displayWinner} WON`;
        reasonEl.textContent = `$${startPrice} ${arrow} $${settlePrice}`;

        // Add appropriate class
        if (displayWinner === 'DOWN') {
            bannerEl.classList.add('no-winner');
        } else {
            bannerEl.classList.remove('no-winner');
        }

        bannerEl.style.display = 'block';
    } else {
        bannerEl.style.display = 'none';
    }
}

function updateCycleDisplay(status) {
    const stateEl = document.getElementById('cycleState');
    const currentTimeEl = document.getElementById('currentTime');
    const nextMarketTimeEl = document.getElementById('nextMarketTime');

    if (!stateEl || !currentTimeEl || !nextMarketTimeEl) return;

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

    // Update winner banner
    updateWinnerBanner(status);

    if (status.state === 'PREMARKET') {
        stateEl.textContent = 'PRE-MARKET';
        stateEl.classList.add('premarket');

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
                hour12: false
            });
            nextMarketTimeEl.textContent = `Snapshot: ${snapshotTimeStr}`;
        } else {
            nextMarketTimeEl.textContent = 'Pre-market betting';
        }
    } else if (status.state === 'ACTIVE') {
        stateEl.textContent = 'MARKET ACTIVE';
        stateEl.classList.add('active');

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

        // Show when market ends
        if (status.marketEndTime) {
            const endTime = new Date(status.marketEndTime);
            const endTimeStr = endTime.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            nextMarketTimeEl.textContent = `Closes: ${endTimeStr}`;
        } else {
            nextMarketTimeEl.textContent = 'Market open';
        }
    } else if (status.state === 'SETTLED') {
        stateEl.textContent = 'SETTLED';
        stateEl.classList.add('settled');

        // Hide the snapshot section
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'none';
        }

        // Show when next market starts
        if (status.nextCycleStartTime) {
            const nextStartTime = new Date(status.nextCycleStartTime);
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
        stateEl.textContent = 'PRE-MARKET';
        stateEl.classList.add('premarket');  // Use premarket styling (orange)

        // Hide the snapshot section - previous market is over, new one hasn't started
        const snapshotSection = document.querySelector('.snapshot-section');
        if (snapshotSection) {
            snapshotSection.style.display = 'none';
        }

        // Show when next snapshot will be taken
        if (status.nextCycleStartTime) {
            const nextStartTime = new Date(status.nextCycleStartTime);
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
        stateEl.textContent = 'ERROR';
        stateEl.classList.add('error');
        nextMarketTimeEl.textContent = 'Check bot';
    } else {
        // OFFLINE or unknown
        stateEl.textContent = 'OFFLINE';
        stateEl.classList.add('waiting');
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
}

function formatCountdown(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ============= POLLING =============

function startPolling() {
    fetchOracleData();
    fetchMarketData();
    fetchCycleStatus();

    setInterval(() => {
        fetchOracleData();
        fetchMarketData();
        fetchCycleStatus();
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
    updateTradeButton();
}

function setShares(shares) {
    document.getElementById('tradeAmountShares').value = shares;
    updateTradeButton();
}

function updateTradeButton() {
    const shares = parseFloat(document.getElementById('tradeAmountShares').value) || 0;

    let cost;
    if (currentAction === 'buy') {
        // Use LMSR formula for accurate cost calculation
        const netCost = calculateLMSRCost(currentSide, shares);
        // Account for fees
        const feeMultiplier = 1 - (currentFeeBps / 10000);
        cost = netCost / feeMultiplier;
    } else {
        // Sell: use current price
        const sharePrice = currentSide === 'yes' ? currentYesPrice : currentNoPrice;
        cost = shares * sharePrice;
    }

    const action = currentAction === 'buy' ? 'Buy' : 'Sell';
    const sideDisplay = currentSide === 'yes' ? 'UP' : 'DOWN';
    const text = `${action} ${shares} ${sideDisplay} shares (~${cost.toFixed(2)} XNT)`;
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

// ============= INITIALIZATION =============

window.addEventListener('DOMContentLoaded', () => {
    // Add input listener for trade amount
    const tradeAmountInput = document.getElementById('tradeAmountShares');
    if (tradeAmountInput) {
        tradeAmountInput.addEventListener('input', updateTradeButton);
    }
});

// Update button states based on market status
function updateButtonStates() {
    const tradeBtn = document.getElementById('tradeBtn');
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');
    
    // Trade buttons - enable only when market is OPEN (status = 0)
    const canTrade = currentMarketStatus === 0;
    
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
