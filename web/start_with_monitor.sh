#!/bin/bash
# Start web server and trade monitor together

cd "$(dirname "$0")"

echo "Starting X1 Markets Web Interface with Live Trade Monitor..."
echo ""

# Start trade monitor in background
echo "🔍 Starting trade monitor (WebSocket on port 3435)..."
node trade_monitor.js &
MONITOR_PID=$!

# Wait a moment for monitor to start
sleep 2

# Start web server
echo "🌐 Starting web server (HTTP on port 3434)..."
node server.js &
SERVER_PID=$!

echo ""
echo "✅ Services started!"
echo "   Web UI: http://localhost:3434"
echo "   Trade Monitor PID: $MONITOR_PID"
echo "   Web Server PID: $SERVER_PID"
echo ""
echo "Press Ctrl+C to stop all services..."

# Trap Ctrl+C and kill both processes
trap "echo ''; echo 'Stopping services...'; kill $MONITOR_PID $SERVER_PID 2>/dev/null; exit" INT

# Wait for both processes
wait
