# Lightweight Charts Implementation Notes

**Date**: November 1, 2025
**Status**: Stashed - implementation incomplete (empty chart issue)

## Summary

Attempted to replace Chart.js with TradingView's Lightweight Charts library for better performance and professional financial charting features (candlestick support, etc.).

## Changes Made

### 1. Added Lightweight Charts Library
- CDN: `https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js`
- Created new file: `web/public/lightweight_chart_init.js` (250 lines)

### 2. Chart Initialization
- Replaced Chart.js chart creation with `LightweightCharts.createChart()`
- Configured dark theme matching existing UI
- Added support for two chart types:
  - **Area chart**: Default smooth area series
  - **Candlestick chart**: OHLC candlestick series

### 3. Variable Scoping Fixes
Modified `web/public/app.js` to expose chart variables on `window` object:
```javascript
window.btcChart = null;
window.btcChartSeries = null;
window.priceHistory = [];
window.currentTimeRange = 60;
window.chartStyle = 'area';
window.chartDataPoints = [];
window.chartUpdateTimer = null;
window.currentTargetPrice = null;
window.lastActualPrice = null;
```

### 4. Update Loop
Created separate update loop in `lightweight_chart_init.js`:
- Runs at 55ms intervals (same as Chart.js)
- For area charts: uses `series.update()` with `{time, value}`
- For candlestick: aggregates tick data into 5-second candles
- Uses `createCandlesFromPrices()` helper function

### 5. Modified Functions
- `updateBTCChart()`: Removed blocking check when chart not ready, always sets `currentTargetPrice`
- `rebuildChartFromHistory()`: Converted to use Lightweight Charts API
- `toggleChartStyle()`: Syncs chartStyle to window object
- `loadChartStylePreference()`: Syncs loaded preference to window

## Issues Encountered

### Empty Chart Problem
- Chart container initializes successfully
- Console shows "Starting Lightweight Charts update loop..."
- But chart area remains empty with no visible data
- Root cause: Timing/async issues between chart init and price data flow

### Attempted Fixes
1. ✅ Fixed variable scoping (use window object)
2. ✅ Removed blocking check in updateBTCChart
3. ✅ Ensured currentTargetPrice is always set
4. ⏸️ Chart still empty - likely deeper initialization order issue

## Files Modified

- `web/public/index.html`: Added Lightweight Charts script, lightweight_chart_init.js
- `web/public/index.css`: No chart-specific changes needed
- `web/public/app.js`: Variable scoping, removed Chart.js references
- `web/public/lightweight_chart_init.js`: NEW FILE - all Lightweight Charts logic

## Git Stash Info

Saved to: `stash@{0}`
Message: "Lightweight Charts implementation - collapsible wallet, withdraw button, window scoping"

To restore:
```bash
git stash apply stash@{0}
```

## Recommendations for Future Attempt

1. **Simplify data flow**: Have a single source of truth for price data
2. **Debug initialization order**: Use more detailed logging to track when each component becomes available
3. **Test with static data first**: Load hardcoded price array to isolate chart rendering from WebSocket issues
4. **Check Lightweight Charts docs**: Review examples for real-time streaming data patterns
5. **Consider using setData() instead of update()**: Rebuild entire dataset on each update instead of incremental

## Features That Still Work

These features were preserved during the Lightweight Charts attempt:
- ✅ Collapsible wallet panel (default closed)
- ✅ Wallet panel positioned second on page
- ✅ Withdraw button in top navigation
- ✅ Toned-down button colors (subtle instead of bright)
- ✅ Chart style toggle button (cycles between modes)

## Reverted To

**Current state**: Using Chart.js implementation from `proto1.html`
- Chart.js library: `chart.min.js`
- Working chart with real-time price updates
- Area chart with red/green colored segments
- Time range cycling (1m, 5m, 15m, 30m, 1h, 6h, 24h)

## Next Steps if Resuming

1. Create minimal test case with Lightweight Charts + hardcoded data
2. Compare working Chart.js data flow vs Lightweight Charts requirements
3. Add detailed console logging at every step of initialization
4. Consider using Lightweight Charts replaceData() API for simpler updates
5. Review Lightweight Charts "Handling real-time updates" documentation
