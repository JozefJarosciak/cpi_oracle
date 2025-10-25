// Configuration
const CONFIG = {
    RPC_URL: 'https://rpc.testnet.x1.xyz',
    PROGRAM_ID: 'EeQNdiGDUVj4jzPMBkx59J45p1y93JpKByTWifWtuxjF',
    ORACLE_STATE: '4KYeNyv1B9YjjQkfJk2C6Uqo71vKzFZriRe5NXg6GyCq',
    AMM_SEED: 'amm_btc_v3',
    LAMPORTS_PER_E6: 100
};

// Global state
let wallet = null; // Session wallet (Keypair)
let backpackWallet = null; // Backpack wallet provider
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
    logContent.appendChild(entry);

    // Auto-scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;

    // Keep only last 100 entries
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.firstChild);
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

    // Try to restore session
    await restoreSession();

    // Start polling
    startPolling();
    addLog('System ready. Auto-refresh every 5s', 'success');
});

// ============= SESSION MANAGEMENT =============

async function restoreSession() {
    try {
        const sessionData = localStorage.getItem('btc_market_session');
        if (!sessionData) {
            showNoWallet();
            return;
        }

        const { backpackAddress, sessionKeypair } = JSON.parse(sessionData);

        // Try to auto-connect Backpack if available
        if (window.backpack) {
            try {
                // Check if already connected
                if (!window.backpack.isConnected) {
                    // Auto-connect silently
                    await window.backpack.connect();
                }

                const currentAddress = window.backpack.publicKey.toString();

                if (currentAddress === backpackAddress) {
                    backpackWallet = window.backpack;
                    // Restore session wallet from stored keypair
                    const secretKey = Uint8Array.from(sessionKeypair);
                    wallet = solanaWeb3.Keypair.fromSecretKey(secretKey);
                    showHasWallet(backpackAddress);
                    updateWalletBalance();
                    fetchPositionData();
                    addLog('Session restored: ' + backpackAddress.substring(0, 12) + '...', 'success');
                    addLog('Trading wallet: ' + wallet.publicKey.toString().substring(0, 12) + '...', 'info');
                    return;
                } else {
                    // Different Backpack wallet connected
                    addLog('Different Backpack detected. Previous session for: ' + backpackAddress.substring(0, 12) + '...', 'warning');
                    showNoWallet();
                }
            } catch (err) {
                console.error('Auto-connect failed:', err);
                // Keep the session data, just show no wallet for now
                showNoWallet();
            }
        } else {
            // Backpack not available, but keep session data
            addLog('Backpack wallet not detected. Session saved for: ' + backpackAddress.substring(0, 12) + '...', 'info');
            showNoWallet();
        }

    } catch (err) {
        console.error('Failed to restore session:', err);
        addLog('Session restore failed: ' + err.message, 'error');
        showNoWallet();
    }
}

