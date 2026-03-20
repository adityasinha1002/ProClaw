// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HOST_GATEWAY_URL = "http://host.openshell.internal";
export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
export const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

export interface LocalProviderValidation {
  ok: boolean;
  message?: string;
}

type LocalProvider = "nim-local" | "ollama-local" | "vllm-local";
type RunCapture = (command: string) => string;

export function getLocalProviderBaseUrl(provider: LocalProvider): string {
  switch (provider) {
    case "nim-local":
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:8000/v1`;
    case "ollama-local":
      return `${HOST_GATEWAY_URL}:11434/v1`;
  }
}

export function getLocalProviderHealthCheck(provider: LocalProvider): string {
  switch (provider) {
    case "nim-local":
    case "vllm-local":
      return "curl -sf http://localhost:8000/v1/models 2>/dev/null";
    case "ollama-local":
      return "curl -sf http://localhost:11434/api/tags 2>/dev/null";
  }
}

export function getLocalProviderContainerReachabilityCheck(provider: LocalProvider): string {
  switch (provider) {
    case "nim-local":
    case "vllm-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
    case "ollama-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`;
  }
}

export function validateLocalProvider(
  provider: LocalProvider,
  runCapture: RunCapture,
): LocalProviderValidation {
  const output = runCapture(getLocalProviderHealthCheck(provider));
  if (!output) {
    switch (provider) {
      case "nim-local":
        return {
          ok: false,
          message: "Local NIM was selected, but nothing is responding on http://localhost:8000.",
        };
      case "vllm-local":
        return {
          ok: false,
          message: "Local vLLM was selected, but nothing is responding on http://localhost:8000.",
        };
      case "ollama-local":
        return {
          ok: false,
          message: "Local Ollama was selected, but nothing is responding on http://localhost:11434.",
        };
    }
  }

  const containerOutput = runCapture(getLocalProviderContainerReachabilityCheck(provider));
  if (containerOutput) {
    return { ok: true };
  }

  switch (provider) {
    case "nim-local":
      return {
        ok: false,
        message:
          "Local NIM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the NIM container publishes port 8000 and the host gateway alias is available to sandboxes.",
      };
    case "vllm-local":
      return {
        ok: false,
        message:
          "Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the server is reachable from containers, not only from the host shell.",
      };
    case "ollama-local":
      return {
        ok: false,
        message:
          "Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:11434. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.",
      };
  }
}

export function parseOllamaList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

export function getOllamaModelOptions(runCapture: RunCapture): string[] {
  const parsed = parseOllamaList(runCapture("ollama list 2>/dev/null"));
  return parsed.length > 0 ? parsed : [DEFAULT_OLLAMA_MODEL];
}

export function getDefaultOllamaModel(runCapture: RunCapture): string {
  const models = getOllamaModelOptions(runCapture);
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}
