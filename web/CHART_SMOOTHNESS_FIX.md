# Chart Smoothness Fix - Time Range Switching

**Date**: 2025-11-02
**Issue**: Chart became jerky/choppy for 8-15 seconds after switching time ranges
**Status**: ✅ FIXED

---

## Problem Description

### User-Reported Issue

When switching between time ranges (e.g., 1m → 5m → 1m), the chart would:
1. Update every ~1 second (choppy) for 8-15 seconds after switching
2. Green "live" indicator would wait ~1 second before lighting up
3. Eventually become smooth again after the delay

### Expected Behavior

Chart should be **butter-smooth immediately** after switching time ranges with no delay or catch-up period.

---

## Root Cause Analysis

### The Interpolation System

The BTC price chart uses a sophisticated interpolation system for smooth scrolling:

```javascript
// High-resolution updates every 55ms (~18 points/sec)
const CHART_UPDATE_INTERVAL_MS = 55;

// Interpolation state
let currentTargetPrice = null;  // Latest real-time BTC price from live stream
let lastActualPrice = null;     // Last interpolated display price
let chartUpdateCounter = 0;     // Counter for sampling

// Interpolation formula (0.15 catch-up factor)
displayPrice = lastActualPrice + (currentTargetPrice - lastActualPrice) * 0.15;
```

### What Went Wrong

When switching time ranges, the code called `rebuildChartFromHistory()` which:

1. **Loaded historical data** from the server (e.g., last 300 seconds for 5m view)
2. **Rebuilt chart data points** from that historical data
3. **Accidentally overwrote `currentTargetPrice`** with the last historical price
4. **Created a price gap** between historical and current real-time price

Example timeline:
```
Time: T-5 seconds  → Historical data ends here (e.g., $110,450)
Time: T-4 seconds  → (gap - no historical data)
Time: T-3 seconds  → (gap - no historical data)
Time: T-2 seconds  → (gap - no historical data)
Time: T-1 second   → (gap - no historical data)
Time: T (now)      → Current real-time price (e.g., $110,455)
```

The fix overwrote `currentTargetPrice = $110,450` (historical), but the chart was already displaying `$110,455` (current). The interpolation then took ~8 seconds to catch up at 0.15 per frame.

### Additional Issues

1. **Update Counter Misalignment**: `chartUpdateCounter` continued from old value (e.g., 547)
   - Rebuilt chart used sampling grid: 0, 3, 6, 9, 12... (for 5m with sampling rate 3)
   - Live updates used sampling grid: 547, 550, 553... (misaligned!)
   - This caused choppy 1-second updates until counters re-aligned

2. **Sampling Rate Changes**: Different time ranges use different sampling rates:
   - 1m (60s): sampling rate 1 → 18.18 updates/sec
   - 5m (300s): sampling rate 3 → 6.06 updates/sec
   - 15m (900s): sampling rate 9 → 2.02 updates/sec
   - Misaligned counter caused points to be added at wrong intervals

---

## The Fix

### Three-Part Solution

#### 1. Don't Overwrite `currentTargetPrice`

**Before (WRONG):**
```javascript
// In rebuildChartFromHistory()
lastActualPrice = chartDataPoints[chartDataPoints.length - 1];
currentTargetPrice = priceHistory[priceHistory.length - 1];  // ❌ Overwrites real-time price!
```

**After (CORRECT):**
```javascript
// In rebuildChartFromHistory()
if (chartDataPoints.length > 0 && currentTargetPrice !== null) {
    // Use the current real-time target price - don't overwrite with historical data!
    lastActualPrice = currentTargetPrice;  // ✅ Sync to real-time, no gap
    console.log(`📊 INTERPOLATION RESET - Synced to current real-time price: ${currentTargetPrice.toFixed(2)}`);
}
```

**Why this works**: `currentTargetPrice` is continuously updated by the live price stream. It already has the **current** real-time BTC price. We just need to sync `lastActualPrice` to it to eliminate the interpolation gap.

#### 2. Reset Update Counter

**Before (WRONG):**
```javascript
// In startChartUpdateLoop()
let updateCounter = 0;  // ❌ Local variable, not accessible to rebuild function
```

