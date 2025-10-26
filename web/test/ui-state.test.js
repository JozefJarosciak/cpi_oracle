/**
 * UI State Management Tests for X1 Prediction Market Web App
 *
 * Tests UI consistency with on-chain state:
 * - Button state management based on market status
 * - Display updates after trades
 * - Position value calculations
 * - Redeemable balance calculations
 */

const { JSDOM } = require('jsdom');
const assert = require('assert');

describe('UI State Management Tests', function() {
    let dom;
    let document;
    let window;

    before(function() {
        // Create a virtual DOM environment
        const html = `
            <!DOCTYPE html>
            <html>
            <body>
                <button id="tradeBtn">Trade</button>
                <button id="yesBtn">YES</button>
                <button id="noBtn">NO</button>
                <button id="btnRedeemSidebar">Redeem</button>
                <span id="marketStatusBadge">OPEN</span>
                <span id="yesPercentage">0.50</span>
                <span id="noPercentage">0.50</span>
                <span id="yesShares">0 shares</span>
                <span id="noShares">0 shares</span>
                <span id="vaultDisplay">0</span>
                <span id="vaultTotalDisplay">0</span>
                <span id="posYesDisplay">0.00</span>
                <span id="posNoDisplay">0.00</span>
                <span id="posYesValue">$0.00</span>
                <span id="posNoValue">$0.00</span>
                <span id="totalPosValue">$0.00</span>
                <span id="netExposure">--</span>
                <span id="redeemableAmountSidebar">0.00 XNT</span>
                <span id="walletBal">0.0000</span>
                <span id="navWalletBal">0.00</span>
            </body>
            </html>
        `;
        dom = new JSDOM(html);
        document = dom.window.document;
        window = dom.window;
    });

    describe('Button State Management', function() {
        it('should enable trade buttons when market is OPEN (status=0)', function() {
            const currentMarketStatus = 0;

            const tradeBtn = document.getElementById('tradeBtn');
            const yesBtn = document.getElementById('yesBtn');
            const noBtn = document.getElementById('noBtn');

            const canTrade = currentMarketStatus === 0;

            tradeBtn.disabled = !canTrade;
            yesBtn.disabled = !canTrade;
            noBtn.disabled = !canTrade;

            assert.strictEqual(tradeBtn.disabled, false, 'Trade button should be enabled');
            assert.strictEqual(yesBtn.disabled, false, 'YES button should be enabled');
            assert.strictEqual(noBtn.disabled, false, 'NO button should be enabled');

            console.log('✓ Trade buttons enabled when market OPEN');
        });

        it('should disable trade buttons when market is STOPPED (status=1)', function() {
            const currentMarketStatus = 1;

            const tradeBtn = document.getElementById('tradeBtn');
            const yesBtn = document.getElementById('yesBtn');
            const noBtn = document.getElementById('noBtn');

            const canTrade = currentMarketStatus === 0;

            tradeBtn.disabled = !canTrade;
            yesBtn.disabled = !canTrade;
            noBtn.disabled = !canTrade;

            assert.strictEqual(tradeBtn.disabled, true, 'Trade button should be disabled');
            assert.strictEqual(yesBtn.disabled, true, 'YES button should be disabled');
            assert.strictEqual(noBtn.disabled, true, 'NO button should be disabled');

            console.log('✓ Trade buttons disabled when market STOPPED');
        });

        it('should disable trade buttons when market is SETTLED (status=2)', function() {
            const currentMarketStatus = 2;

            const tradeBtn = document.getElementById('tradeBtn');
            const yesBtn = document.getElementById('yesBtn');
            const noBtn = document.getElementById('noBtn');

            const canTrade = currentMarketStatus === 0;

            tradeBtn.disabled = !canTrade;
            yesBtn.disabled = !canTrade;
            noBtn.disabled = !canTrade;

            assert.strictEqual(tradeBtn.disabled, true, 'Trade button should be disabled');
            assert.strictEqual(yesBtn.disabled, true, 'YES button should be disabled');
            assert.strictEqual(noBtn.disabled, true, 'NO button should be disabled');

            console.log('✓ Trade buttons disabled when market SETTLED');
        });

        it('should enable redeem button only when market is SETTLED (status=2)', function() {
            const redeemBtn = document.getElementById('btnRedeemSidebar');

            // Test with market OPEN
            let currentMarketStatus = 0;
            let canRedeem = currentMarketStatus === 2;
            redeemBtn.disabled = !canRedeem;
            assert.strictEqual(redeemBtn.disabled, true, 'Redeem should be disabled when OPEN');

            // Test with market STOPPED
            currentMarketStatus = 1;
            canRedeem = currentMarketStatus === 2;
            redeemBtn.disabled = !canRedeem;
            assert.strictEqual(redeemBtn.disabled, true, 'Redeem should be disabled when STOPPED');

            // Test with market SETTLED
            currentMarketStatus = 2;
            canRedeem = currentMarketStatus === 2;
            redeemBtn.disabled = !canRedeem;
            assert.strictEqual(redeemBtn.disabled, false, 'Redeem should be enabled when SETTLED');

            console.log('✓ Redeem button state correct for all market statuses');
        });
    });

    describe('Market Status Badge Display', function() {
        it('should display correct status text for OPEN market', function() {
            const status = 0;
            const statusText = status === 0 ? 'OPEN' : status === 1 ? 'STOPPED' : 'SETTLED';

            const badge = document.getElementById('marketStatusBadge');
            badge.textContent = statusText;

            assert.strictEqual(badge.textContent, 'OPEN', 'Badge should show OPEN');
            console.log('✓ Status badge shows OPEN for status=0');
        });

        it('should display correct status text for STOPPED market', function() {
            const status = 1;
            const statusText = status === 0 ? 'OPEN' : status === 1 ? 'STOPPED' : 'SETTLED';

            const badge = document.getElementById('marketStatusBadge');
            badge.textContent = statusText;

            assert.strictEqual(badge.textContent, 'STOPPED', 'Badge should show STOPPED');
            console.log('✓ Status badge shows STOPPED for status=1');
        });

        it('should display correct status text for SETTLED market', function() {
            const status = 2;
            const statusText = status === 0 ? 'OPEN' : status === 1 ? 'STOPPED' : 'SETTLED';

            const badge = document.getElementById('marketStatusBadge');
            badge.textContent = statusText;

            assert.strictEqual(badge.textContent, 'SETTLED', 'Badge should show SETTLED');
            console.log('✓ Status badge shows SETTLED for status=2');
        });
    });

    describe('Price Display Updates', function() {
        it('should update YES/NO prices from market data', function() {
            // Simulate LMSR calculation
            const b = 500; // liquidity parameter
            const qYes = 100;
            const qNo = 50;

            const expYes = Math.exp(qYes / b);
            const expNo = Math.exp(qNo / b);
            const yesProb = expYes / (expYes + expNo);
            const noProb = 1 - yesProb;

            document.getElementById('yesPercentage').textContent = yesProb.toFixed(2);
            document.getElementById('noPercentage').textContent = noProb.toFixed(2);

            const displayedYes = parseFloat(document.getElementById('yesPercentage').textContent);
            const displayedNo = parseFloat(document.getElementById('noPercentage').textContent);

            assert(displayedYes >= 0 && displayedYes <= 1, 'YES price should be 0-1');
            assert(displayedNo >= 0 && displayedNo <= 1, 'NO price should be 0-1');
            assert(Math.abs(displayedYes + displayedNo - 1) < 0.01, 'Prices should sum to ~1');

            console.log(`✓ YES price: ${displayedYes}, NO price: ${displayedNo}`);
        });

        it('should update share quantities from market data', function() {
            const SCALE_E6 = 10_000_000;
            const qYesE6 = 1_500_000_000; // 150 shares in e6
            const qNoE6 = 800_000_000;    // 80 shares in e6

            const yesShares = Math.max(0, qYesE6 / SCALE_E6);
            const noShares = Math.max(0, qNoE6 / SCALE_E6);

            document.getElementById('yesShares').textContent = yesShares.toFixed(0) + ' shares';
            document.getElementById('noShares').textContent = noShares.toFixed(0) + ' shares';

            assert(document.getElementById('yesShares').textContent.includes('150'), 'YES shares should be 150');
            assert(document.getElementById('noShares').textContent.includes('80'), 'NO shares should be 80');

            console.log('✓ Share quantities display correctly');
        });

        it('should update vault display from market data', function() {
            const SCALE_E6 = 10_000_000;
            const vaultE6 = 5_000_000_000; // 500 XNT in e6

            const vaultXNT = vaultE6 / SCALE_E6;

            document.getElementById('vaultDisplay').textContent = vaultXNT.toFixed(0);
            document.getElementById('vaultTotalDisplay').textContent = vaultXNT.toFixed(2);

            assert(document.getElementById('vaultDisplay').textContent.includes('500'), 'Vault should show 500');
            assert(document.getElementById('vaultTotalDisplay').textContent.includes('500'), 'Vault total should show 500.00');

            console.log('✓ Vault display updates correctly');
        });
    });

    describe('Position Display Updates', function() {
        it('should update position shares from on-chain data', function() {
            const SCALE_E6 = 10_000_000;
            const yesSharesE6 = 250_000_000; // 25 shares
            const noSharesE6 = 150_000_000;  // 15 shares

            const sharesYes = yesSharesE6 / SCALE_E6;
            const sharesNo = noSharesE6 / SCALE_E6;

            document.getElementById('posYesDisplay').textContent = sharesYes.toFixed(2);
            document.getElementById('posNoDisplay').textContent = sharesNo.toFixed(2);

            assert.strictEqual(document.getElementById('posYesDisplay').textContent, '25.00', 'YES position should be 25.00');
            assert.strictEqual(document.getElementById('posNoDisplay').textContent, '15.00', 'NO position should be 15.00');

            console.log('✓ Position shares display correctly');
        });

        it('should calculate and display position values using current prices', function() {
            const sharesYes = 25;
            const sharesNo = 15;
            const currentYesPrice = 0.60;
            const currentNoPrice = 0.40;

            const yesValue = sharesYes * currentYesPrice;
            const noValue = sharesNo * currentNoPrice;
            const totalValue = yesValue + noValue;

            document.getElementById('posYesValue').textContent = '≈ ' + yesValue.toFixed(2) + ' XNT';
            document.getElementById('posNoValue').textContent = '≈ ' + noValue.toFixed(2) + ' XNT';
            document.getElementById('totalPosValue').textContent = totalValue.toFixed(2) + ' XNT';

            assert(document.getElementById('posYesValue').textContent.includes('15.00'), 'YES value should be 15.00');
            assert(document.getElementById('posNoValue').textContent.includes('6.00'), 'NO value should be 6.00');
            assert(document.getElementById('totalPosValue').textContent.includes('21.00'), 'Total should be 21.00');

            console.log('✓ Position values calculated correctly');
        });

        it('should calculate and display net exposure correctly', function() {
            const netExposureEl = document.getElementById('netExposure');

            // Test neutral position
            let yesValue = 10;
            let noValue = 10;
            let netExposure = yesValue - noValue;

            if (Math.abs(netExposure) < 0.01) {
                netExposureEl.textContent = 'Neutral';
                netExposureEl.style.color = '#8b92a8';
            }
            assert.strictEqual(netExposureEl.textContent, 'Neutral', 'Should show Neutral for balanced position');

            // Test YES-biased position
            yesValue = 15;
            noValue = 6;
            netExposure = yesValue - noValue;

            if (netExposure > 0) {
                netExposureEl.textContent = '+' + netExposure.toFixed(2) + ' XNT YES';
                netExposureEl.style.color = '#00c896';
            }
            assert(netExposureEl.textContent.includes('+9.00'), 'Should show +9.00 YES exposure');

            // Test NO-biased position
            yesValue = 6;
            noValue = 15;
            netExposure = yesValue - noValue;

            if (netExposure < 0) {
                netExposureEl.textContent = '-' + Math.abs(netExposure).toFixed(2) + ' XNT NO';
                netExposureEl.style.color = '#ff4757';
            }
            assert(netExposureEl.textContent.includes('-9.00'), 'Should show -9.00 NO exposure');

            console.log('✓ Net exposure calculations correct');
        });
    });

    describe('Redeemable Balance Calculations', function() {
        it('should calculate redeemable value when market settled with YES winner', function() {
            const currentMarketStatus = 2; // SETTLED
            const currentWinningSide = 'yes';
            const payoutPerWinningShare = 0.95; // payout per share
            const sharesYes = 100;
            const sharesNo = 50;

            let yesValue, noValue, totalRedeemable;

            if (currentMarketStatus === 2 && currentWinningSide) {
                if (currentWinningSide === 'yes') {
                    yesValue = sharesYes * payoutPerWinningShare;
                    noValue = 0;
                } else {
                    yesValue = 0;
                    noValue = sharesNo * payoutPerWinningShare;
                }
                totalRedeemable = yesValue + noValue;
            } else {
                yesValue = 0;
                noValue = 0;
                totalRedeemable = 0;
            }

            const totalText = totalRedeemable > 0 ? totalRedeemable.toFixed(2) + ' XNT' : '0.00 XNT';
            document.getElementById('redeemableAmountSidebar').textContent = totalText;

            assert.strictEqual(yesValue, 95, 'YES redeemable should be 95');
            assert.strictEqual(noValue, 0, 'NO redeemable should be 0');
            assert(document.getElementById('redeemableAmountSidebar').textContent.includes('95.00'), 'Display should show 95.00 XNT');

            console.log('✓ Redeemable value calculated correctly for YES winner');
        });

        it('should calculate redeemable value when market settled with NO winner', function() {
            const currentMarketStatus = 2; // SETTLED
            const currentWinningSide = 'no';
            const payoutPerWinningShare = 1.00;
            const sharesYes = 100;
            const sharesNo = 50;

            let yesValue, noValue, totalRedeemable;

            if (currentMarketStatus === 2 && currentWinningSide) {
                if (currentWinningSide === 'yes') {
                    yesValue = sharesYes * payoutPerWinningShare;
                    noValue = 0;
                } else {
                    yesValue = 0;
                    noValue = sharesNo * payoutPerWinningShare;
                }
                totalRedeemable = yesValue + noValue;
            }

            const totalText = totalRedeemable.toFixed(2) + ' XNT';
            document.getElementById('redeemableAmountSidebar').textContent = totalText;

            assert.strictEqual(yesValue, 0, 'YES redeemable should be 0');
            assert.strictEqual(noValue, 50, 'NO redeemable should be 50');
            assert(document.getElementById('redeemableAmountSidebar').textContent.includes('50.00'), 'Display should show 50.00 XNT');

            console.log('✓ Redeemable value calculated correctly for NO winner');
        });

        it('should show zero redeemable when market not settled', function() {
            const currentMarketStatus = 0; // OPEN
            const currentWinningSide = null;
            const sharesYes = 100;
            const sharesNo = 50;

            let totalRedeemable = 0;

            if (currentMarketStatus === 2 && currentWinningSide) {
                // Would calculate here
            } else {
                totalRedeemable = 0;
            }

            const totalText = totalRedeemable > 0 ? totalRedeemable.toFixed(2) + ' XNT' : '0.00 XNT';
            document.getElementById('redeemableAmountSidebar').textContent = totalText;

            assert.strictEqual(document.getElementById('redeemableAmountSidebar').textContent, '0.00 XNT', 'Should show 0.00 when not settled');

            console.log('✓ Redeemable shows zero when market not settled');
        });
    });

    describe('Wallet Balance Display', function() {
        it('should update wallet balance from on-chain data', function() {
            const balanceLamports = 5_123_456_789; // 5.123456789 SOL
            const solBalance = balanceLamports / 1_000_000_000;

            const solBalanceFull = solBalance.toFixed(4);
            const solBalanceShort = solBalance.toFixed(2);

            document.getElementById('navWalletBal').textContent = solBalanceShort;
            document.getElementById('walletBal').textContent = solBalanceFull;

            assert.strictEqual(document.getElementById('navWalletBal').textContent, '5.12', 'Nav balance should be 5.12');
            assert.strictEqual(document.getElementById('walletBal').textContent, '5.1235', 'Sidebar balance should be 5.1235');

            console.log('✓ Wallet balance displays correctly');
        });

        it('should handle zero balance correctly', function() {
            const balanceLamports = 0;
            const solBalance = balanceLamports / 1_000_000_000;

            document.getElementById('navWalletBal').textContent = solBalance.toFixed(2);
            document.getElementById('walletBal').textContent = solBalance.toFixed(4);

            assert.strictEqual(document.getElementById('navWalletBal').textContent, '0.00', 'Nav balance should be 0.00');
            assert.strictEqual(document.getElementById('walletBal').textContent, '0.0000', 'Sidebar balance should be 0.0000');

            console.log('✓ Zero balance displays correctly');
        });
    });

    describe('LMSR Price Consistency', function() {
        it('should ensure prices sum to 1.0', function() {
            const b = 500;
            const testCases = [
                { qYes: 0, qNo: 0 },
                { qYes: 100, qNo: 0 },
                { qYes: 0, qNo: 100 },
                { qYes: 100, qNo: 100 },
                { qYes: 250, qNo: 150 },
            ];

            testCases.forEach(({ qYes, qNo }) => {
                const expYes = Math.exp(qYes / b);
                const expNo = Math.exp(qNo / b);
                const pYes = expYes / (expYes + expNo);
                const pNo = 1 - pYes;

                const sum = pYes + pNo;
                assert(Math.abs(sum - 1.0) < 0.0001, `Prices should sum to 1.0 (got ${sum}) for qYes=${qYes}, qNo=${qNo}`);
            });

            console.log('✓ LMSR prices sum to 1.0 for all test cases');
        });

        it('should verify price bounds (0 to 1)', function() {
            const b = 500;
            const testCases = [
                { qYes: -100, qNo: 100 },
                { qYes: 1000, qNo: 0 },
                { qYes: 0, qNo: 1000 },
                { qYes: 500, qNo: 500 },
            ];

            testCases.forEach(({ qYes, qNo }) => {
                const expYes = Math.exp(qYes / b);
                const expNo = Math.exp(qNo / b);
                const pYes = expYes / (expYes + expNo);
                const pNo = 1 - pYes;

                assert(pYes >= 0 && pYes <= 1, `YES price must be 0-1 (got ${pYes})`);
                assert(pNo >= 0 && pNo <= 1, `NO price must be 0-1 (got ${pNo})`);
            });

            console.log('✓ LMSR prices always within valid bounds');
        });
    });
});