async function connectBackpack() {
    try {
        if (!window.backpack) {
            addLog('ERROR: Backpack wallet not found!', 'error');
            showError('Backpack wallet not found! Install from backpack.app');
            window.open('https://backpack.app/', '_blank');
            return;
        }

        addLog('Connecting to Backpack wallet...', 'info');
        showStatus('Connecting to Backpack...');

        // Connect Backpack
        const response = await window.backpack.connect();
        backpackWallet = window.backpack;
        const backpackAddress = backpackWallet.publicKey.toString();

        addLog('Backpack connected: ' + backpackAddress.substring(0, 12) + '...', 'success');

        // ALWAYS check localStorage first for existing session wallet for THIS Backpack address
        const existingSession = localStorage.getItem('btc_market_session');
        if (existingSession) {
            try {
                const { backpackAddress: savedAddress, sessionKeypair } = JSON.parse(existingSession);
                if (savedAddress === backpackAddress) {
                    // ALWAYS use the saved session wallet for this Backpack
                    const secretKey = Uint8Array.from(sessionKeypair);
                    wallet = solanaWeb3.Keypair.fromSecretKey(secretKey);
                    showHasWallet(backpackAddress);
                    updateWalletBalance();
                    fetchPositionData();
                    addLog('Session wallet restored: ' + wallet.publicKey.toString().substring(0, 12) + '...', 'success');
                    addLog('This session wallet is permanently linked to your Backpack', 'info');
                    showStatus('Session restored! Session wallet: ' + wallet.publicKey.toString());
                    return;
                } else {
                    // Different Backpack - this is a new user/wallet
                    addLog('New Backpack detected. Creating new session wallet...', 'info');
                }
            } catch (err) {
                console.error('Failed to restore existing session:', err);
                addLog('Failed to restore session: ' + err.message, 'warning');
                // Continue to create new session
            }
        }

        addLog('Generating new session wallet for Backpack: ' + backpackAddress.substring(0, 12) + '...', 'info');
        showStatus('Creating new session wallet...');

        // Generate a NEW session keypair - this will be permanent for this Backpack
        wallet = solanaWeb3.Keypair.generate();

        // Save session to localStorage - PERMANENT link to this Backpack
        const sessionData = {
            backpackAddress,
            sessionKeypair: Array.from(wallet.secretKey)
        };
        localStorage.setItem('btc_market_session', JSON.stringify(sessionData));

        showHasWallet(backpackAddress);
        updateWalletBalance();
        fetchPositionData();
        addLog('Session wallet created: ' + wallet.publicKey.toString().substring(0, 12) + '...', 'success');
        addLog('This session wallet is now permanently linked to your Backpack', 'info');
        addLog('It will always be the same on every refresh', 'info');
        showStatus('Session created! Session wallet: ' + wallet.publicKey.toString());

    } catch (err) {
        addLog('Connection failed: ' + err.message, 'error');
        showError('Failed to connect Backpack: ' + err.message);
        console.error(err);
    }
}

function disconnectWallet() {
    addLog('Disconnecting wallet...', 'info');

    // Clear wallet references but KEEP localStorage session
    // This way the same session wallet will be restored when reconnecting
    wallet = null;
    backpackWallet = null;

    // Disconnect Backpack if connected
    if (window.backpack && window.backpack.disconnect) {
        window.backpack.disconnect();
    }

    showNoWallet();
    addLog('Wallet disconnected. Your session wallet is saved and will be restored when you reconnect.', 'success');
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
}

