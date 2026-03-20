// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NemoClawConfig, PluginLogger } from "../index.js";
import type { ValidationResult } from "../onboard/validate.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  describeOnboardEndpoint: vi.fn(() => "nim-local (http://host.openshell.internal:8000/v1)"),
  describeOnboardProvider: vi.fn(() => "Local NIM"),
  loadOnboardConfig: vi.fn(() => null),
  saveOnboardConfig: vi.fn(),
}));

vi.mock("../onboard/prompt.js", () => ({
  promptInput: vi.fn(),
  promptConfirm: vi.fn(),
  promptSelect: vi.fn(),
}));

vi.mock("../onboard/validate.js", () => ({
  validateApiKey: vi.fn(),
  maskApiKey: vi.fn((apiKey: string) => `masked:${apiKey.slice(-4)}`),
}));

vi.mock("../onboard/local-inference.js", () => ({
  DEFAULT_OLLAMA_MODEL: "nemotron-3-nano:30b",
  getDefaultOllamaModel: vi.fn(() => "nemotron-3-nano:30b"),
  getLocalProviderBaseUrl: vi.fn((provider: string) =>
    provider === "ollama-local"
      ? "http://host.openshell.internal:11434/v1"
      : "http://host.openshell.internal:8000/v1",
  ),
  getOllamaModelOptions: vi.fn(() => ["nemotron-3-nano:30b"]),
  validateLocalProvider: vi.fn(() => ({ ok: true })),
}));

vi.mock("../onboard/nim.js", () => ({
  createNimRuntime: vi.fn(() => ({ exec: vi.fn() })),
  detectGpu: vi.fn(() => ({
    type: "nvidia",
    count: 1,
    totalMemoryMB: 65536,
    perGpuMB: 65536,
    nimCapable: true,
  })),
  listModels: vi.fn(() => [
    {
      name: "nvidia/nemotron-3-nano-30b-a3b",
      image: "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      minGpuMemoryMB: 8192,
    },
    {
      name: "nvidia/nemotron-3-super-120b-a12b",
      image: "nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b:latest",
      minGpuMemoryMB: 40960,
    },
  ]),
  assessNimModels: vi.fn(() => [
    {
      model: {
        name: "nvidia/nemotron-3-nano-30b-a3b",
        image: "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
        minGpuMemoryMB: 32768,
        recommendedFor: ["general", "chat", "tool-use"],
      },
      status: "recommended",
      score: 100,
      reason: "Recommended for this machine via 1x l40s FP8, 32 GB disk.",
    },
    {
      model: {
        name: "nvidia/nemotron-3-super-120b-a12b",
        image: "nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b:latest",
        minGpuMemoryMB: 184320,
        recommendedFor: ["general", "tool-use", "quality"],
      },
      status: "unsupported",
      score: Number.NEGATIVE_INFINITY,
      reason: "Needs 2 GPUs.",
    },
  ]),
  getCompatibleModels: vi.fn(() => [
    {
      name: "nvidia/nemotron-3-nano-30b-a3b",
      image: "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      minGpuMemoryMB: 32768,
      recommendedFor: ["general", "chat", "tool-use"],
    },
    {
      name: "nvidia/nemotron-3-super-120b-a12b",
      image: "nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b:latest",
      minGpuMemoryMB: 184320,
      recommendedFor: ["general", "tool-use", "quality"],
    },
  ]),
  getServedModelForModel: vi.fn((model: string) =>
    model === "nvidia/nemotron-3-nano-30b-a3b" ? "nvidia/nemotron-3-nano" : model,
  ),
  resolveRunningNimModel: vi.fn((_: unknown, model: string) =>
    model === "nvidia/nemotron-3-nano-30b-a3b" ? "nvidia/nemotron-3-nano" : model,
  ),
  monitorNimStartup: vi.fn(() => ({ healthy: true, state: "running" })),
  pullNimImage: vi.fn(() => "nvcr.io/nim/nvidia/nemotron-3-nano:latest"),
  startNimContainer: vi.fn(() => "nemoclaw-nim-openclaw"),
  waitForNimHealth: vi.fn(() => true),
}));

const childProcess = await import("node:child_process");
const onboardConfig = await import("../onboard/config.js");
const onboardingValidate = await import("../onboard/validate.js");
const localInference = await import("../onboard/local-inference.js");
const nim = await import("../onboard/nim.js");
const { cliOnboard } = await import("./onboard.js");

const pluginConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function createLogger(lines: string[] = []): PluginLogger {
  return {
    info(message: string) {
      lines.push(message);
    },
    warn(message: string) {
      lines.push(`WARN:${message}`);
    },
    error(message: string) {
      lines.push(`ERROR:${message}`);
    },
    debug() {},
  };
}

function validationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    models: ["nvidia/nemotron-3-super-120b-a12b"],
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(onboardConfig.loadOnboardConfig).mockReturnValue(null);
  vi.mocked(onboardingValidate.validateApiKey).mockResolvedValue(validationResult());
  vi.mocked(localInference.getLocalProviderBaseUrl).mockImplementation((provider: string) =>
    provider === "ollama-local"
      ? "http://host.openshell.internal:11434/v1"
      : "http://host.openshell.internal:8000/v1",
  );
  vi.mocked(localInference.validateLocalProvider).mockReturnValue({ ok: true });
  vi.mocked(nim.detectGpu).mockReturnValue({
    type: "nvidia",
    count: 1,
    totalMemoryMB: 65536,
    perGpuMB: 65536,
    nimCapable: true,
  });
  vi.mocked(nim.pullNimImage).mockReturnValue("nvcr.io/nim/nvidia/nemotron-3-nano:latest");
  vi.mocked(nim.monitorNimStartup).mockReturnValue({ healthy: true, state: "running" });
  vi.mocked(childProcess.execFileSync).mockImplementation(((_file: string, args?: readonly string[] | undefined) => {
    if (Array.isArray(args) && args[0] === "inference" && args[1] === "get") {
      return JSON.stringify({
        provider: "nim-local",
        model: "nvidia/nemotron-3-nano",
        endpoint: "http://host.openshell.internal:8000/v1",
      });
    }
    return "";
  }) as typeof childProcess.execFileSync);
  vi.mocked(childProcess.execSync).mockImplementation((command: string) => {
    if (String(command).includes("command -v docker")) return "";
    if (String(command).includes("docker info")) return "";
    return "";
  });
});

describe("cliOnboard", () => {
  it("configures nim-local with host routing and dummy openai credentials", async () => {
    const lines: string[] = [];
    const logger = createLogger(lines);

    await cliOnboard({
      endpoint: "nim-local",
      model: "nvidia/nemotron-3-nano-30b-a3b",
      apiKey: "nvapi-local-nim",
      logger,
      pluginConfig,
    });

    expect(nim.pullNimImage).toHaveBeenCalledWith(
      "nvidia/nemotron-3-nano-30b-a3b",
      expect.any(Object),
    );
    expect(nim.startNimContainer).toHaveBeenCalledWith(
      "openclaw",
      "nvidia/nemotron-3-nano-30b-a3b",
      expect.any(Object),
      8000,
      "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      undefined,
    );
    expect(localInference.validateLocalProvider).toHaveBeenCalledWith(
      "nim-local",
      expect.any(Function),
    );
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(
      1,
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "nim-local",
        "--type",
        "openai",
        "--credential",
        "OPENAI_API_KEY=dummy",
        "--config",
        "OPENAI_BASE_URL=http://host.openshell.internal:8000/v1",
      ],
      expect.any(Object),
    );
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(
      2,
      "openshell",
      ["inference", "set", "--provider", "nim-local", "--model", "nvidia/nemotron-3-nano"],
      expect.any(Object),
    );
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(
      3,
      "openshell",
      ["inference", "get", "--json"],
      expect.any(Object),
    );
    expect(onboardConfig.saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointType: "nim-local",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: "OPENAI_API_KEY",
        provider: "nim-local",
        model: "nvidia/nemotron-3-nano",
      }),
    );
    expect(lines.join("\n")).toContain("Inference route set: nim-local -> nvidia/nemotron-3-nano");
    expect(lines.join("\n")).toContain("Verified inference route: nim-local -> nvidia/nemotron-3-nano");
  });

  it("stops before provider creation when local nim does not become healthy", async () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    vi.mocked(nim.monitorNimStartup).mockReturnValue({
      healthy: false,
      reason: "Local NIM did not become healthy on http://localhost:8000/v1.",
      detail: "download still in progress",
      state: "running",
    });

    await cliOnboard({
      endpoint: "nim-local",
      model: "nvidia/nemotron-3-nano-30b-a3b",
      apiKey: "nvapi-local-nim",
      logger,
      pluginConfig,
    });

    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(onboardConfig.saveOnboardConfig).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("ERROR:Local NIM did not become healthy on http://localhost:8000/v1.");
  });

  it("creates the cloud provider with the supplied NVIDIA API key", async () => {
    const logger = createLogger();
    vi.mocked(childProcess.execFileSync).mockImplementation(((_file: string, args?: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === "inference" && args[1] === "get") {
        return JSON.stringify({
          provider: "nvidia-nim",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpoint: "https://integrate.api.nvidia.com/v1",
        });
      }
      return "";
    }) as typeof childProcess.execFileSync);

    await cliOnboard({
      endpoint: "build",
      model: "nvidia/nemotron-3-super-120b-a12b",
      apiKey: "nvapi-test-key",
      logger,
      pluginConfig,
    });

    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(
      1,
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "nvidia-nim",
        "--type",
        "openai",
        "--credential",
        "NVIDIA_API_KEY=nvapi-test-key",
        "--config",
        "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1",
      ],
      expect.any(Object),
    );
    expect(childProcess.execFileSync).toHaveBeenNthCalledWith(
      2,
      "openshell",
      [
        "inference",
        "set",
        "--provider",
        "nvidia-nim",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      expect.any(Object),
    );
  });

  it("fails onboarding if the configured inference route does not match the requested provider", async () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    vi.mocked(childProcess.execFileSync).mockImplementation(((_file: string, args?: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === "inference" && args[1] === "get") {
        return JSON.stringify({
          provider: "nvidia-nim",
          model: "nvidia/nemotron-3-super-120b-a12b",
        });
      }
      return "";
    }) as typeof childProcess.execFileSync);

    await cliOnboard({
      endpoint: "nim-local",
      model: "nvidia/nemotron-3-nano-30b-a3b",
      logger,
      pluginConfig,
    });

    expect(onboardConfig.saveOnboardConfig).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(
      "ERROR:Inference route verification mismatch. Expected nim-local -> nvidia/nemotron-3-nano, got nvidia-nim -> nvidia/nemotron-3-super-120b-a12b.",
    );
  });
});
