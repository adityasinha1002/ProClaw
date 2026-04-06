// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// @ts-ignore -- The workspace linter is not resolving vitest in this new file yet.
import { describe, expect, it } from "vitest";

import {
  NCP_ENDPOINT_MODE_OPTIONS,
  NCP_PARTNER_MENU_TITLE,
  NCP_PROVIDER_LABEL,
  getNcpEndpointModeConfig,
  getNcpPartner,
  isNcpEndpointMode,
  isNcpPartnerId,
  listNcpEndpointModes,
  listNcpPartnerOptions,
  listNcpPartners,
  resolveNcpPartnerSelection,
} from "./ncp-partners";

describe("NCP partner catalog", () => {
  it("lists the 10 partner options in the requested onboarding order", () => {
    expect(NCP_PROVIDER_LABEL).toBe("NVIDIA Partner endpoints");
    expect(NCP_PARTNER_MENU_TITLE).toBe("NVIDIA Cloud Partner endpoint options");
    expect(listNcpPartnerOptions()).toEqual([
      { id: "baseten", label: "Baseten" },
      { id: "bitdeer", label: "Bitdeer AI" },
      { id: "coreweave", label: "CoreWeave" },
      { id: "deepinfra", label: "DeepInfra" },
      { id: "digitalocean", label: "DigitalOcean" },
      { id: "fireworks", label: "Fireworks AI" },
      { id: "gmi-cloud", label: "GMI Cloud" },
      { id: "lightning-ai", label: "Lightning AI" },
      { id: "together", label: "Together AI" },
      { id: "vultr", label: "Vultr" },
    ]);
  });

  it("exposes only the serverless endpoint mode for every partner", () => {
    expect(NCP_ENDPOINT_MODE_OPTIONS.map((option) => option.id)).toEqual(["serverless"]);
    expect(listNcpPartners()).toHaveLength(10);
    for (const partner of listNcpPartners()) {
      expect(listNcpEndpointModes(partner.id).map((mode) => mode.mode)).toEqual(["serverless"]);
    }
  });

  it("captures DeepInfra as an OpenAI-compatible fixed root", () => {
    expect(getNcpEndpointModeConfig("deepinfra", "serverless")).toEqual(
      expect.objectContaining({
        endpointUrl: "https://api.deepinfra.com/v1/openai",
        endpointUrlSource: "fixed",
        apiCompatibility: "openai",
        credential: expect.objectContaining({
          env: "DEEPINFRA_API_KEY",
          label: "DeepInfra API Key",
        }),
      }),
    );
  });

  it("captures Baseten serverless OpenAI root and Api-Key auth", () => {
    expect(getNcpEndpointModeConfig("baseten", "serverless")).toEqual(
      expect.objectContaining({
        endpointUrl: "https://inference.baseten.co/v1",
        apiCompatibility: "openai",
        credential: expect.objectContaining({
          env: "BASETEN_API_KEY",
          label: "Baseten API Key",
          auth: {
            scheme: "api-key",
            headerName: "Authorization",
            valuePrefix: "Api-Key",
          },
        }),
      }),
    );
  });

  it("supports pure lookups for future onboarding and inference config consumers", () => {
    expect(isNcpPartnerId("together")).toBe(true);
    expect(isNcpPartnerId("bogus")).toBe(false);
    expect(isNcpEndpointMode("serverless")).toBe(true);
    expect(isNcpEndpointMode("dedicated")).toBe(false);
    expect(isNcpEndpointMode("gpu")).toBe(false);

    expect(getNcpPartner("vultr")).toEqual(
      expect.objectContaining({
        id: "vultr",
        label: "Vultr",
      }),
    );
    expect(resolveNcpPartnerSelection("together", "serverless")).toEqual(
      expect.objectContaining({
        endpointMode: "serverless",
        endpoint: expect.objectContaining({
          endpointUrl: "https://api.together.xyz/v1",
        }),
        partner: expect.objectContaining({
          id: "together",
          label: "Together AI",
        }),
      }),
    );
    expect(resolveNcpPartnerSelection("together", null)).toEqual(
      expect.objectContaining({ endpointMode: "serverless" }),
    );
  });

  it("fails safely for unknown partners, dedicated mode, or invalid modes", () => {
    expect(getNcpPartner("unknown")).toBeNull();
    expect(getNcpEndpointModeConfig("unknown", "serverless")).toBeNull();
    expect(getNcpEndpointModeConfig("deepinfra", "dedicated")).toBeNull();
    expect(getNcpEndpointModeConfig("deepinfra", "invalid")).toBeNull();
    expect(listNcpEndpointModes("unknown")).toEqual([]);
    expect(resolveNcpPartnerSelection("unknown", "serverless")).toBeNull();
    expect(resolveNcpPartnerSelection("together", "dedicated")).toBeNull();
  });
});
