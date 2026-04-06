// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared NVIDIA Cloud Partner catalog used by onboarding and inference config.
 */

export const NCP_SHARED_PROVIDER_ID = "nvidia-ncp";
export const NCP_PROVIDER_LABEL = "NVIDIA Partner endpoints";
export const NCP_PARTNER_MENU_TITLE = "NVIDIA Cloud Partner endpoint options";

export const NCP_PARTNER_IDS = [
  "baseten",
  "bitdeer",
  "coreweave",
  "deepinfra",
  "digitalocean",
  "fireworks",
  "gmi-cloud",
  "lightning-ai",
  "together",
  "vultr",
] as const;

/** TODO: Catalog data is serverless-only for now; `NcpEndpointMode` must match keys in each partner's `endpointModes`. */
export const NCP_ENDPOINT_MODES = ["serverless"] as const;

export type NcpPartnerId = (typeof NCP_PARTNER_IDS)[number];
export type NcpEndpointMode = (typeof NCP_ENDPOINT_MODES)[number];
export type NcpAuthScheme = "bearer" | "api-key" | "unknown";
export type NcpApiCompatibility = "openai" | "custom" | "unknown";
export type NcpEndpointUrlSource = "fixed" | "template" | "deployment";

export interface NcpModeOption {
  id: NcpEndpointMode;
  menuLabel: string;
  billingLabel: string;
}

export interface NcpAuthMetadata {
  scheme: NcpAuthScheme;
  headerName: string;
  valuePrefix: string | null;
}

export interface NcpCredentialMetadata {
  env: string;
  label: string;
  helpUrl: string | null;
  consoleUrl: string | null;
  helpSteps: readonly string[];
  auth: NcpAuthMetadata;
}

export interface NcpEndpointModeMetadata {
  mode: NcpEndpointMode;
  menuLabel: string;
  billingLabel: string;
  endpointUrl: string | null;
  endpointUrlTemplate: string | null;
  endpointUrlSource: NcpEndpointUrlSource;
  apiCompatibility: NcpApiCompatibility;
  docsUrl: string | null;
  notes: string | null;
  credential: NcpCredentialMetadata;
}

export interface NcpPartnerCatalogEntry {
  id: NcpPartnerId;
  label: string;
  endpointModes: Record<NcpEndpointMode, NcpEndpointModeMetadata>;
}

export interface NcpPartnerOption {
  id: NcpPartnerId;
  label: string;
}

export interface ResolvedNcpPartnerSelection {
  partner: NcpPartnerCatalogEntry;
  endpointMode: NcpEndpointMode;
  endpoint: NcpEndpointModeMetadata;
}

export const NCP_ENDPOINT_MODE_OPTION_MAP: Record<NcpEndpointMode, NcpModeOption> = {
  serverless: {
    id: "serverless",
    menuLabel: "Serverless ($ per token)",
    billingLabel: "$ per token",
  },
};

export const NCP_ENDPOINT_MODE_OPTIONS = Object.values(NCP_ENDPOINT_MODE_OPTION_MAP);

interface CreateCredentialOptions {
  env: string;
  label: string;
  helpUrl?: string | null;
  consoleUrl?: string | null;
  helpSteps: readonly string[];
  authScheme?: NcpAuthScheme;
  authHeaderName?: string;
  authValuePrefix?: string | null;
}

interface CreateEndpointModeOptions {
  mode: NcpEndpointMode;
  endpointUrl?: string | null;
  endpointUrlTemplate?: string | null;
  endpointUrlSource: NcpEndpointUrlSource;
  apiCompatibility?: NcpApiCompatibility;
  docsUrl?: string | null;
  notes?: string | null;
  credential: NcpCredentialMetadata;
}

function createCredential(options: CreateCredentialOptions): NcpCredentialMetadata {
  return {
    env: options.env,
    label: options.label,
    helpUrl: options.helpUrl ?? null,
    consoleUrl: options.consoleUrl ?? null,
    helpSteps: [...options.helpSteps],
    auth: {
      scheme: options.authScheme ?? "bearer",
      headerName: options.authHeaderName ?? "Authorization",
      valuePrefix:
        options.authValuePrefix === undefined
          ? options.authScheme === "api-key"
            ? "Api-Key"
            : options.authScheme === "unknown"
              ? null
              : "Bearer"
          : options.authValuePrefix,
    },
  };
}