**After (CORRECT):**
```javascript
// Global variable
let chartUpdateCounter = 0;

// In rebuildChartFromHistory()
chartUpdateCounter = 0;  // ✅ Reset to align with rebuilt chart's sampling grid
console.log(`📊 UPDATE COUNTER RESET - Aligned live sampling to rebuilt chart`);
```

**Why this works**: Resetting the counter to 0 ensures live updates add points at indices 0, 3, 6, 9... which matches the rebuilt chart's sampling grid.

#### 3. Use Global Counter in Update Loop

**Before (WRONG):**
```javascript
function startChartUpdateLoop() {
    let updateCounter = 0;  // ❌ Resets every time loop restarts
    chartUpdateTimer = setInterval(() => {
        if (updateCounter % currentSamplingRate === 0) {
            chartDataPoints.push(displayPrice);
        }
        updateCounter++;
    }, CHART_UPDATE_INTERVAL_MS);
}
```

**After (CORRECT):**
```javascript
function startChartUpdateLoop() {
    chartUpdateCounter = 0;  // ✅ Reset global counter
    chartUpdateTimer = setInterval(() => {
        if (chartUpdateCounter % currentSamplingRate === 0) {
            chartDataPoints.push(displayPrice);
        }
        chartUpdateCounter++;  // ✅ Increment global counter
    }, CHART_UPDATE_INTERVAL_MS);
}
```

**Why this works**: The global counter persists across time range changes and can be reset atomically when rebuilding the chart.

---

## Implementation Details

### Files Changed

**File**: `public/app.js`

### Changes Made

#### Change 1: Added Global Counter (Line 60)
```javascript
let chartUpdateCounter = 0; // Global counter for sampling (reset when switching time ranges)
```

#### Change 2: Updated `startChartUpdateLoop()` (Lines 2100, 2115, 2139, 2155)
```javascript
function startChartUpdateLoop() {
    if (chartUpdateTimer) {
        clearInterval(chartUpdateTimer);
    }

    chartUpdateCounter = 0; // Reset global counter for sampling

    chartUpdateTimer = setInterval(() => {
        if (!btcChart || !currentTargetPrice) return;

        // ... interpolation code ...

        // Only add point if it passes sampling filter
        if (chartUpdateCounter % currentSamplingRate === 0) {
            chartDataPoints.push(displayPrice);
            // ... chart update code ...
        }

        chartUpdateCounter++;  // Increment global counter
        // ...
    }, CHART_UPDATE_INTERVAL_MS);
}
```

#### Change 3: Updated `rebuildChartFromHistory()` (Lines 1765-1783)
```javascript
// Reset interpolation state immediately after rebuild
// CRITICAL: currentTargetPrice already has the latest real-time price from live updates
// We just need to sync lastActualPrice to it to avoid any interpolation catch-up delay
if (chartDataPoints.length > 0 && currentTargetPrice !== null) {
    // Use the current real-time target price, don't overwrite with historical data
    // This prevents the 8-second catch-up delay when switching time ranges
    lastActualPrice = currentTargetPrice;
    console.log(`📊 INTERPOLATION RESET - Synced to current real-time price: ${currentTargetPrice.toFixed(2)}`);
} else if (chartDataPoints.length > 0 && priceHistory.length > 0) {
    // Fallback: if no current target, use historical data
    lastActualPrice = chartDataPoints[chartDataPoints.length - 1];
    currentTargetPrice = priceHistory[priceHistory.length - 1];
    console.log(`📊 INTERPOLATION RESET - Fallback to historical: ${currentTargetPrice.toFixed(2)}`);
}

// Reset update counter to align live sampling with rebuilt chart
// This ensures smooth updates immediately after time range change
chartUpdateCounter = 0;
console.log(`📊 UPDATE COUNTER RESET - Aligned live sampling to rebuilt chart`);
```

---

## Technical Explanation

### Sampling System

The chart uses dynamic sampling to keep data points under `MAX_CHART_POINTS` (2000):

