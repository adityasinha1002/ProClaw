// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// LM Studio Docker sidecar — runs lmstudio/llmster-preview as a Docker
// container sharing the OpenShell gateway's network namespace.  Same
// approach as ollama-container.js: shared netns means localhost:1234 is
// reachable from the gateway and its k3s pods.

const { run, runCapture } = require("./runner");
const { findGatewayContainer } = require("./ollama-container");
const { shellQuote } = require("./local-inference");
const { spawn } = require("child_process");

const LMSTUDIO_IMAGE = "lmstudio/llmster-preview";
const CONTAINER_NAME_PREFIX = "nemoclaw-lmstudio";

function containerName(sandboxName) {
  return `${CONTAINER_NAME_PREFIX}-${sandboxName || "default"}`;
}

/**
 * Start the LM Studio sidecar container sharing the gateway's network namespace.
 * Uses --gpus all for GPU acceleration.  Model storage persisted via named volume.
 */
function startLmstudioContainer(sandboxName) {
  const name = containerName(sandboxName);
  const gateway = findGatewayContainer();
  if (!gateway) {
    console.error("  Cannot find OpenShell gateway container. Is the gateway running?");
    process.exit(1);
  }

  // Remove any stale container with the same name
  run(`docker rm -f ${name} 2>/dev/null || true`, { ignoreError: true });

  const hasGpu = !!runCapture("nvidia-smi -L 2>/dev/null", { ignoreError: true });
  const gpuFlag = hasGpu ? "--gpus all" : "";

  run(
    `docker run -d ${gpuFlag} --network container:${gateway} ` +
    `-v nemoclaw-lmstudio-models:/root/.lmstudio ` +
    `--name ${name} ${LMSTUDIO_IMAGE}`,
    { ignoreError: false }
  );

  return name;
}

/**
 * Wait for LM Studio server to become healthy on port 1234.
 * The lmstudio/llmster-preview image has no curl/wget — use `lms status`.
 */
function waitForHealth(sandboxName, timeout = 90) {
  const name = containerName(sandboxName);
  const start = Date.now();

  while ((Date.now() - start) / 1000 < timeout) {
    const result = runCapture(
      `docker exec ${name} lms status 2>/dev/null`,
      { ignoreError: true }
    );
    if (result && result.includes("ON")) return true;
    require("child_process").spawnSync("sleep", ["2"]);
  }
  return false;
}

/**
 * Download a model inside the LM Studio sidecar.
 * Format: `lms get "model@quantization" --yes`
 */
function pullModel(sandboxName, model) {
  const name = containerName(sandboxName);
  run(`docker exec ${name} lms get ${shellQuote(model)} --yes`, { ignoreError: false });
}

/**
 * Check if a model is already downloaded in the sidecar.
 * Parses `lms ls` output for the model name (without @quantization suffix).
 */
function hasModel(sandboxName, model) {
  const name = containerName(sandboxName);
  const output = runCapture(
    `docker exec ${name} lms ls 2>/dev/null`,
    { ignoreError: true }
  );
  if (!output) return false;
  // lms ls shows model names without @quant — strip it for matching
  const baseName = model.split("@")[0];
  return output.toLowerCase().includes(baseName.toLowerCase());
}

/**
 * Load a model into GPU memory.  Required for LM Studio (unlike Ollama which auto-loads).
 */
function loadModel(sandboxName, model) {
  const name = containerName(sandboxName);
  const baseName = model.split("@")[0];
  const result = run(
    `docker exec ${name} lms load ${shellQuote(baseName)} --gpu max --yes 2>&1`,
    { ignoreError: true }
  );
  return result.status === 0;
}

/**
 * Validate that the model responds to an inference probe.
 * Uses the gateway container's wget to hit the LM Studio API at localhost:1234.
 */
function validateModel(sandboxName, model, timeoutSeconds = 120) {
  const gateway = findGatewayContainer();
  if (!gateway) {
    return { ok: false, message: "Gateway container not found for validation probe." };
  }
  const baseName = model.split("@")[0];
  const payload = JSON.stringify({
    model: baseName,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 10,
  });
  const output = runCapture(
    `timeout ${timeoutSeconds} docker exec ${gateway} wget -qO- ` +
    `--post-data '${payload.replace(/'/g, "'\\''")}' ` +
    `--header 'Content-Type: application/json' ` +
    `http://127.0.0.1:1234/v1/chat/completions 2>&1`,
    { ignoreError: true }
  );
  if (!output) {
    return {
      ok: false,
      message:
        `LM Studio model '${baseName}' did not answer the probe in time. ` +
        "It may still be loading or not fully loaded into GPU.",
    };
  }
  if (output.includes('"error"')) {
    return { ok: false, message: `LM Studio model '${baseName}' probe failed: ${output.slice(0, 200)}` };
  }
  return { ok: true };
}

/**
 * Send a short prompt to keep the model loaded in memory.
 */
function warmupModel(sandboxName, model) {
  // validateModel already sends a probe — calling it again is sufficient
  validateModel(sandboxName, model, 30);
}

/**
 * Stop and remove the LM Studio sidecar container.
 */
function stopLmstudioContainer(sandboxName) {
  const name = containerName(sandboxName);
  run(`docker stop ${name} 2>/dev/null || true`, { ignoreError: true });
  run(`docker rm ${name} 2>/dev/null || true`, { ignoreError: true });
}

/**
 * Check if the LM Studio sidecar is running.
 */
function isRunning(sandboxName) {
  const name = containerName(sandboxName);
  const state = runCapture(
    `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`,
    { ignoreError: true }
  );
  return state === "running";
}

function getBaseUrl() {
  const { getGatewayIp } = require("./ollama-container");
  return `http://${getGatewayIp()}:1234/v1`;
}

function getProviderName() {
  return "lmstudio-k3s";
}

function getCredential() {
  return "lm-studio";
}

/**
 * List all models currently downloaded in the sidecar.
 * Parses `lms ls` output — extracts LLM model names (skips EMBEDDING section).
 */
function listModels(sandboxName) {
  const name = containerName(sandboxName);
  const output = runCapture(
    `docker exec ${name} lms ls 2>/dev/null`,
    { ignoreError: true }
  );
  if (!output) return [];
  // lms ls output has sections: LLM and EMBEDDING, separated by blank lines
  // Extract model identifiers from the LLM section
  const lines = output.split(/\r?\n/);
  const models = [];
  let inLlmSection = false;
  for (const line of lines) {
    if (/^LLM\b/i.test(line)) { inLlmSection = true; continue; }
    if (/^EMBEDDING\b/i.test(line)) { inLlmSection = false; continue; }
    if (!inLlmSection) continue;
    const trimmed = line.trim();
    if (!trimmed || /^-+$/.test(trimmed) || /^IDENTIFIER/i.test(trimmed)) continue;
    const id = trimmed.split(/\s{2,}/)[0];
    if (id) models.push(id);
  }
  return models;
}

/**
 * Start a model download as a tracked background process.
 */
function downloadModelAsync(sandboxName, model) {
  const name = containerName(sandboxName);
  const proc = spawn("docker", ["exec", name, "lms", "get", model, "--yes"], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  return proc;
}

module.exports = {
  CONTAINER_NAME_PREFIX,
  LMSTUDIO_IMAGE,
  containerName,
  downloadModelAsync,
  getBaseUrl,
  getCredential,
  getProviderName,
  hasModel,
  isRunning,
  listModels,
  loadModel,
  pullModel,
  startLmstudioContainer,
  stopLmstudioContainer,
  validateModel,
  waitForHealth,
  warmupModel,
};
