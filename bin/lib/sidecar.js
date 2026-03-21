// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sidecar dispatcher — unified interface for Docker sidecar inference providers.
// Maps provider keys ("ollama-k3s", "lmstudio-k3s") to their container modules.

const ollamaContainer = require("./ollama-container");
const lmstudioContainer = require("./lmstudio-container");

const SIDECARS = {
  "ollama-k3s": {
    start: ollamaContainer.startOllamaContainer,
    waitForHealth: ollamaContainer.waitForOllamaHealth,
    pullModel: ollamaContainer.pullModel,
    hasModel: ollamaContainer.hasModel,
    listModels: ollamaContainer.listModels,
    downloadModelAsync: ollamaContainer.downloadModelAsync,
    loadModel: () => true,  // Ollama auto-loads on first inference
    validateModel: ollamaContainer.validateModel,
    warmupModel: ollamaContainer.warmupModel,
    stop: ollamaContainer.stopOllamaContainer,
    isRunning: ollamaContainer.isOllamaContainerRunning,
    getBaseUrl: ollamaContainer.getSidecarBaseUrl,
    getProviderName: () => "ollama-k3s",
    getCredential: () => "ollama",
    containerName: ollamaContainer.containerName,
    label: "Ollama",
    starterModels: [
      { model: "nemotron-3-nano:30b", label: "Nemotron 3 Nano 30B (18 GB)" },
    ],
    // Ollama model IDs are the same for pull and API
    getApiModelId: (model) => model,
    getPullArgs: (containerName, model) => ["docker", "exec", containerName, "ollama", "pull", model],
  },
  "lmstudio-k3s": {
    start: lmstudioContainer.startLmstudioContainer,
    waitForHealth: lmstudioContainer.waitForHealth,
    pullModel: lmstudioContainer.pullModel,
    hasModel: lmstudioContainer.hasModel,
    listModels: lmstudioContainer.listModels,
    downloadModelAsync: lmstudioContainer.downloadModelAsync,
    loadModel: lmstudioContainer.loadModel,
    validateModel: lmstudioContainer.validateModel,
    warmupModel: lmstudioContainer.warmupModel,
    stop: lmstudioContainer.stopLmstudioContainer,
    isRunning: lmstudioContainer.isRunning,
    getBaseUrl: lmstudioContainer.getBaseUrl,
    getProviderName: () => "lmstudio-k3s",
    getCredential: () => "lm-studio",
    containerName: lmstudioContainer.containerName,
    label: "LM Studio",
    // Nano-4B: nemotron_h arch, NOT supported by llama.cpp/LM Studio yet.
    // Nano-30B MoE Q4_K_M: 24.5GB, exceeds RTX 4090's 24GB VRAM.
    // OpenReasoning-7B: Qwen2 arch, works but slow (reasoning-focused, not chat).
    starterModels: [
      { model: "openreasoning-nemotron-7b@q4_k_m",       label: "OpenReasoning Nemotron 7B (5 GB, reasoning)" },
    ],
    // LM Studio uses "name@quant" for download but API model ID is just "name"
    getApiModelId: (model) => model.split("@")[0],
    getPullArgs: (containerName, model) => ["docker", "exec", containerName, "lms", "get", model, "--yes"],
  },
};

function getSidecar(providerKey) {
  return SIDECARS[providerKey] || null;
}

function isSidecarProvider(providerKey) {
  return providerKey in SIDECARS;
}

/**
 * Synchronous poll for background model download completion.
 * Checks both process exit status and hasModel() from the container.
 */
function awaitModelDownload(proc, sidecar, sandboxName, model, timeout = 600) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeout) {
    // Check if model is available first (may appear before process exits cleanly)
    if (sidecar.hasModel(sandboxName, model)) {
      try { proc.kill(); } catch {}
      return true;
    }
    // Then check if process exited with failure
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      return false;
    }
    require("child_process").spawnSync("sleep", ["5"]);
  }
  try { proc.kill(); } catch {}
  return false;
}

module.exports = {
  SIDECARS,
  awaitModelDownload,
  getSidecar,
  isSidecarProvider,
};
