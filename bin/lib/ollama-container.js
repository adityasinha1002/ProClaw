// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama Docker sidecar — runs ollama/ollama as a Docker container sharing the
// OpenShell gateway's network namespace.  This avoids all host-networking
// issues (eth0 IP, 0.0.0.0 binding, host.docker.internal) because the
// container shares localhost with the gateway and its k3s cluster.

const { run, runCapture } = require("./runner");
const { parseOllamaList, shellQuote } = require("./local-inference");
const { spawn } = require("child_process");

const OLLAMA_IMAGE = "ollama/ollama";
const CONTAINER_NAME_PREFIX = "nemoclaw-ollama";
const GATEWAY_CONTAINER_PREFIX = "openshell-cluster-nemoclaw";

function containerName(sandboxName) {
  return `${CONTAINER_NAME_PREFIX}-${sandboxName || "default"}`;
}

/**
 * Find the running OpenShell gateway container name.
 */
function findGatewayContainer() {
  const output = runCapture(
    `docker ps --filter "name=${GATEWAY_CONTAINER_PREFIX}" --format '{{.Names}}' 2>/dev/null`,
    { ignoreError: true }
  );
  if (!output) return null;
  // Take the first match
  return output.split("\n").map((l) => l.trim()).filter(Boolean)[0] || null;
}

/**
 * Start the Ollama sidecar container sharing the gateway's network namespace.
 * Uses --gpus all for GPU acceleration on WSL2/Linux.
 */
function startOllamaContainer(sandboxName) {
  const name = containerName(sandboxName);
  const gateway = findGatewayContainer();
  if (!gateway) {
    console.error("  Cannot find OpenShell gateway container. Is the gateway running?");
    process.exit(1);
  }

  // Remove any stale container with the same name
  run(`docker rm -f ${name} 2>/dev/null || true`, { ignoreError: true });

  // Detect whether --gpus all is supported — use host nvidia-smi first (instant),
  // fall back to container probe only if needed (avoids pulling a 4GB image).
  const hasGpu = !!runCapture("nvidia-smi -L 2>/dev/null", { ignoreError: true });
  const gpuFlag = hasGpu ? "--gpus all" : "";

  run(
    `docker run -d ${gpuFlag} --network container:${gateway} ` +
    `-v nemoclaw-ollama-models:/root/.ollama ` +
    `--name ${name} ${OLLAMA_IMAGE}`,
    { ignoreError: false }
  );

  return name;
}

/**
 * Wait for the Ollama sidecar to become healthy (respond on port 11434).
 * Since it shares the gateway's network, we check via docker exec.
 */
function waitForOllamaHealth(sandboxName, timeout = 60) {
  const name = containerName(sandboxName);
  const start = Date.now();

  while ((Date.now() - start) / 1000 < timeout) {
    // Use `ollama list` as health check — the ollama/ollama image has no curl/wget.
    const result = runCapture(
      `docker exec ${name} ollama list 2>/dev/null`,
      { ignoreError: true }
    );
    if (result !== undefined && result !== null && result !== "") return true;
    require("child_process").spawnSync("sleep", ["2"]);
  }
  return false;
}

/**
 * Pull a model inside the Ollama sidecar container.
 */
function pullModel(sandboxName, model) {
  const name = containerName(sandboxName);
  run(`docker exec ${name} ollama pull ${shellQuote(model)}`, { ignoreError: false });
}

/**
 * Check if a model is already available in the sidecar.
 * Uses parseOllamaList for exact matching (not substring).
 */
function hasModel(sandboxName, model) {
  const name = containerName(sandboxName);
  const output = runCapture(
    `docker exec ${name} ollama list 2>/dev/null`,
    { ignoreError: true }
  );
  const models = parseOllamaList(output);
  return models.includes(model);
}

/**
 * Prime/warmup a model inside the sidecar to keep it loaded in VRAM.
 */
function warmupModel(sandboxName, model, keepAlive = "15m") {
  const name = containerName(sandboxName);
  run(
    `docker exec ${name} ollama run ${shellQuote(model)} "hello" --keepalive ${shellQuote(keepAlive)} > /dev/null 2>&1`,
    { ignoreError: true }
  );
}

/**
 * Validate that the model responds to a probe inside the sidecar.
 */
function validateModel(sandboxName, model, timeoutSeconds = 120) {
  const name = containerName(sandboxName);
  const output = runCapture(
    `timeout ${timeoutSeconds} docker exec ${name} ollama run ${shellQuote(model)} "hello" --keepalive 15m 2>&1`,
    { ignoreError: true }
  );
  if (!output) {
    return {
      ok: false,
      message:
        `Ollama model '${model}' did not answer the probe in time. ` +
        "It may still be loading, too large for the GPU, or otherwise unhealthy.",
    };
  }
  if (output.includes("Error:") || output.includes("error:")) {
    const errorLine = output.split("\n").find((l) => /[Ee]rror/.test(l)) || output.slice(0, 200);
    return { ok: false, message: `Ollama model '${model}' probe failed: ${errorLine.trim()}` };
  }
  return { ok: true };
}

/**
 * Stop and remove the Ollama sidecar container.
 */
function stopOllamaContainer(sandboxName) {
  const name = containerName(sandboxName);
  run(`docker stop ${name} 2>/dev/null || true`, { ignoreError: true });
  run(`docker rm ${name} 2>/dev/null || true`, { ignoreError: true });
}

/**
 * Check if the Ollama sidecar is running.
 */
function isOllamaContainerRunning(sandboxName) {
  const name = containerName(sandboxName);
  const state = runCapture(
    `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`,
    { ignoreError: true }
  );
  return state === "running";
}

/**
 * Get the gateway container's IP address on the Docker network.
 * k3s pods reach the sidecar via this IP (not 127.0.0.1, which is the pod's
 * own loopback). The sidecar shares the gateway's network namespace, so
 * the gateway IP + sidecar port routes correctly.
 */
function getGatewayIp() {
  const gateway = findGatewayContainer();
  if (!gateway) return "127.0.0.1"; // fallback
  const ip = runCapture(
    `docker inspect ${gateway} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null`,
    { ignoreError: true }
  );
  return ip || "127.0.0.1";
}

function getSidecarBaseUrl() {
  return `http://${getGatewayIp()}:11434/v1`;
}

/**
 * List all models currently downloaded in the sidecar.
 * Returns an array of model names (e.g., ["nemotron-3-nano:30b", "qwen3:0.6b"]).
 */
function listModels(sandboxName) {
  const name = containerName(sandboxName);
  const output = runCapture(
    `docker exec ${name} ollama list 2>/dev/null`,
    { ignoreError: true }
  );
  return parseOllamaList(output);
}

/**
 * Start a model download as a tracked background process.
 * Returns the child process handle — caller can check proc.exitCode and poll hasModel().
 */
function downloadModelAsync(sandboxName, model) {
  const name = containerName(sandboxName);
  const proc = spawn("docker", ["exec", name, "ollama", "pull", model], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  return proc;
}

module.exports = {
  CONTAINER_NAME_PREFIX,
  OLLAMA_IMAGE,
  containerName,
  downloadModelAsync,
  findGatewayContainer,
  getGatewayIp,
  getSidecarBaseUrl,
  hasModel,
  isOllamaContainerRunning,
  listModels,
  pullModel,
  startOllamaContainer,
  stopOllamaContainer,
  validateModel,
  waitForOllamaHealth,
  warmupModel,
};