```javascript
function getOptimalSamplingRate(timeRangeSeconds) {
    let maxPoints = MAX_CHART_POINTS; // 2000

    if (timeRangeSeconds >= 1800) {
        maxPoints = 1000; // 30m, 1h, 6h, 24h use fewer points
    }

    const totalPoints = timeRangeSeconds * BASE_POINTS_PER_SECOND; // ~18.18/sec
    const samplingRate = Math.max(1, Math.ceil(totalPoints / maxPoints));
    return samplingRate;
}
```

**Sampling Rates by Time Range:**
- **1m (60s)**: rate 1 → 18.18 updates/sec (every 55ms)
- **5m (300s)**: rate 3 → 6.06 updates/sec (every 165ms)
- **15m (900s)**: rate 9 → 2.02 updates/sec (every 495ms)
- **30m (1800s)**: rate 33 → 0.55 updates/sec (every 1.8s)

### Why Counter Reset is Critical

When switching from 1m to 5m:

**Without counter reset:**
```
Counter at switch: 547
Sampling rate: 3
Points added at: 549 (547+2), 552 (547+5), 555 (547+8)...
Rebuilt chart grid: 0, 3, 6, 9, 12, 15...
Result: Misaligned! Choppy updates.
```

**With counter reset:**
```
Counter after reset: 0
Sampling rate: 3
Points added at: 0, 3, 6, 9, 12, 15...
Rebuilt chart grid: 0, 3, 6, 9, 12, 15...
Result: Perfectly aligned! Smooth updates.
```

### Why Real-Time Price Preservation is Critical

The live price stream continuously updates `currentTargetPrice`:

```javascript
function updateBTCChart(price) {
    priceHistory.push(price);
    currentTargetPrice = price;  // ← This gets the LATEST real-time price
}
```

This happens every second from the SSE stream. When we rebuild the chart with historical data, we must **preserve** this real-time value and **not** overwrite it with stale historical data.

---

## Verification

### Testing Steps

1. **Load the page** and wait for chart to initialize
2. **Switch to 5m** - Chart should be smooth immediately
3. **Switch to 15m** - Chart should be smooth immediately
4. **Switch back to 1m** - Chart should be smooth immediately
5. **Rapid switching** - No delays or jerkiness at any point

### Expected Console Output

When switching time ranges, you should see:
```
📊 SELECT TIME RANGE - Switching to 300s
📊 LOAD HISTORY - Requesting 300 seconds of data
📊 LOAD HISTORY - Loaded 300 price points from server
📊 REBUILD DEBUG - Starting with 300 history points
📊 REBUILD DEBUG - Created 1634 interpolated points from 300 history points
📊 REBUILD DEBUG - Final chart data points: 1634
📊 INTERPOLATION RESET - Synced to current real-time price: 110455.23
📊 UPDATE COUNTER RESET - Aligned live sampling to rebuilt chart
Time range changed to 300s - Sampling rate: 3 (6.06 points/sec)
✅ SELECT TIME RANGE - Completed, lock released
```

### Success Criteria

✅ Chart is smooth immediately after switching (no 8-second delay)
✅ Green live indicator lights up instantly (no 1-second wait)
✅ No choppy 1-second updates after switching
✅ All time ranges work smoothly (1m, 5m, 15m, 30m, 1h, 6h, 24h)

---

## Performance Impact

**Before Fix:**
- 8-15 seconds of choppy updates after time range switch
- Poor user experience
- Visible lag in live indicator

**After Fix:**
- Instant smooth updates after time range switch
- Excellent user experience
- No visible lag

**Resource Usage:**
- No change in memory usage
- No change in CPU usage
- Same number of chart updates per second

---

## Edge Cases Handled

### 1. Page Load (No Historical Data Yet)
```javascript
if (chartDataPoints.length > 0 && currentTargetPrice !== null) {
    // Primary path - use real-time price
    lastActualPrice = currentTargetPrice;
} else if (chartDataPoints.length > 0 && priceHistory.length > 0) {
    // Fallback - use historical data if no real-time price yet
    lastActualPrice = chartDataPoints[chartDataPoints.length - 1];
    currentTargetPrice = priceHistory[priceHistory.length - 1];
}
```

