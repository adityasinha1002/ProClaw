// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  getDefaultOllamaModel,
  getHostUrl,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  getWsl2HostIp,
  isOllamaBoundToAllInterfaces,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
} from "../bin/lib/local-inference";

import { isWsl } from "../bin/lib/platform";

// The host URL varies by platform: WSL2 uses eth0 IP, others use host.openshell.internal
const hostUrl = getHostUrl();

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    expect(getLocalProviderBaseUrl("vllm-local")).toBe(`${hostUrl}:8000/v1`);
  });

  it("returns the expected base URL for ollama-local", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe(`${hostUrl}:11434/v1`);
  });

  it("returns the expected base URL for lmstudio-local", () => {
    expect(getLocalProviderBaseUrl("lmstudio-local")).toBe(`${hostUrl}:1234/v1`);
  });

  it("returns the expected health check command for ollama-local", () => {
    expect(getLocalProviderHealthCheck("ollama-local")).toBe("curl -sf http://localhost:11434/api/tags 2>/dev/null");
  });

  it("returns the expected health check command for lmstudio-local", () => {
    expect(getLocalProviderHealthCheck("lmstudio-local")).toBe("curl -sf http://localhost:1234/v1/models 2>/dev/null");
  });

  it("returns the expected container reachability command for ollama-local", () => {
    const cmd = getLocalProviderContainerReachabilityCheck("ollama-local");
    expect(cmd).toMatch(/docker run --rm/);
    expect(cmd).toMatch(/:11434\/api\/tags/);
    expect(cmd).toMatch(new RegExp(CONTAINER_REACHABILITY_IMAGE));
    if (isWsl()) {
      expect(cmd).toMatch(/--add-host host\.docker\.internal:host-gateway/);
      expect(cmd).toMatch(/host\.docker\.internal:11434/);
    } else {
      expect(cmd).toMatch(/--add-host host\.openshell\.internal:host-gateway/);
    }
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return '{"models":[]}';
    });
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:11434/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"models":[]}' : "";
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/containers cannot reach it/);
    expect(result.message).toMatch(/0\.0\.0\.0:11434/);
  });

  it("returns a clear error when lmstudio-local is unavailable", () => {
    const result = validateLocalProvider("lmstudio-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:1234/);
  });

  it("returns a clear error when lmstudio-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("lmstudio-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"data":[]}' : "";
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/containers cannot reach it/);
    expect(result.message).toMatch(/0\.0\.0\.0:1234/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("parses model names from ollama list output", () => {
    expect(parseOllamaList(
      [
        "NAME                        ID              SIZE      MODIFIED",
        "nemotron-3-nano:30b         abc123          24 GB     2 hours ago",
        "qwen3:32b                   def456          20 GB     1 day ago",
      ].join("\n"),
    )).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("returns parsed ollama model options when available", () => {
    expect(
      getOllamaModelOptions(() => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now")
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("falls back to the default ollama model when list output is empty", () => {
    expect(getOllamaModelOptions(() => "")).toEqual([DEFAULT_OLLAMA_MODEL]);
  });

  it("prefers the default ollama model when present", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now")
    ).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("falls back to the first listed ollama model when the default is absent", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\ngemma3:4b  def  3 GB  now")
    ).toBe("qwen3:32b");
  });

  it("builds a background warmup command for ollama models", () => {
    const command = getOllamaWarmupCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^nohup curl -s http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
    expect(command).toMatch(/"keep_alive":"15m"/);
  });

  it("builds a foreground probe command for ollama models", () => {
    const command = getOllamaProbeCommand("nemotron-3-nano:30b");
    expect(command).toMatch(/^curl -sS --max-time 120 http:\/\/localhost:11434\/api\/generate /);
    expect(command).toMatch(/"model":"nemotron-3-nano:30b"/);
  });

  it("fails ollama model validation when the probe times out or returns nothing", () => {
    const result = validateOllamaModel("nemotron-3-nano:30b", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not answer the local probe in time/);
  });

  it("fails ollama model validation when Ollama returns an error payload", () => {
    const result = validateOllamaModel(
      "gabegoodhart/minimax-m2.1:latest",
      () => JSON.stringify({ error: "model requires more system memory" }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/requires more system memory/);
  });

  it("passes ollama model validation when the probe returns a normal payload", () => {
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => JSON.stringify({ model: "nemotron-3-nano:30b", response: "hello", done: true }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("WSL2 networking", () => {
  it("getHostUrl returns a URL string", () => {
    expect(getHostUrl()).toMatch(/^http:\/\//);
  });

  it("getWsl2HostIp returns an IP on WSL2 or empty string otherwise", () => {
    const ip = getWsl2HostIp();
    if (isWsl()) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    } else {
      expect(ip).toBe("");
    }
  });
});

describe("Ollama binding check", () => {
  it("returns true when ss output shows 0.0.0.0 binding", () => {
    expect(isOllamaBoundToAllInterfaces(
      () => "LISTEN  0  4096  0.0.0.0:11434  *:*\nok",
    )).toBe(true);
  });

  it("returns false when ss output does not match", () => {
    expect(isOllamaBoundToAllInterfaces(() => "")).toBeFalsy();
  });

  it("returns true when ss output shows wildcard binding", () => {
    expect(isOllamaBoundToAllInterfaces(
      () => "LISTEN  0  4096  *:11434  *:*\nok",
    )).toBe(true);
  });
});

describe("ollama-k3s sidecar provider", () => {
  it("returns gateway IP base URL for ollama-k3s", () => {
    const url = getLocalProviderBaseUrl("ollama-k3s");
    expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:11434\/v1$/);
  });

  it("ollama-k3s base URL does not depend on host URL or WSL2 IP", () => {
    const url = getLocalProviderBaseUrl("ollama-k3s");
    expect(url).not.toContain("host.docker.internal");
    expect(url).not.toContain("host.openshell.internal");
  });

  it("validateLocalProvider skips host-networking checks for ollama-k3s", () => {
    let called = false;
    const result = validateLocalProvider("ollama-k3s", () => {
      called = true;
      return "";
    });
    expect(result).toEqual({ ok: true });
    expect(called).toBe(false);
  });
});

describe("lmstudio-k3s sidecar provider", () => {
  it("returns gateway IP base URL for lmstudio-k3s", () => {
    const url = getLocalProviderBaseUrl("lmstudio-k3s");
    expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:1234\/v1$/);
  });

  it("lmstudio-k3s base URL does not depend on host URL", () => {
    const url = getLocalProviderBaseUrl("lmstudio-k3s");
    expect(url).not.toContain("host.docker.internal");
    expect(url).not.toContain("host.openshell.internal");
  });

  it("validateLocalProvider skips host-networking checks for lmstudio-k3s", () => {
    let called = false;
    const result = validateLocalProvider("lmstudio-k3s", () => {
      called = true;
      return "";
    });
    expect(result).toEqual({ ok: true });
    expect(called).toBe(false);
  });
});
