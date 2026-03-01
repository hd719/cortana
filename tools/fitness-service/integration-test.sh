#!/usr/bin/env bash
set -u

SERVICE_URL="http://127.0.0.1:3033"
SERVICE_PORT="3033"
BASE_DIR="$HOME/Developer/cortana-external"

pass_count=0
fail_count=0
skip_count=0

pass() { echo "PASS $1"; pass_count=$((pass_count + 1)); }
fail() { echo "FAIL $1"; fail_count=$((fail_count + 1)); }
skip() { echo "SKIP $1"; skip_count=$((skip_count + 1)); }

is_port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$SERVICE_PORT" >/dev/null 2>&1
    return $?
  fi
  (echo > /dev/tcp/127.0.0.1/"$SERVICE_PORT") >/dev/null 2>&1
}

start_service_if_needed() {
  if is_port_open; then
    echo "Service already running on port $SERVICE_PORT"
    return 0
  fi

  echo "Service not running. Starting fitness service..."
  (
    cd "$BASE_DIR" || exit 1
    set -a
    source ./.env
    set +a
    nohup go run main.go >/tmp/cortana-external.log 2>&1 &
  )

  for _ in {1..30}; do
    if is_port_open; then
      echo "Service started successfully"
      return 0
    fi
    sleep 1
  done

  echo "Service failed to start (see /tmp/cortana-external.log)"
  return 1
}

check_json_endpoint() {
  local path="$1"
  local label="$2"
  local allowed_codes="$3"
  local url="$SERVICE_URL$path"
  local body_file
  body_file=$(mktemp)

  local code
  code=$(curl -sS --max-time 20 -o "$body_file" -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [[ " $allowed_codes " != *" $code "* ]]; then
    fail "$label (unexpected status $code)"
    rm -f "$body_file"
    return
  fi

  if jq -e '.' "$body_file" >/dev/null 2>&1; then
    pass "$label (status $code, valid JSON)"
  else
    fail "$label (status $code, invalid JSON)"
  fi

  rm -f "$body_file"
}

check_not_found() {
  local path="$1"
  local code
  code=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$SERVICE_URL$path" 2>/dev/null || echo "000")
  if [[ "$code" == "404" ]]; then
    pass "error handling for $path (404)"
  else
    fail "error handling for $path (expected 404, got $code)"
  fi
}

if ! start_service_if_needed; then
  echo "SUMMARY pass=$pass_count fail=$fail_count skip=$skip_count"
  exit 2
fi

# Core/Whoop endpoints
check_json_endpoint "/health" "GET /health" "200 503"
check_json_endpoint "/auth/url" "GET /auth/url" "200"
check_json_endpoint "/auth/status" "GET /auth/status" "200"
check_json_endpoint "/whoop/health" "GET /whoop/health" "200"
check_json_endpoint "/whoop/data" "GET /whoop/data" "200"
check_json_endpoint "/whoop/recovery" "GET /whoop/recovery" "200"
check_json_endpoint "/whoop/recovery/latest" "GET /whoop/recovery/latest" "200"

# /auth/callback without params should be a controlled client error, not server crash
check_json_endpoint "/auth/callback" "GET /auth/callback (no params)" "400"

# Tonal endpoints
check_json_endpoint "/tonal/health" "GET /tonal/health" "200 503"
check_json_endpoint "/tonal/data" "GET /tonal/data" "200 503"

# Alpaca endpoints (allow 503 when API keys/config unavailable)
check_json_endpoint "/alpaca/health" "GET /alpaca/health" "200 503"
check_json_endpoint "/alpaca/account" "GET /alpaca/account" "200 503"
check_json_endpoint "/alpaca/positions" "GET /alpaca/positions" "200 503"
check_json_endpoint "/alpaca/portfolio" "GET /alpaca/portfolio" "200 503"
check_json_endpoint "/alpaca/earnings" "GET /alpaca/earnings" "200 503"
check_json_endpoint "/alpaca/quote/AAPL" "GET /alpaca/quote/:symbol" "200 503"
check_json_endpoint "/alpaca/snapshot/AAPL" "GET /alpaca/snapshot/:symbol" "200 503"
check_json_endpoint "/alpaca/bars/AAPL" "GET /alpaca/bars/:symbol" "200 503"
check_json_endpoint "/alpaca/trades" "GET /alpaca/trades" "200"
check_json_endpoint "/alpaca/stats" "GET /alpaca/stats" "200"
check_json_endpoint "/alpaca/performance" "GET /alpaca/performance" "200 503"

# Error handling
check_not_found "/this/route/does/not/exist"
check_not_found "/alpaca/not-a-real-endpoint"

echo "SUMMARY pass=$pass_count fail=$fail_count skip=$skip_count"

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi

exit 0
