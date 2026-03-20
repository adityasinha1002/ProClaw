// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaModelOptions,
  parseOllamaList,
  validateLocalProvider,
} from "./local-inference.js";

describe("local inference helpers", () => {
  it("returns the expected base URL for nim-local", () => {
    expect(getLocalProviderBaseUrl("nim-local")).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the expected base URL for ollama-local", () => {
    expect(getLocalProviderBaseUrl("ollama-local")).toBe("http://host.openshell.internal:11434/v1");
  });

  it("returns the expected health check command for nim-local", () => {
    expect(getLocalProviderHealthCheck("nim-local")).toBe(
      "curl -sf http://localhost:8000/v1/models 2>/dev/null",
    );
  });

  it("returns the expected container reachability command for nim-local", () => {
    expect(getLocalProviderContainerReachabilityCheck("nim-local")).toBe(
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`,
    );
  });

  it("validates a reachable local nim provider", () => {
    let callCount = 0;
    expect(
      validateLocalProvider("nim-local", () => {
        callCount += 1;
        return '{"data":[]}';
      }),
    ).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("returns a clear error when nim-local is unavailable", () => {
    const result = validateLocalProvider("nim-local", () => "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http:\/\/localhost:8000/);
  });

  it("returns a clear error when nim-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("nim-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"data":[]}' : "";
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.openshell\.internal:8000/);
  });

  it("parses model names from ollama list output", () => {
    expect(
      parseOllamaList(
        [
          "NAME                        ID              SIZE      MODIFIED",
          "nemotron-3-nano:30b         abc123          24 GB     2 hours ago",
          "qwen3:32b                   def456          20 GB     1 day ago",
        ].join("\n"),
      ),
    ).toEqual(["nemotron-3-nano:30b", "qwen3:32b"]);
  });

  it("returns parsed ollama model options when available", () => {
    expect(getOllamaModelOptions(() => "nemotron-3-nano:30b  abc  24 GB  now\nqwen3:32b  def  20 GB  now")).toEqual([
      "nemotron-3-nano:30b",
      "qwen3:32b",
    ]);
  });

  it("falls back to the default ollama model when list output is empty", () => {
    expect(getOllamaModelOptions(() => "")).toEqual([DEFAULT_OLLAMA_MODEL]);
  });

  it("prefers the default ollama model when present", () => {
    expect(
      getDefaultOllamaModel(() => "qwen3:32b  abc  20 GB  now\nnemotron-3-nano:30b  def  24 GB  now"),
    ).toBe(DEFAULT_OLLAMA_MODEL);
  });
});