function showHasWallet(backpackAddr) {
    const sessionAddr = wallet.publicKey.toString();
    const shortAddr = sessionAddr.substring(0, 8) + '...' + sessionAddr.substring(sessionAddr.length - 4);

    // Nav bar
    if (document.getElementById('navWalletAddr')) {
        document.getElementById('navWalletAddr').textContent = shortAddr;
        document.getElementById('walletNavDisconnected').classList.add('hidden');
        document.getElementById('walletNavConnected').classList.remove('hidden');
    }

    // Sidebar
    if (document.getElementById('sessionAddr')) {
        document.getElementById('sessionAddr').textContent = sessionAddr;
        document.getElementById('sidebarWalletDisconnected').classList.add('hidden');
        document.getElementById('sidebarWalletConnected').classList.remove('hidden');
    }
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

        // Update nav bar
        if (document.getElementById('navWalletBal')) {
            document.getElementById('navWalletBal').textContent = solBalanceShort;
        }

        // Update sidebar
        if (document.getElementById('walletBal')) {
            document.getElementById('walletBal').textContent = solBalance;
        }
    } catch (err) {
        console.error('Failed to get balance:', err);
    }
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
        const priceUsd = (Number(price_e6) / 1_000_000).toFixed(2);
        const priceFormatted = '$' + Number(priceUsd).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

        if (document.getElementById('oracleCurrentPrice')) {
            document.getElementById('oracleCurrentPrice').textContent = priceFormatted;
        }
        if (document.getElementById('tickerPrice')) {
            document.getElementById('tickerPrice').textContent = priceFormatted;
        }

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

        // Calculate YES/NO probabilities using LMSR
        const b = bScaled;
        const a = Math.exp(qY / b);
        const c = Math.exp(qN / b);
        const yesProb = a / (a + c);
        const noProb = 1 - yesProb;

        // Calculate total shares (simplified: use vault as proxy for liquidity)
        const yesShares = Math.max(0, -qY / 1_000_000);
        const noShares = Math.max(0, -qN / 1_000_000);

        // Update YES/NO prices (in dollars instead of percentages)
        if (document.getElementById('yesPercentage')) {
            document.getElementById('yesPercentage').textContent = '$' + yesProb.toFixed(2);
        }
        if (document.getElementById('noPercentage')) {
            document.getElementById('noPercentage').textContent = '$' + noProb.toFixed(2);
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
            document.getElementById('yesBtnPrice').textContent = '$' + yesProb.toFixed(2);
        }
        if (document.getElementById('noBtnPrice')) {
            document.getElementById('noBtnPrice').textContent = '$' + noProb.toFixed(2);
        }

        // Update vault display (in header)
        if (document.getElementById('vaultDisplay')) {
            document.getElementById('vaultDisplay').textContent = '$' + (vault / 1_000_000).toFixed(0);
        }

        // Update vault total display (in oracle section)
        if (document.getElementById('vaultTotalDisplay')) {
            document.getElementById('vaultTotalDisplay').textContent = '$' + (vault / 1_000_000).toFixed(2);
        }

        // Update market status badge
        const statusText = status === 0 ? 'OPEN' : status === 1 ? 'STOPPED' : 'SETTLED';
        if (document.getElementById('marketStatusBadge')) {
            document.getElementById('marketStatusBadge').textContent = statusText;
            document.getElementById('marketStatusBadge').className = 'market-status';
            if (status === 0) document.getElementById('marketStatusBadge').style.background = '#00c896';
            else if (status === 1) document.getElementById('marketStatusBadge').style.background = '#ffa502';
            else document.getElementById('marketStatusBadge').style.background = '#ff4757';
        }

        // Update snapshot price display
        if (document.getElementById('oracleSnapshotPrice')) {
            if (startPriceE6 > 0) {
                const snapshotPrice = (startPriceE6 / 1_000_000).toFixed(2);
                document.getElementById('oracleSnapshotPrice').textContent = '$' + snapshotPrice;
                document.getElementById('oracleSnapshotPrice').style.color = '#00ff00';
            } else {
                document.getElementById('oracleSnapshotPrice').textContent = 'Not taken';
                document.getElementById('oracleSnapshotPrice').style.color = '#888';
            }
        }

        // Update button states
        if (document.getElementById('snapshotBtn')) {
            document.getElementById('snapshotBtn').disabled = status !== 0;
        }

    } catch (err) {
        console.error('Market fetch failed:', err);
    }
}

// ============= POSITION DATA =============

