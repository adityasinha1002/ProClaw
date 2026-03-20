// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  assessNimModels,
  containerName,
  detectGpu,
  getCompatibleModels,
  getImageForModel,
  getRecommendedModels,
  monitorNimStartup,
  resolveRunningNimModel,
  getServedModelForModel,
  listModels,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  type NimRuntime,
} from "./nim.js";

function runtimeWithResponses(
  responses: Record<string, string>,
  commands: string[] = [],
): NimRuntime {
  return {
    exec(command: string): string {
      commands.push(command);
      for (const [pattern, response] of Object.entries(responses)) {
        if (command.includes(pattern)) {
          return response;
        }
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
}

describe("nim helpers", () => {
  it("lists bundled nim models", () => {
    expect(listModels().length).toBeGreaterThan(0);
    expect(listModels()[0]).toHaveProperty("name");
    expect(listModels()[0]).toHaveProperty("image");
    expect(listModels()[0]).toHaveProperty("minGpuMemoryMB");
  });

  it("resolves an image for a known model", () => {
    expect(getImageForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe(
      "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
  });

  it("returns null for an unknown model", () => {
    expect(getImageForModel("bogus/model")).toBeNull();
  });

  it("maps aliased local NIM selections to the live API model id", () => {
    expect(getServedModelForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe("nvidia/nemotron-3-nano");
    expect(getServedModelForModel("z-ai/glm5")).toBe("zai-org/GLM-5");
    expect(getServedModelForModel("nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("builds the managed container name", () => {
    expect(containerName("openclaw")).toBe("nemoclaw-nim-openclaw");
  });

  it("detects an nvidia gpu from nvidia-smi memory output", () => {
    const runtime = runtimeWithResponses({
      "--query-gpu=name": "NVIDIA L40S\nNVIDIA L40S\n",
      "--query-gpu=memory.total": "8192\n8192\n",
    });
    expect(detectGpu(runtime)).toEqual({
      type: "nvidia",
      count: 2,
      totalMemoryMB: 16384,
      perGpuMB: 8192,
      names: ["NVIDIA L40S", "NVIDIA L40S"],
      family: "l40s",
      families: ["l40s"],
      freeDiskGB: null,
      nimCapable: true,
    });
  });

  it("detects apple silicon as not nim-capable", () => {
    const runtime = runtimeWithResponses({
      "SPDisplaysDataType": "Chipset Model: Apple M4 Max\nTotal Number of Cores: 40\n",
      "sysctl -n hw.memsize": String(128 * 1024 * 1024 * 1024),
    });
    expect(detectGpu(runtime)).toEqual({
      type: "apple",
      name: "Apple M4 Max",
      count: 1,
      cores: 40,
      totalMemoryMB: 131072,
      perGpuMB: 131072,
      nimCapable: false,
    });
  });

  it("pulls a nim image", () => {
    const commands: string[] = [];
    const runtime = runtimeWithResponses({}, commands);
    runtime.exec = (command: string) => {
      commands.push(command);
      return "";
    };
    expect(pullNimImage("nvidia/nemotron-3-nano-30b-a3b", runtime)).toBe(
      "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
    expect(commands).toEqual(["docker pull nvcr.io/nim/nvidia/nemotron-3-nano:latest"]);
  });

  it("falls back to the legacy nano image when the official pull target is denied", () => {
    const commands: string[] = [];
    const runtime: NimRuntime = {
      exec(command: string): string {
        commands.push(command);
        if (command.includes("nemotron-3-nano:latest")) {
          const err = new Error("pull denied") as Error & { stderr?: string };
          err.stderr = 'denied: {"errors":[{"code":"DENIED","message":"Access Denied"}]}';
          throw err;
        }
        return "";
      },
    };

    expect(pullNimImage("nvidia/nemotron-3-nano-30b-a3b", runtime)).toBe(
      "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
    );
    expect(commands).toEqual([
      "docker pull nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      "docker pull nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
    ]);
  });

  it("starts a nim container after removing any stale copy", () => {
    const commands: string[] = [];
    const runtime = runtimeWithResponses({}, commands);
    runtime.exec = (command: string) => {
      commands.push(command);
      return "";
    };
    startNimContainer("openclaw", "nvidia/nemotron-3-nano-30b-a3b", runtime);
    expect(commands[0]).toBe("docker rm -f nemoclaw-nim-openclaw 2>/dev/null");
    expect(commands.at(-1)).toBe(
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
  });

  it("mounts a writable cache directory when one with enough space is available", () => {
    const originalCacheDir = process.env.NEMOCLAW_NIM_CACHE_DIR;
    process.env.NEMOCLAW_NIM_CACHE_DIR = "/cache/nim";

    const commands: string[] = [];
    const runtime = runtimeWithResponses(
      {
        "mkdir -p '/cache/nim' && test -w '/cache/nim' && printf ok": "ok",
        "df -Pk '/cache/nim' | awk 'NR==2 {print $4}'": String(400 * 1024 * 1024),
      },
      commands,
    );
    runtime.exec = (command: string) => {
      commands.push(command);
      for (const [pattern, response] of Object.entries({
        "mkdir -p '/cache/nim' && test -w '/cache/nim' && printf ok": "ok",
        "df -Pk '/cache/nim' | awk 'NR==2 {print $4}'": String(400 * 1024 * 1024),
      })) {
        if (command.includes(pattern)) {
          return response;
        }
      }
      return "";
    };

    try {
      startNimContainer("openclaw", "nvidia/nemotron-3-nano-30b-a3b", runtime, 8000, undefined, 32);
    } finally {
      if (originalCacheDir === undefined) delete process.env.NEMOCLAW_NIM_CACHE_DIR;
      else process.env.NEMOCLAW_NIM_CACHE_DIR = originalCacheDir;
    }

    expect(commands).toEqual([
      "docker rm -f nemoclaw-nim-openclaw 2>/dev/null",
      "mkdir -p '/cache/nim' && test -w '/cache/nim' && printf ok",
      "df -Pk '/cache/nim' | awk 'NR==2 {print $4}'",
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g -e NIM_CACHE_PATH='/opt/nim/.cache' -v '/cache/nim':/opt/nim/.cache nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    ]);
  });

  it("passes through NGC and NVIDIA credentials to the nim container when present", () => {
    const originalNgcApiKey = process.env.NGC_API_KEY;
    const originalNvidiaApiKey = process.env.NVIDIA_API_KEY;
    process.env.NGC_API_KEY = "ngc-secret";
    process.env.NVIDIA_API_KEY = "nvapi-secret";

    const commands: string[] = [];
    const runtime = runtimeWithResponses({}, commands);
    runtime.exec = (command: string) => {
      commands.push(command);
      return "";
    };

    try {
      startNimContainer("openclaw", "nvidia/nemotron-3-nano-30b-a3b", runtime);
    } finally {
      if (originalNgcApiKey === undefined) delete process.env.NGC_API_KEY;
      else process.env.NGC_API_KEY = originalNgcApiKey;
      if (originalNvidiaApiKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = originalNvidiaApiKey;
    }

    expect(commands[0]).toBe("docker rm -f nemoclaw-nim-openclaw 2>/dev/null");
    expect(commands.at(-1)).toBe(
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g -e NVIDIA_API_KEY='nvapi-secret' -e NGC_API_KEY='ngc-secret' nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
  });

  it("mirrors NVIDIA_API_KEY into NGC_API_KEY when only NVIDIA_API_KEY is set", () => {
    const originalNgcApiKey = process.env.NGC_API_KEY;
    const originalNvidiaApiKey = process.env.NVIDIA_API_KEY;
    delete process.env.NGC_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-secret";

    const commands: string[] = [];
    const runtime = runtimeWithResponses({}, commands);
    runtime.exec = (command: string) => {
      commands.push(command);
      return "";
    };

    try {
      startNimContainer("openclaw", "nvidia/nemotron-3-nano-30b-a3b", runtime);
    } finally {
      if (originalNgcApiKey === undefined) delete process.env.NGC_API_KEY;
      else process.env.NGC_API_KEY = originalNgcApiKey;
      if (originalNvidiaApiKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = originalNvidiaApiKey;
    }

    expect(commands[0]).toBe("docker rm -f nemoclaw-nim-openclaw 2>/dev/null");
    expect(commands.at(-1)).toBe(
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g -e NVIDIA_API_KEY='nvapi-secret' -e NGC_API_KEY='nvapi-secret' nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
  });

  it("passes health checks when the models endpoint responds", () => {
    const runtime = runtimeWithResponses({
      "curl -sf http://localhost:8000/v1/models": '{"data":[]}',
    });
    expect(waitForNimHealth(runtime, 8000, 1, 0)).toBe(true);
  });

  it("reports a fatal startup error when container logs match a known failure pattern", () => {
    const runtime = runtimeWithResponses({
      "curl -sf http://localhost:8000/v1/models": "",
      "docker inspect --format '{{.State.Status}}' nemoclaw-nim-openclaw": "running",
      "docker logs --tail 120 nemoclaw-nim-openclaw 2>&1":
        "nimlib.exceptions.ManifestDownloadError: Error downloading manifest: error decoding response body",
      "sleep 0": "",
    });
    expect(monitorNimStartup(runtime, "openclaw", 8000, 1, 0)).toMatchObject({
      healthy: false,
      reason: "NIM failed while downloading model files from NGC. This is usually a network or partial-download issue.",
      state: "running",
    });
  });

  it("reports when the container exits before becoming healthy", () => {
    const runtime = runtimeWithResponses({
      "curl -sf http://localhost:8000/v1/models": "",
      "docker inspect --format '{{.State.Status}}' nemoclaw-nim-openclaw": "exited",
      "docker logs --tail 120 nemoclaw-nim-openclaw 2>&1": "container stopped",
      "sleep 0": "",
    });
    expect(monitorNimStartup(runtime, "openclaw", 8000, 1, 0)).toMatchObject({
      healthy: false,
      state: "exited",
    });
  });

  it("reports timeout details when startup never becomes healthy", () => {
    const nowSpy = vi.spyOn(Date, "now");
    {
      const values = [0, 0, 1000, 2000, 2000];
      nowSpy.mockImplementation(() => values.shift() ?? 2000);
    }
    const runtime: NimRuntime = {
      exec(command: string): string {
        if (command.includes("curl -sf http://localhost:8000/v1/models")) return "";
        if (command.includes("docker inspect --format '{{.State.Status}}' nemoclaw-nim-openclaw")) return "running";
        if (command.includes("docker logs --tail 120 nemoclaw-nim-openclaw 2>&1")) return "still downloading";
        if (command.includes("sleep 0")) return "";
        throw new Error(`unexpected command: ${command}`);
      },
    };

    try {
      expect(monitorNimStartup(runtime, "openclaw", 8000, 1, 0, 10)).toMatchObject({
        healthy: false,
        reason: "Local NIM made no startup progress for 1 seconds.",
        detail: "still downloading",
        idleSeconds: 1,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps waiting while logs continue to change and then succeeds", () => {
    const nowSpy = vi.spyOn(Date, "now");
    {
      const values = [0, 0, 500, 1000, 1000, 1500];
      nowSpy.mockImplementation(() => values.shift() ?? 1500);
    }
    let logCalls = 0;
    const runtime: NimRuntime = {
      exec(command: string): string {
        if (command.includes("curl -sf http://localhost:8000/v1/models")) {
          return logCalls >= 2 ? '{"data":[{"id":"nvidia/nemotron-3-nano"}]}' : "";
        }
        if (command.includes("docker inspect --format '{{.State.Status}}' nemoclaw-nim-openclaw")) return "running";
        if (command.includes("docker logs --tail 120 nemoclaw-nim-openclaw 2>&1")) {
          logCalls += 1;
          return `download chunk ${String(logCalls)}`;
        }
        if (command.includes("sleep 0")) return "";
        throw new Error(`unexpected command: ${command}`);
      },
    };

    try {
      expect(monitorNimStartup(runtime, "openclaw", 8000, 1, 0, 10)).toEqual({
        healthy: true,
        state: "running",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns models compatible with the detected machine profile in recommendation order", () => {
    expect(
      getCompatibleModels({
        type: "nvidia",
        count: 1,
        totalMemoryMB: 46068,
        perGpuMB: 46068,
        family: "l40s",
        families: ["l40s"],
        freeDiskGB: 120,
        nimCapable: true,
      }).map((model) => model.name),
    ).toEqual(["nvidia/nemotron-3-nano-30b-a3b"]);
  });

  it("classifies local NIM models as recommended, supported, or unsupported with reasons", () => {
    const assessments = assessNimModels({
      type: "nvidia",
      count: 1,
      totalMemoryMB: 46068,
      perGpuMB: 46068,
      family: "l40s",
      families: ["l40s"],
      freeDiskGB: 120,
      nimCapable: true,
    });

    expect(assessments[0]?.model.name).toBe("nvidia/nemotron-3-nano-30b-a3b");
    expect(assessments[0]?.status).toBe("recommended");
    expect(assessments[0]?.reason).toContain("Recommended on l40s");
    expect(assessments.some((assessment) => assessment.status === "unsupported")).toBe(true);
    expect(assessments.find((assessment) => assessment.model.name === "openai/gpt-oss-20b")?.reason).toContain(
      "published support",
    );
  });

  it("returns only recommended models from the assessment list", () => {
    expect(
      getRecommendedModels({
        type: "nvidia",
        count: 1,
        totalMemoryMB: 46068,
        perGpuMB: 46068,
        family: "l40s",
        families: ["l40s"],
        freeDiskGB: 120,
        nimCapable: true,
      }).map((model) => model.name),
    ).toEqual(["nvidia/nemotron-3-nano-30b-a3b"]);
  });

  it("resolves the running model id from the local NIM models endpoint", () => {
    const runtime = runtimeWithResponses({
      "curl -sf http://localhost:8000/v1/models":
        '{"data":[{"id":"zai-org/GLM-5"}]}',
    });
    expect(resolveRunningNimModel(runtime, "z-ai/glm5")).toBe("zai-org/GLM-5");
  });
});