function createEndpointMode(options: CreateEndpointModeOptions): NcpEndpointModeMetadata {
  const modeOption = NCP_ENDPOINT_MODE_OPTION_MAP[options.mode];
  return {
    mode: options.mode,
    menuLabel: modeOption.menuLabel,
    billingLabel: modeOption.billingLabel,
    endpointUrl: options.endpointUrl ?? null,
    endpointUrlTemplate: options.endpointUrlTemplate ?? null,
    endpointUrlSource: options.endpointUrlSource,
    apiCompatibility: options.apiCompatibility ?? "openai",
    docsUrl: options.docsUrl ?? null,
    notes: options.notes ?? null,
    credential: options.credential,
  };
}

function createPartner(
  id: NcpPartnerId,
  label: string,
  endpointModes: Record<NcpEndpointMode, NcpEndpointModeMetadata>,
): NcpPartnerCatalogEntry {
  return {
    id,
    label,
    endpointModes,
  };
}

const NCP_PARTNER_CATALOG: Record<NcpPartnerId, NcpPartnerCatalogEntry> = {
  baseten: createPartner("baseten", "Baseten", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://inference.baseten.co/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://docs.baseten.co/reference/inference-api/overview",
      credential: createCredential({
        env: "BASETEN_API_KEY",
        label: "Baseten API Key",
        helpUrl: "https://docs.baseten.co/organization/api-keys",
        consoleUrl: "https://app.baseten.co/settings/api_keys",
        helpSteps: [
          "Sign in to your Baseten account.",
          "Open API keys.",
          "Create or copy an inference-capable key.",
          "Paste the key below.",
        ],
        authScheme: "api-key",
      }),
    }),
  }),
  bitdeer: createPartner("bitdeer", "Bitdeer AI", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api-inference.bitdeer.ai/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://www.bitdeer.ai/en/docs/inference/model-api/",
      credential: createCredential({
        env: "BITDEER_API_KEY",
        label: "Bitdeer AI API Key",
        helpUrl: "https://www.bitdeer.ai/en/docs/inference/model-api/",
        helpSteps: [
          "Sign in to the Bitdeer AI Studio console.",
          "Open Models and inspect a model's API example.",
          "Create or copy the API key used for model inference.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  coreweave: createPartner("coreweave", "CoreWeave", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrlTemplate: "https://api.inference.wandb.ai/v1",
      endpointUrlSource: "template",
      apiCompatibility: "unknown",
      docsUrl:
        "https://docs.coreweave.com/products/inference/serverless",
      credential: createCredential({
        env: "COREWEAVE_API_ACCESS_TOKEN",
        label: "CoreWeave API Access Token",
        helpUrl: "https://docs.coreweave.com/security/authn-authz/manage-api-access-tokens",
        helpSteps: [
          "Sign in to the CoreWeave Cloud Console.",
          "Create or copy an API access token.",
          "Confirm which inference host should receive traffic.",
          "Paste the token below.",
        ],
      }),
    }),
  }),
  deepinfra: createPartner("deepinfra", "DeepInfra", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.deepinfra.com/v1/openai",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://deepinfra.com/docs/openai_api",
      credential: createCredential({
        env: "DEEPINFRA_API_KEY",
        label: "DeepInfra API Key",
        helpUrl: "https://deepinfra.com/dash/api_keys",
        consoleUrl: "https://deepinfra.com/dash/api_keys",
        helpSteps: [
          "Sign in to your DeepInfra account.",
          "Open API keys.",
          "Create or copy an API key.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  digitalocean: createPartner("digitalocean", "DigitalOcean", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://inference.do-ai.run/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl:
        "https://docs.digitalocean.com/products/gradient-ai-platform/how-to/use-serverless-inference/",
      credential: createCredential({
        env: "DIGITALOCEAN_MODEL_ACCESS_KEY",
        label: "DigitalOcean Model Access Key",
        consoleUrl: "https://cloud.digitalocean.com/gen-ai/model-access-keys",
        helpSteps: [
          "Sign in to the DigitalOcean Control Panel.",
          "Open Model Access Keys.",
          "Create or copy a serverless inference key.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  fireworks: createPartner("fireworks", "Fireworks AI", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.fireworks.ai/inference/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://docs.fireworks.ai/getting-started/quickstart",
      credential: createCredential({
        env: "FIREWORKS_API_KEY",
        label: "Fireworks AI API Key",
        consoleUrl: "https://app.fireworks.ai/settings/users/api-keys",
        helpSteps: [
          "Sign in to the Fireworks dashboard.",
          "Open user API keys.",
          "Create or copy an API key.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  "gmi-cloud": createPartner("gmi-cloud", "GMI Cloud", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.gmi-serving.com/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://docs.gmicloud.ai/inference-engine/ie-intro",
      credential: createCredential({
        env: "GMI_CLOUD_API_KEY",
        label: "GMI Cloud API Key",
        helpUrl: "https://docs.gmicloud.ai/api-reference/organizations/create-an-api-key",
        consoleUrl: "https://console.gmicloud.ai/user-setting/api-keys",
        helpSteps: [
          "Sign in to the GMI Cloud console.",
          "Open Organization Settings and API Keys.",
          "Create or copy an API key.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  "lightning-ai": createPartner("lightning-ai", "Lightning AI", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.lightning.ai/inference",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://api.lightning.ai/docs/overview/inference-overview",
      credential: createCredential({
        env: "LIGHTNING_AI_API_KEY",
        label: "Lightning AI API Key",
        helpUrl: "https://api.lightning.ai/docs/overview/model-apis",
        consoleUrl: "https://lightning.ai/models?section=allmodels",
        helpSteps: [
          "Open the Lightning AI custom inference docs or console.",
          "Create or copy the credential for the hosted endpoint you plan to call.",
          "Confirm the endpoint path used by that deployment.",
          "Paste the key below.",
        ],
        authScheme: "unknown",
      }),
    }),
  }),
  together: createPartner("together", "Together AI", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.together.xyz/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
      credential: createCredential({
        env: "TOGETHER_API_KEY",
        label: "Together AI API Key",
        helpUrl: "https://docs.together.ai/docs/api-keys-authentication",
        consoleUrl: "https://api.together.xyz/settings/api-keys",
        helpSteps: [
          "Sign in to Together AI.",
          "Open API keys.",
          "Create or copy an API key.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
  vultr: createPartner("vultr", "Vultr", {
    serverless: createEndpointMode({
      mode: "serverless",
      endpointUrl: "https://api.vultrinference.com/v1",
      endpointUrlSource: "fixed",
      apiCompatibility: "openai",
      docsUrl: "https://docs.vultr.com/products/serverless/inference",
      credential: createCredential({
        env: "VULTR_API_KEY",
        label: "Vultr Inference API Key",
        consoleUrl: "https://my.vultr.com/inference/",
        helpSteps: [
          "Sign in to the Vultr Customer Portal.",
          "Open the Serverless Inference subscription.",
          "Copy the inference API key from the Overview tab.",
          "Paste the key below.",
        ],
      }),
    }),
  }),
};

export function isNcpPartnerId(value: string | null | undefined): value is NcpPartnerId {
  return typeof value === "string" && (NCP_PARTNER_IDS as readonly string[]).includes(value);
}

export function isNcpEndpointMode(value: string | null | undefined): value is NcpEndpointMode {
  return typeof value === "string" && (NCP_ENDPOINT_MODES as readonly string[]).includes(value);
}

export function listNcpPartners(): NcpPartnerCatalogEntry[] {
  return NCP_PARTNER_IDS.map((id) => NCP_PARTNER_CATALOG[id]);
}

export function listNcpPartnerOptions(): NcpPartnerOption[] {
  return listNcpPartners().map((partner) => ({ id: partner.id, label: partner.label }));
}

export function getNcpPartner(partnerId: string | null | undefined): NcpPartnerCatalogEntry | null {
  if (!isNcpPartnerId(partnerId)) return null;
  return NCP_PARTNER_CATALOG[partnerId];
}

export function listNcpEndpointModes(
  partnerId: string | null | undefined,
): NcpEndpointModeMetadata[] {
  const partner = getNcpPartner(partnerId);
  if (!partner) return [];
  return NCP_ENDPOINT_MODES.map((mode) => partner.endpointModes[mode]);
}

export function getNcpEndpointModeConfig(
  partnerId: string | null | undefined,
  endpointMode: string | null | undefined,
): NcpEndpointModeMetadata | null {
  const partner = getNcpPartner(partnerId);
  if (!partner || !isNcpEndpointMode(endpointMode)) return null;
  return partner.endpointModes[endpointMode];
}

export function resolveNcpPartnerSelection(
  partnerId: string | null | undefined,
  endpointMode: string | null | undefined,
): ResolvedNcpPartnerSelection | null {
  const partner = getNcpPartner(partnerId);
  const normalized =
    endpointMode == null || endpointMode === "" ? "serverless" : endpointMode;
  const endpoint = getNcpEndpointModeConfig(partnerId, normalized);
  if (!partner || !endpoint) return null;
  return {
    partner,
    endpointMode: endpoint.mode,
    endpoint,
  };
}