async function fetchPositionData() {
    if (!wallet) return;

    try {
        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

        const accountInfo = await connection.getAccountInfo(posPda);

        if (!accountInfo) {
            document.getElementById('posYes').textContent = '0.00';
            document.getElementById('posNo').textContent = '0.00';
            return;
        }

        const d = accountInfo.data;
        // Position struct: discriminator(8) + owner(32) + yes_shares_e6(8) + no_shares_e6(8)
        if (d.length >= 8 + 32 + 8 + 8) {
            let o = 8; // Skip discriminator
            o += 32; // Skip owner pubkey
            const sharesY = readI64LE(d, o); o += 8;
            const sharesN = readI64LE(d, o); o += 8;

            document.getElementById('posYes').textContent = (sharesY / 1_000_000).toFixed(2);
            document.getElementById('posNo').textContent = (sharesN / 1_000_000).toFixed(2);
        }

    } catch (err) {
        console.error('Position fetch failed:', err);
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

async function executeTrade() {
    if (!wallet) {
        addLog('ERROR: No wallet connected', 'error');
        showError('No wallet');
        return;
    }

    // Get USD amount from input and convert to e6 units
    const amountUSD = parseFloat(document.getElementById('tradeAmountUSD').value);
    if (isNaN(amountUSD) || amountUSD <= 0) {
        addLog('ERROR: Invalid trade amount', 'error');
        showError('Invalid amount');
        return;
    }

    const amount_e6 = Math.floor(amountUSD * 1_000_000);

    // Use current action and side from UI helpers
    const action = currentAction;
    const side = currentSide;

    const tradeDesc = `${action.toUpperCase()} ${side.toUpperCase()} $${amountUSD.toFixed(2)}`;
    addLog(`Executing trade: ${tradeDesc}`, 'info');
    showStatus('Executing trade...');

    try {
        const sideNum = side === 'yes' ? 1 : 2;
        const actionNum = action === 'buy' ? 1 : 2;

        const [posPda] = await solanaWeb3.PublicKey.findProgramAddressSync(
            [stringToUint8Array('pos'), ammPda.toBytes(), wallet.publicKey.toBytes()],
            new solanaWeb3.PublicKey(CONFIG.PROGRAM_ID)
        );

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
        const signature = await connection.sendRawTransaction(transaction.serialize());
        addLog('TX: ' + signature, 'tx');

        addLog('Confirming transaction...', 'info');
        await connection.confirmTransaction(signature, 'confirmed');

        addLog(`Trade SUCCESS: ${tradeDesc}`, 'success');
        showStatus('Trade success: ' + signature.substring(0, 16) + '...');

        setTimeout(() => {
            fetchMarketData();
            fetchPositionData();
            updateWalletBalance();
        }, 1000);

    } catch (err) {
        addLog('Trade FAILED: ' + err.message, 'error');
        showError('Trade failed: ' + err.message);
        console.error(err);
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
            showError('Insufficient balance (need to keep ~0.001 SOL for fees)');
            return;
        }

        addLog(`Withdrawing ${amount.toFixed(4)} SOL to Backpack...`, 'info');
        showStatus('Withdrawing ' + amount.toFixed(4) + ' SOL to Backpack...');

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

        addLog(`Withdrawal SUCCESS: ${amount.toFixed(4)} SOL transferred`, 'success');
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
        addLog(`Wallet balance: ${solBalance.toFixed(4)} SOL`, 'info');

        if (solBalance < 0.1) {
            addLog(`WARNING: Low balance! You need at least 0.1 SOL. Please fund from Backpack wallet.`, 'warning');
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
        document.getElementById('tradeAmountUSD').value = '1.00';
        selectOutcome('yes');
        switchTab('buy');
        await executeTrade();

        await new Promise(r => setTimeout(r, 2000));

        // Step 5: Test BUY NO trade
        addLog('Testing BUY NO $1.00 trade...', 'info');
        document.getElementById('tradeAmountUSD').value = '1.00';
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

// ============= POLLING =============

function startPolling() {
    fetchOracleData();
    fetchMarketData();

    setInterval(() => {
        fetchOracleData();
        fetchMarketData();
        if (wallet) {
            updateWalletBalance();
            fetchPositionData();
        }
    }, 5000);
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

function setAmount(usd) {
    document.getElementById('tradeAmountUSD').value = usd.toFixed(2);
    updateTradeButton();
}

function updateTradeButton() {
    const amount = parseFloat(document.getElementById('tradeAmountUSD').value) || 0;
    const text = currentAction + ' ' + currentSide.toUpperCase() + ' for $' + amount.toFixed(2);
    document.getElementById('tradeBtnText').textContent = text;
}

function clearLog() {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = '<div class="log-entry log-info"><span class="log-time">--:--:--</span><span class="log-message">Log cleared</span></div>';
}

// ============= INITIALIZATION =============

window.addEventListener('DOMContentLoaded', () => {
    addLog('System ready. Auto-refresh every 5s', 'info');
    
    // Add input listener for trade amount
    const tradeAmountInput = document.getElementById('tradeAmountUSD');
    if (tradeAmountInput) {
        tradeAmountInput.addEventListener('input', updateTradeButton);
    }
    
    // Start polling and session restoration
    initializeSystem();
    restoreSession();
    startPolling();
});
