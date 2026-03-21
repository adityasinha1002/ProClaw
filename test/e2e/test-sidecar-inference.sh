#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Test sidecar inference — run prompts through the OpenShell gateway against
# the running sidecar backend.  Requires a running gateway + sidecar.
#
# Usage: bash test/e2e/test-sidecar-inference.sh [model]
#
# Default model: whatever is set in `openshell inference get`.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0

MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  MODEL=$(openshell inference get 2>&1 | grep "Model:" | awk '{print $NF}' | sed 's/\x1b\[[0-9;]*m//g')
fi

if [ -z "$MODEL" ]; then
  echo -e "${RED}No model configured. Run nemoclaw onboard first.${NC}"
  exit 1
fi

# Get the gateway container IP for direct API calls
GW_CONTAINER=$(docker ps --filter "name=openshell-cluster-nemoclaw" --format '{{.Names}}' | head -1)
GW_IP=$(docker inspect "$GW_CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# Detect which port (Ollama=11434, LM Studio=1234)
PROVIDER=$(openshell inference get 2>&1 | grep "Provider:" | awk '{print $NF}' | sed 's/\x1b\[[0-9;]*m//g')
if [[ "$PROVIDER" == *lmstudio* ]]; then
  PORT=1234
else
  PORT=11434
fi

echo "============================================"
echo "Sidecar Inference Test"
echo "============================================"
echo "  Model:    $MODEL"
echo "  Provider: $PROVIDER"
echo "  Gateway:  $GW_CONTAINER ($GW_IP:$PORT)"
echo ""

run_test() {
  local test_name="$1"
  local prompt="$2"
  local max_tokens="${3:-200}"
  local expect_pattern="${4:-}"

  echo -n "  $test_name... "

  local start_time
  start_time=$(date +%s%N)

  local payload="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt\"}],\"max_tokens\":$max_tokens}"

  local response
  response=$(docker exec "$GW_CONTAINER" wget -qO- \
    --post-data "$payload" \
    --header 'Content-Type: application/json' \
    "http://${GW_IP}:${PORT}/v1/chat/completions" 2>&1) || true

  local end_time
  end_time=$(date +%s%N)
  local latency_ms
  latency_ms=$(( (end_time - start_time) / 1000000 ))

  # Parse response
  local ok=false
  local content=""
  local reasoning=""
  local tokens=""
  local finish=""

  if echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['choices'][0]['message']
content = c.get('content', '')
reasoning = c.get('reasoning', '')
tokens = d['usage']['total_tokens']
finish = d['choices'][0]['finish_reason']
print(f'CONTENT:{content}')
print(f'REASONING:{reasoning[:500]}')
print(f'TOKENS:{tokens}')
print(f'FINISH:{finish}')
" 2>/dev/null > /tmp/nemoclaw-test-result; then
    content=$(grep "^CONTENT:" /tmp/nemoclaw-test-result | sed 's/^CONTENT://')
    reasoning=$(grep "^REASONING:" /tmp/nemoclaw-test-result | sed 's/^REASONING://')
    tokens=$(grep "^TOKENS:" /tmp/nemoclaw-test-result | sed 's/^TOKENS://')
    finish=$(grep "^FINISH:" /tmp/nemoclaw-test-result | sed 's/^FINISH://')
    ok=true
  fi

  if [ "$ok" = true ]; then
    if [ -n "$expect_pattern" ]; then
      if echo "$content $reasoning" | grep -qi "$expect_pattern"; then
        echo -e "${GREEN}PASS${NC} (${latency_ms}ms, ${tokens} tokens, finish=${finish})"
        PASS=$((PASS + 1))
      else
        echo -e "${RED}FAIL${NC} (expected '$expect_pattern' not found)"
        echo "    Content: $content"
        echo "    Reasoning: ${reasoning:0:100}"
        FAIL=$((FAIL + 1))
      fi
    else
      echo -e "${GREEN}PASS${NC} (${latency_ms}ms, ${tokens} tokens, finish=${finish})"
      PASS=$((PASS + 1))
    fi
  else
    echo -e "${RED}FAIL${NC} (invalid response)"
    echo "    Raw: ${response:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- Simple Prompts ---"
run_test "Math (2+2)"          "What is 2+2?"                                    200 "4"
run_test "Capital"             "What is the capital of France?"                   200 "Paris"
run_test "Greeting"            "Hello, how are you?"                              150 ""

echo ""
echo "--- Reasoning ---"
run_test "Bat and ball"        "A bat and ball cost 1.10 total. The bat costs 1.00 more than the ball. How much does the ball cost? Think step by step." 500 "0.05"
run_test "Logic"               "If all roses are flowers and all flowers are plants, are all roses plants? Explain." 300 "yes"

echo ""
echo "--- Long-form ---"
run_test "Photosynthesis"      "Explain photosynthesis in 3 sentences."           300 ""
run_test "Code generation"     "Write a Python function is_prime(n)"              400 "def"

echo ""
echo "--- Performance ---"
run_test "Short response"      "Say OK"                                           20  ""
run_test "Medium response"     "List 5 programming languages"                    200  ""

echo ""
echo "============================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "============================================"

rm -f /tmp/nemoclaw-test-result

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
