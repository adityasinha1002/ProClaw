// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  containerName,
  detectGpu,
  getImageForModel,
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
      "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
    );
  });

  it("returns null for an unknown model", () => {
    expect(getImageForModel("bogus/model")).toBeNull();
  });

  it("builds the managed container name", () => {
    expect(containerName("openclaw")).toBe("nemoclaw-nim-openclaw");
  });

  it("detects an nvidia gpu from nvidia-smi memory output", () => {
    const runtime = runtimeWithResponses({
      "--query-gpu=memory.total": "8192\n8192\n",
    });
    expect(detectGpu(runtime)).toEqual({
      type: "nvidia",
      count: 2,
      totalMemoryMB: 16384,
      perGpuMB: 8192,
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
      "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
    );
    expect(commands).toEqual(["docker pull nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"]);
  });

  it("falls back to an alternate pull target when the primary image is denied", () => {
    const commands: string[] = [];
    const runtime: NimRuntime = {
      exec(command: string): string {
        commands.push(command);
        if (command.includes("nemotron-3-nano-30b-a3b:latest")) {
          const err = new Error("pull denied") as Error & { stderr?: string };
          err.stderr = 'denied: {"errors":[{"code":"DENIED","message":"Access Denied"}]}';
          throw err;
        }
        return "";
      },
    };

    expect(pullNimImage("nvidia/nemotron-3-nano-30b-a3b", runtime)).toBe(
      "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    );
    expect(commands).toEqual([
      "docker pull nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
      "docker pull nvcr.io/nim/nvidia/nemotron-3-nano:latest",
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
    expect(commands).toEqual([
      "docker rm -f nemoclaw-nim-openclaw 2>/dev/null",
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
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

    expect(commands).toEqual([
      "docker rm -f nemoclaw-nim-openclaw 2>/dev/null",
      "docker run -d --gpus all -p 8000:8000 --name nemoclaw-nim-openclaw --shm-size 16g -e NGC_API_KEY='ngc-secret' -e NVIDIA_API_KEY='nvapi-secret' nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
    ]);
  });

  it("passes health checks when the models endpoint responds", () => {
    const runtime = runtimeWithResponses({
      "curl -sf http://localhost:8000/v1/models": '{"data":[]}',
    });
    expect(waitForNimHealth(runtime, 8000, 1, 0)).toBe(true);
  });
});