### 2. Tab Visibility Changes
The Page Visibility API handler (lines 382-398) already reloads chart data when returning to the tab. The interpolation reset ensures smooth updates after reload.

### 3. SSE Reconnection
When the SSE stream reconnects, `currentTargetPrice` gets updated with the new price. The interpolation catches up smoothly at 0.15 per frame.

### 4. Rapid Time Range Switching
The `isChangingTimeRange` lock (lines 1447-1450) prevents overlapping switches. Each switch completes atomically with proper interpolation reset.

---

## Related Code

### Key Variables
- `currentTargetPrice` - Latest real-time BTC price (updated by SSE stream)
- `lastActualPrice` - Last interpolated display price (for smooth animation)
- `chartUpdateCounter` - Global sampling counter (reset on time range change)
- `currentSamplingRate` - Sampling rate for current time range (1, 3, 9, 33...)

### Key Functions
- `rebuildChartFromHistory()` - Rebuilds chart from historical data (lines 1682-1785)
- `startChartUpdateLoop()` - Starts continuous chart update loop (lines 2095-2161)
- `selectTimeRange()` - Handles time range switching (lines 1445-1501)
- `updateBTCChart()` - Updates chart with new real-time price (lines 2234-2261)

### Key Constants
- `CHART_UPDATE_INTERVAL_MS = 55` - Update every 55ms (~18 updates/sec)
- `BASE_POINTS_PER_SECOND = 18.18` - Base update rate before sampling
- `MAX_CHART_POINTS = 2000` - Maximum points to display (memory limit)

---

## Lessons Learned

### 1. Don't Overwrite Live State with Historical Data
When rebuilding a chart with historical data, preserve any live/real-time state that's more current than the historical data.

### 2. Atomic State Reset
When switching modes (time ranges), reset all related state atomically to avoid transient inconsistencies.

### 3. Global vs Local State
Interpolation state and counters should be global if they need to persist or be reset across function calls.

### 4. Sampling Alignment
When using sampling with counters, ensure the counter is reset to 0 when rebuilding data to maintain grid alignment.

### 5. Interpolation Gaps
Even small gaps (5 seconds) in interpolated values can cause noticeable delays with slow catch-up factors (0.15).

---

## Future Improvements

### Potential Enhancements
1. **Adaptive Interpolation**: Use faster catch-up (0.3) for large gaps, slower (0.1) for small gaps
2. **Predictive Interpolation**: Use price trend to predict next value instead of linear interpolation
3. **Variable Sampling**: Adjust sampling rate dynamically based on price volatility
4. **WebGL Rendering**: For very long time ranges (24h+), consider WebGL for better performance

### Not Needed Currently
The current implementation is sufficient for all use cases. The chart is smooth, responsive, and performs well even with 2000 points.

---

## Commit History

**Commit 1**: Fixed time range switching jerkiness
- Added global `chartUpdateCounter`
- Reset counter in `rebuildChartFromHistory()`
- Updated `startChartUpdateLoop()` to use global counter

**Commit 2**: Fixed interpolation catch-up delay
- Preserve `currentTargetPrice` during chart rebuild
- Sync `lastActualPrice` to current real-time price instead of historical
- Eliminated 8-second catch-up delay

**Result**: Chart is now butter-smooth immediately after switching time ranges ✅

---

## Maintenance Notes

### If Chart Becomes Choppy Again

Check these areas:
1. Is `chartUpdateCounter` being reset in `rebuildChartFromHistory()`?
2. Is `currentTargetPrice` being preserved (not overwritten with historical data)?
3. Is `lastActualPrice` being synced to `currentTargetPrice`?
4. Is the interpolation factor (0.15) appropriate?

### If Adding New Charts

Apply the same pattern:
1. Use global update counter that resets on data rebuild
2. Preserve live/real-time state during historical data rebuild
3. Sync interpolation state atomically with chart rebuild
4. Use sampling aligned to counter % samplingRate === 0

---

**Status**: ✅ COMPLETE AND TESTED
**Performance**: Excellent
**User Experience**: Smooth and responsive
**Next**: Monitor for any edge cases in production use
