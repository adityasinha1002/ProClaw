#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Demo script for recording NemoClaw local GPU inference setup.
# Shows the full flow: clean install → onboard → model selection → live inference.
#
# Usage:
#   # Full interactive demo (record this)
#   bash scripts/demo-local-inference.sh
#
#   # Fast demo with pre-pulled model (skip download wait)
#   NEMOCLAW_FAST_DEMO=1 bash scripts/demo-local-inference.sh
#
# Prerequisites:
#   - Docker Desktop running with WSL2 integration
#   - NVIDIA GPU (RTX 4090 or similar)
#   - ~20 minutes for first run (model download + sandbox build)

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

narrate() {
  echo ""
  echo -e "${CYAN}# $1${NC}"
  sleep 1
}

type_cmd() {
  # Simulate typing a command, then run it
  echo ""
  echo -ne "${BOLD}\$ ${NC}"
  local cmd="$1"
  for (( i=0; i<${#cmd}; i++ )); do
    echo -n "${cmd:$i:1}"
    sleep 0.03
  done
  echo ""
  sleep 0.5
  eval "$cmd"
}

pause() {
  sleep "${1:-2}"
}

# ── Pre-flight ───────────────────────────────────────────────────
clear
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  NemoClaw — Local GPU Inference with Docker Sidecars    ║${NC}"
echo -e "${BOLD}║  RTX 4090 · Nemotron 3 Nano 30B · Zero Install         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
pause 3

# ── Act 1: Show the environment ─────────────────────────────────
narrate "First, let's check our environment"

type_cmd "nvidia-smi -L"
pause

type_cmd "docker --version"
pause

narrate "Clean slate — no NemoClaw containers or volumes running"
type_cmd "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep nemoclaw || echo '(none)'"
pause 2

# ── Act 2: Onboard ──────────────────────────────────────────────
narrate "Now let's set up NemoClaw with local GPU inference"
narrate "This one command handles everything: gateway, sidecar, model, sandbox"
pause 2

if [ "${NEMOCLAW_FAST_DEMO:-}" = "1" ]; then
  narrate "(Fast demo mode — using pre-pulled model)"
  type_cmd "NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard"
else
  type_cmd "NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard"
fi

# ── Act 3: Show what's running ───────────────────────────────────
narrate "Let's see what NemoClaw created"
pause

type_cmd "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'nemoclaw|openshell'"
pause 2

narrate "The Ollama sidecar shares the gateway's network namespace"
narrate "No host install needed — everything runs in Docker"
pause 2

type_cmd "openshell inference get"
pause 2

narrate "The model is loaded and ready on the GPU"
type_cmd "docker exec nemoclaw-ollama-default ollama list"
pause 2

# ── Act 4: Live inference from the sandbox ───────────────────────
narrate "Now let's test inference from INSIDE the sandbox"
narrate "The sandbox calls inference.local → OpenShell gateway → sidecar → GPU"
pause 2

MODEL=$(openshell inference get 2>&1 | grep "Model:" | awk '{print $NF}' | sed 's/\x1b\[[0-9;]*m//g')

narrate "Test 1: Simple question"
type_cmd "echo 'curl -sk https://inference.local/v1/chat/completions -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"${MODEL}\\\",\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"What is the capital of France? One sentence.\\\"}],\\\"max_tokens\\\":200}\" 2>&1; exit' | openshell sandbox connect my-assistant 2>&1 | grep chatcmpl | python3 -c \"import json,sys; d=json.loads(sys.stdin.readline()); print(d['choices'][0]['message'].get('content','') or d['choices'][0]['message'].get('reasoning','')[:200])\""
pause 3

narrate "Test 2: Reasoning"
type_cmd "echo 'curl -sk https://inference.local/v1/chat/completions -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"${MODEL}\\\",\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"A bat and ball cost 1.10. The bat costs 1.00 more than the ball. How much is the ball?\\\"}],\\\"max_tokens\\\":500}\" 2>&1; exit' | openshell sandbox connect my-assistant 2>&1 | grep chatcmpl | python3 -c \"import json,sys; d=json.loads(sys.stdin.readline()); c=d['choices'][0]['message']; print(c.get('content','')[:300] or c.get('reasoning','')[:300])\""
pause 3

narrate "Test 3: Code generation"
GW_IP=$(docker inspect openshell-cluster-nemoclaw --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
PORT=11434
type_cmd "docker exec openshell-cluster-nemoclaw wget -qO- --post-data '{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Write a Python function is_prime(n)\"}],\"max_tokens\":400}' --header 'Content-Type: application/json' http://${GW_IP}:${PORT}/v1/chat/completions 2>&1 | python3 -c \"import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message'].get('content','')[:500])\""
pause 3

# ── Act 5: Architecture diagram ─────────────────────────────────
narrate "Here's how the inference routing works:"
echo ""
echo -e "${CYAN}  ┌─────────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}  │ Sandbox pod (OpenClaw)                              │${NC}"
echo -e "${CYAN}  │   curl https://inference.local/v1/chat/completions  │${NC}"
echo -e "${CYAN}  └──────────────────────┬────────────────────────────────┘${NC}"
echo -e "${CYAN}                         ↓${NC}"
echo -e "${CYAN}  ┌──────────────────────┴────────────────────────────────┐${NC}"
echo -e "${CYAN}  │ OpenShell gateway (k3s pod)                           │${NC}"
echo -e "${CYAN}  │   Proxies to provider: http://${GW_IP}:${PORT}/v1   │${NC}"
echo -e "${CYAN}  └──────────────────────┬────────────────────────────────┘${NC}"
echo -e "${CYAN}                         ↓ (shared Docker network)${NC}"
echo -e "${CYAN}  ┌──────────────────────┴────────────────────────────────┐${NC}"
echo -e "${CYAN}  │ Ollama sidecar (--network container:gateway)          │${NC}"
echo -e "${CYAN}  │   ${MODEL} on RTX 4090                   │${NC}"
echo -e "${CYAN}  └───────────────────────────────────────────────────────┘${NC}"
pause 5

# ── Finale ───────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ Demo complete!${NC}"
echo ""
echo "  What we showed:"
echo "    • Zero-install local GPU inference via Docker sidecars"
echo "    • Nemotron 3 Nano 30B running on RTX 4090"
echo "    • Full inference chain: sandbox → inference.local → gateway → sidecar"
echo "    • Reasoning, factual, and code generation prompts"
echo ""
echo "  To try it yourself:"
echo "    NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard"
echo ""
