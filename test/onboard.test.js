// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  buildSandboxConfigSyncScript,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
} from "../bin/lib/onboard";

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    expect(script).toMatch(/cat > ~\/\.nemoclaw\/config\.json/);
    expect(script).toMatch(/"model": "nemotron-3-nano:30b"/);
    expect(script).toMatch(/"credentialEnv": "OPENAI_API_KEY"/);
    expect(script).toMatch(/openclaw models set 'inference\/nemotron-3-nano:30b'/);
    expect(script).toMatch(/inference\/nemotron-3-nano:30b/);
    expect(script).toMatch(/^exit$/m);
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.12");
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.13");
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });

  it("routes ollama-local models through the inference provider", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      provider: "ollama-local",
    });

    expect(script).toMatch(/inference\/nemotron-3-nano:30b/);
  });

  it("generates a valid shell script with set -euo pipefail", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      model: "test-model",
      profile: "inference-local",
    });

    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toMatch(/^mkdir -p ~\/\.nemoclaw$/m);
    expect(script).toMatch(/^exit$/m);
  });
});
