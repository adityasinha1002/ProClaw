// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTAINER_REACHABILITY_IMAGE,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  validateLocalProvider,
} = require("../bin/lib/local-inference");

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("vllm-local"),
      "http://host.openshell.internal:8000/v1",
    );
  });

  it("returns the expected base URL for ollama-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("ollama-local"),
      "http://host.openshell.internal:11434/v1",
    );
  });

  it("returns the expected health check command for ollama-local", () => {
    assert.equal(
      getLocalProviderHealthCheck("ollama-local"),
      "curl -sf http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("returns the expected container reachability command for ollama-local", () => {
    assert.equal(
      getLocalProviderContainerReachabilityCheck("ollama-local"),
      `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`,
    );
  });

  it("validates a reachable local provider", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return '{"models":[]}';
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:11434/);
  });

  it("returns a clear error when ollama-local is not reachable from containers", () => {
    let callCount = 0;
    const result = validateLocalProvider("ollama-local", () => {
      callCount += 1;
      return callCount === 1 ? '{"models":[]}' : "";
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /host\.openshell\.internal:11434/);
    assert.match(result.message, /0\.0\.0\.0:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:8000/);
  });
});
