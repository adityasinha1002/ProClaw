// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from "node:child_process";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
  saveOnboardConfig,
  type EndpointType,
  type NemoClawOnboardConfig,
} from "../onboard/config.js";
import {
  DEFAULT_OLLAMA_MODEL,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getOllamaModelOptions,
  validateLocalProvider,
} from "../onboard/local-inference.js";
import {
  assessNimModels,
  createNimRuntime,
  detectGpu,
  monitorNimStartup,
  pullNimImage,
  resolveRunningNimModel,
  startNimContainer,
  type NimModelAssessment,
} from "../onboard/nim.js";
import { promptInput, promptConfirm, promptSelect } from "../onboard/prompt.js";
import { validateApiKey, maskApiKey } from "../onboard/validate.js";

export interface OnboardOptions {
  apiKey?: string;
  endpoint?: string;
  ncpPartner?: string;
  endpointUrl?: string;
  model?: string;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

const ENDPOINT_TYPES: EndpointType[] = ["build", "ncp", "nim-local", "vllm", "ollama", "custom"];
const SUPPORTED_ENDPOINT_TYPES: EndpointType[] = ["build", "ncp", "nim-local", "ollama"];

function isExperimentalEnabled(): boolean {
  return process.env.NEMOCLAW_EXPERIMENTAL === "1";
}

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODELS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
  { id: "z-ai/glm5", label: "GLM-5" },
  { id: "minimaxai/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B A17B" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];
function resolveProfile(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
      return "default";
    case "ncp":
    case "custom":
      return "ncp";
    case "nim-local":
      return "nim-local";
    case "vllm":
      return "vllm";
    case "ollama":
      return "ollama";
  }
}

function resolveProviderName(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
      return "nvidia-nim";
    case "ncp":
    case "custom":
      return "nvidia-ncp";
    case "nim-local":
      return "nim-local";
    case "vllm":
      return "vllm-local";
    case "ollama":
      return "ollama-local";
  }
}

function resolveCredentialEnv(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
    case "ncp":
    case "custom":
      return "NVIDIA_API_KEY";
    case "nim-local":
    case "vllm":
    case "ollama":
      return "OPENAI_API_KEY";
  }
}

function isNonInteractive(opts: OnboardOptions): boolean {
  if (!opts.endpoint || !opts.model) return false;
  const ep = opts.endpoint as EndpointType;
  if (endpointRequiresApiKey(ep) && !opts.apiKey) return false;
  if ((ep === "ncp" || ep === "custom") && !opts.endpointUrl) return false;
  if (ep === "ncp" && !opts.ncpPartner) return false;
  return true;
}

function endpointRequiresApiKey(endpointType: EndpointType): boolean {
  return (
    endpointType === "build" ||
    endpointType === "ncp" ||
    endpointType === "custom"
  );
}

function defaultCredentialForEndpoint(endpointType: EndpointType): string {
  switch (endpointType) {
    case "nim-local":
    case "vllm":
      return "dummy";
    case "ollama":
      return "ollama";
    default:
      return "";
  }
}

async function resolveLocalNimApiKey(
  opts: OnboardOptions,
  nonInteractive: boolean,
  logger: PluginLogger,
): Promise<string | null> {
  const envKey = process.env.NVIDIA_API_KEY?.trim();
  if (opts.apiKey?.trim()) {
    return opts.apiKey.trim();
  }
  if (envKey) {
    logger.info(`Detected NVIDIA_API_KEY in environment (${maskApiKey(envKey)})`);
    if (nonInteractive) {
      return envKey;
    }
    const useEnv = await promptConfirm("Use this NVIDIA API key for local NIM downloads?", true);
    if (useEnv) {
      return envKey;
    }
  }
  if (nonInteractive) {
    return null;
  }
  logger.info("Local NIM still needs an NVIDIA API key to download model manifests and weights.");
  logger.info("Get an API key from: https://build.nvidia.com/settings/api-keys");
  const input = await promptInput("Enter your NVIDIA API key for local NIM");
  return input.trim() || null;
}

function detectOllama(): { installed: boolean; running: boolean } {
  const installed = testCommand("command -v ollama >/dev/null 2>&1");
  const running = testCommand("curl -sf http://localhost:11434/api/tags >/dev/null 2>&1");
  return { installed, running };
}

function testCommand(command: string): boolean {
  try {
    execSync(command, { encoding: "utf-8", stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

function runCapture(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" }).trim();
  } catch {
    return "";
  }
}

function detectLocalNim(): { available: boolean; gpuSummary?: string; reason?: string } {
  const runtime = createNimRuntime();
  if (!testCommand("command -v docker >/dev/null 2>&1")) {
    return { available: false, reason: "Docker not found" };
  }
  if (!testCommand("docker info >/dev/null 2>&1")) {
    return { available: false, reason: "Docker daemon not running" };
  }

  const gpu = detectGpu(runtime);
  if (!gpu || !gpu.nimCapable) {
    return { available: false, reason: "No NIM-capable NVIDIA GPU detected" };
  }

  const assessments = assessNimModels(gpu, gpu.freeDiskGB ?? null);
  const compatibleModels = assessments.filter((assessment) => assessment.status !== "unsupported");
  if (compatibleModels.length === 0) {
    return {
      available: false,
      reason: `GPU detected (${Math.floor(gpu.totalMemoryMB / 1024)} GB), but no bundled NIM models match the GPU/disk profile`,
    };
  }

  return {
    available: true,
    gpuSummary: `${Math.floor(gpu.totalMemoryMB / 1024)} GB VRAM, ${String(compatibleModels.length)} supported model(s)`,
  };
}

function getNimModelAssessments() {
  const runtime = createNimRuntime();
  const gpu = detectGpu(runtime);
  if (!gpu || !gpu.nimCapable) {
    return [];
  }
  return assessNimModels(gpu, gpu.freeDiskGB ?? null);
}

function formatNimAssessmentLabel(assessment: NimModelAssessment): string {
  const badge = assessment.status === "recommended" ? "recommended" : "supported";
  const tags = assessment.model.recommendedFor?.length ? ` [${assessment.model.recommendedFor.join(", ")}]` : "";
  return `${assessment.model.name} (${badge}; ${assessment.reason})${tags}`;
}

function logNimAssessmentSummary(assessments: NimModelAssessment[], logger: PluginLogger): void {
  const recommended = assessments.filter((assessment) => assessment.status === "recommended");
  const supported = assessments.filter((assessment) => assessment.status === "supported");
  const unsupported = assessments.filter((assessment) => assessment.status === "unsupported").slice(0, 5);

  if (recommended.length > 0) {
    logger.info("Recommended local NIM models for this machine:");
    for (const assessment of recommended) {
      logger.info(`  - ${assessment.model.name}: ${assessment.reason}`);
    }
  }

  if (supported.length > 0) {
    logger.info("Also supported:");
    for (const assessment of supported) {
      logger.info(`  - ${assessment.model.name}: ${assessment.reason}`);
    }
  }

  if (unsupported.length > 0) {
    logger.info("Not offered:");
    for (const assessment of unsupported) {
      logger.info(`  - ${assessment.model.name}: ${assessment.reason}`);
    }
  }
}

function showConfig(config: NemoClawOnboardConfig, logger: PluginLogger): void {
  logger.info(`  Endpoint:    ${describeOnboardEndpoint(config)}`);
  logger.info(`  Provider:    ${describeOnboardProvider(config)}`);
  if (config.ncpPartner) {
    logger.info(`  NCP Partner: ${config.ncpPartner}`);
  }
  logger.info(`  Model:       ${config.model}`);
  logger.info(`  Credential:  $${config.credentialEnv}`);
  logger.info(`  Profile:     ${config.profile}`);
  logger.info(`  Onboarded:   ${config.onboardedAt}`);
}

async function promptEndpoint(
  ollama: { installed: boolean; running: boolean },
  nim: { available: boolean; gpuSummary?: string; reason?: string },
): Promise<EndpointType> {
  const options = [
    {
      label: "NVIDIA Build (build.nvidia.com)",
      value: "build",
      hint: "recommended — zero infra, free credits",
    },
    {
      label: "NVIDIA Cloud Partner (NCP)",
      value: "ncp",
      hint: "dedicated capacity, SLA-backed",
    },
  ];

  if (nim.available) {
    options.push({
      label: "Local NIM",
      value: "nim-local",
      hint: `managed local container — ${nim.gpuSummary}`,
    });
  }

  options.push({
    label: "Local Ollama",
    value: "ollama",
    hint: ollama.running
      ? "detected on localhost:11434"
      : ollama.installed
        ? "installed locally"
        : "localhost:11434",
  });

  if (isExperimentalEnabled()) {
    options.push(
      {
        label: "Local vLLM [experimental]",
        value: "vllm",
        hint: "experimental — local development",
      },
    );
  }

  return (await promptSelect("Select your inference endpoint:", options)) as EndpointType;
}

function execOpenShell(args: string[]): string {
  return execFileSync("openshell", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

interface InferenceRoute {
  provider?: string;
  model?: string;
  endpoint?: string;
}

function verifyInferenceRoute(
  providerName: string,
  model: string,
  logger: PluginLogger,
): boolean {
  try {
    const output = execOpenShell(["inference", "get", "--json"]);
    const route = JSON.parse(output) as InferenceRoute;
    if (route.provider === providerName && route.model === model) {
      logger.info(`Verified inference route: ${providerName} -> ${model}`);
      return true;
    }
    logger.error(
      `Inference route verification mismatch. Expected ${providerName} -> ${model}, got ${route.provider ?? "unknown"} -> ${route.model ?? "unknown"}.`,
    );
    return false;
  } catch (err) {
    logger.error(
      `Failed to verify inference route: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function cliOnboard(opts: OnboardOptions): Promise<void> {
  const { logger } = opts;
  const nonInteractive = isNonInteractive(opts);

  logger.info("NemoClaw Onboarding");
  logger.info("-------------------");

  // Step 0: Check existing config
  const existing = loadOnboardConfig();
  if (existing) {
    logger.info("");
    logger.info("Existing configuration found:");
    showConfig(existing, logger);
    logger.info("");

    if (!nonInteractive) {
      const reconfigure = await promptConfirm("Reconfigure?", false);
      if (!reconfigure) {
        logger.info("Keeping existing configuration.");
        return;
      }
    }
  }

  // Step 1: Endpoint Selection
  let endpointType: EndpointType;
  if (opts.endpoint) {
    if (!ENDPOINT_TYPES.includes(opts.endpoint as EndpointType)) {
      logger.error(
        `Invalid endpoint type: ${opts.endpoint}. Must be one of: ${ENDPOINT_TYPES.join(", ")}`,
      );
      return;
    }
    const ep = opts.endpoint as EndpointType;
    if (!SUPPORTED_ENDPOINT_TYPES.includes(ep)) {
      logger.warn(
        `Note: '${ep}' is experimental and may not work reliably.`,
      );
    }
    endpointType = ep;
  } else {
    const ollama = detectOllama();
    const nim = detectLocalNim();
    if (nim.available) {
      logger.info(`Detected local inference option: NIM (${nim.gpuSummary}).`);
      logger.info("Select it explicitly if you want NemoClaw to run a local NIM container.");
    }
    if (ollama.running) {
      logger.info("Detected local inference option: Ollama.");
      logger.info("Select it explicitly if you want to use it.");
    }
    endpointType = await promptEndpoint(ollama, nim);
  }

  // Step 2: Endpoint URL resolution
  let endpointUrl: string;
  let ncpPartner: string | null = null;

  switch (endpointType) {
    case "build":
      endpointUrl = BUILD_ENDPOINT_URL;
      break;
    case "ncp":
      ncpPartner = opts.ncpPartner ?? (await promptInput("NCP partner name"));
      endpointUrl =
        opts.endpointUrl ??
        (await promptInput("NCP endpoint URL (e.g., https://partner.api.nvidia.com/v1)"));
      break;
    case "nim-local":
      endpointUrl = opts.endpointUrl ?? getLocalProviderBaseUrl("nim-local");
      break;
    case "vllm":
      endpointUrl = getLocalProviderBaseUrl("vllm-local");
      break;
    case "ollama":
      endpointUrl = opts.endpointUrl ?? getLocalProviderBaseUrl("ollama-local");
      break;
    case "custom":
      endpointUrl = opts.endpointUrl ?? (await promptInput("Custom endpoint URL"));
      break;
  }

  if (!endpointUrl) {
    logger.error("No endpoint URL provided. Aborting.");
    return;
  }

  const credentialEnv = resolveCredentialEnv(endpointType);
  const requiresApiKey = endpointRequiresApiKey(endpointType);
  const requiresLocalNimApiKey = endpointType === "nim-local";

  // Step 3: Credential
  let apiKey = defaultCredentialForEndpoint(endpointType);
  let localNimApiKey: string | null = null;
  if (requiresApiKey) {
    if (opts.apiKey) {
      apiKey = opts.apiKey;
    } else {
      const envKey = process.env.NVIDIA_API_KEY;
      if (envKey) {
        logger.info(`Detected NVIDIA_API_KEY in environment (${maskApiKey(envKey)})`);
        const useEnv = nonInteractive ? true : await promptConfirm("Use this key?");
        apiKey = useEnv ? envKey : await promptInput("Enter your NVIDIA API key");
      } else {
        logger.info("Get an API key from: https://build.nvidia.com/settings/api-keys");
        apiKey = await promptInput("Enter your NVIDIA API key");
      }
    }
  } else if (requiresLocalNimApiKey) {
    localNimApiKey = await resolveLocalNimApiKey(opts, nonInteractive, logger);
    if (!localNimApiKey) {
      logger.error("NVIDIA_API_KEY is required to start a local NIM container.");
      return;
    }
  } else {
    logger.info(
      `No API key required for ${endpointType}. Using local credential value '${apiKey}'.`,
    );
  }

  if (!apiKey) {
    logger.error("No API key provided. Aborting.");
    return;
  }

  // Step 4: Validate API Key
  // For local endpoints (vllm, ollama, nim-local), validation is best-effort since the
  // service may not be running yet during onboarding.
  const isLocalEndpoint =
    endpointType === "vllm" || endpointType === "ollama" || endpointType === "nim-local";
  logger.info("");
  logger.info(`Validating ${requiresApiKey ? "credential" : "endpoint"} against ${endpointUrl}...`);
  const validation = await validateApiKey(apiKey, endpointUrl);

  if (!validation.valid) {
    if (isLocalEndpoint) {
      logger.warn(
        `Could not reach ${endpointUrl} (${validation.error ?? "unknown error"}). Continuing anyway — the service may not be running yet.`,
      );
    } else {
      logger.error(`API key validation failed: ${validation.error ?? "unknown error"}`);
      logger.info("Check your key at https://build.nvidia.com/settings/api-keys");
      return;
    }
  } else {
    logger.info(
      `${requiresApiKey ? "Credential" : "Endpoint"} valid. ${String(validation.models.length)} model(s) available.`,
    );
  }

  // Step 5: Model Selection
  let model: string;
  if (opts.model) {
    model = opts.model;
  } else {
    const nimAssessments = endpointType === "nim-local" ? getNimModelAssessments() : [];
    if (endpointType === "nim-local" && nimAssessments.length > 0) {
      logNimAssessmentSummary(nimAssessments, logger);
    }
    const discoveredModelOptions =
      endpointType === "ollama"
        ? getOllamaModelOptions(runCapture).map((id) => ({ label: id, value: id }))
        : endpointType === "nim-local"
        ? nimAssessments
            .filter((assessment) => assessment.status !== "unsupported")
            .map((assessment) => ({
              label: formatNimAssessmentLabel(assessment),
              value: assessment.model.name,
            }))
        : validation.models.map((id) => ({ label: id, value: id }));
    const curatedCloudOptions =
      endpointType === "build" || endpointType === "ncp"
        ? DEFAULT_MODELS.filter((option) => validation.models.includes(option.id)).map((option) => ({
            label: `${option.label} (${option.id})`,
            value: option.id,
          }))
        : [];
    const defaultIndex =
      endpointType === "ollama"
        ? Math.max(
            0,
            discoveredModelOptions.findIndex(
              (option) => option.value === getDefaultOllamaModel(runCapture),
            ),
          )
        : endpointType === "nim-local"
          ? 0
        : 0;
    const modelOptions =
      curatedCloudOptions.length > 0
        ? curatedCloudOptions
        : discoveredModelOptions.length > 0
          ? discoveredModelOptions
          : DEFAULT_MODELS.map((m) => ({ label: `${m.label} (${m.id})`, value: m.id }));

    model = await promptSelect("Select your primary model:", modelOptions, defaultIndex);
  }

  // Step 6: Resolve profile
  const profile = resolveProfile(endpointType);
  const providerName = resolveProviderName(endpointType);
  const summaryConfig: NemoClawOnboardConfig = {
    endpointType,
    endpointUrl,
    ncpPartner,
    model,
    profile,
    credentialEnv,
    provider: providerName,
    providerLabel: undefined,
    onboardedAt: "",
  };
  summaryConfig.providerLabel = describeOnboardProvider(summaryConfig);

  // Step 7: Confirmation
  logger.info("");
  logger.info("Configuration summary:");
  logger.info(`  Endpoint:    ${describeOnboardEndpoint(summaryConfig)}`);
  logger.info(`  Provider:    ${summaryConfig.providerLabel}`);
  if (ncpPartner) {
    logger.info(`  NCP Partner: ${ncpPartner}`);
  }
  logger.info(`  Model:       ${model}`);
  logger.info(
    `  API Key:     ${requiresApiKey ? maskApiKey(apiKey) : requiresLocalNimApiKey && localNimApiKey ? `${maskApiKey(localNimApiKey)} (for local NIM downloads)` : "not required (local provider)"}`,
  );
  logger.info(`  Credential:  $${credentialEnv}`);
  logger.info(`  Profile:     ${profile}`);
  logger.info(`  Provider:    ${providerName}`);
  logger.info("");

  if (!nonInteractive) {
    const proceed = await promptConfirm("Apply this configuration?");
    if (!proceed) {
      logger.info("Onboarding cancelled.");
      return;
    }
  }

  // Step 8: Apply
  logger.info("");
  logger.info("Applying configuration...");

  if (endpointType === "nim-local") {
    process.env.NVIDIA_API_KEY = localNimApiKey ?? process.env.NVIDIA_API_KEY ?? "";
    process.env.NGC_API_KEY = process.env.NGC_API_KEY?.trim() || process.env.NVIDIA_API_KEY;

    const runtime = createNimRuntime();
    const gpu = detectGpu(runtime);
    if (!gpu || !gpu.nimCapable) {
      logger.error("Local NIM requires an NVIDIA GPU and a running Docker daemon.");
      return;
    }

    const assessments = assessNimModels(gpu, gpu.freeDiskGB ?? null);
    const selectedAssessment = assessments.find((assessment) => assessment.model.name === model);
    if (!selectedAssessment || selectedAssessment.status === "unsupported") {
      logger.error(
        `Selected model '${model}' does not match the detected GPU/disk profile (${String(Math.floor(gpu.totalMemoryMB / 1024))} GB VRAM${gpu.freeDiskGB ? `, ${String(gpu.freeDiskGB)} GB free disk` : ""}). ${selectedAssessment?.reason ?? ""}`.trim(),
      );
      return;
    }

    logger.info(`Pulling local NIM image for ${model}...`);
    let resolvedImage: string;
    try {
      resolvedImage = pullNimImage(model, runtime);
      logger.info("Starting local NIM container...");
      startNimContainer(
        opts.pluginConfig.sandboxName,
        model,
        runtime,
        8000,
        resolvedImage,
        selectedAssessment?.matchedProfile?.minDiskSpaceGB,
      );
    } catch (err) {
      logger.error(`Failed to launch local NIM container: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    logger.info("Waiting for local NIM health check...");
    const startup = monitorNimStartup(runtime, opts.pluginConfig.sandboxName, 8000, 1200, 5, 14400);
    if (!startup.healthy) {
      logger.error(startup.reason ?? "Local NIM did not become healthy on http://localhost:8000/v1.");
      if (startup.detail) {
        logger.error(startup.detail);
      }
      return;
    }

    model = resolveRunningNimModel(runtime, model, 8000);

    const providerValidation = validateLocalProvider("nim-local", runCapture);
    if (!providerValidation.ok) {
      logger.error(providerValidation.message ?? "Local NIM is unavailable.");
      return;
    }
  }

  // 7a: Create/update provider
  try {
    execOpenShell([
      "provider",
      "create",
      "--name",
      providerName,
      "--type",
      "openai",
      "--credential",
      `${credentialEnv}=${apiKey}`,
      "--config",
      `OPENAI_BASE_URL=${endpointUrl}`,
    ]);
    logger.info(`Created provider: ${providerName}`);
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    if (stderr.includes("AlreadyExists") || stderr.includes("already exists")) {
      try {
        execOpenShell([
          "provider",
          "update",
          providerName,
          "--credential",
          `${credentialEnv}=${apiKey}`,
          "--config",
          `OPENAI_BASE_URL=${endpointUrl}`,
        ]);
        logger.info(`Updated provider: ${providerName}`);
      } catch (updateErr) {
        const updateStderr =
          updateErr instanceof Error && "stderr" in updateErr
            ? String((updateErr as { stderr: unknown }).stderr)
            : "";
        logger.error(`Failed to update provider: ${updateStderr || String(updateErr)}`);
        return;
      }
    } else {
      logger.error(`Failed to create provider: ${stderr || String(err)}`);
      return;
    }
  }

  // 7b: Set inference route
  try {
    execOpenShell(["inference", "set", "--provider", providerName, "--model", model]);
    logger.info(`Inference route set: ${providerName} -> ${model}`);
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    logger.error(`Failed to set inference route: ${stderr || String(err)}`);
    return;
  }

  if (!verifyInferenceRoute(providerName, model, logger)) {
    return;
  }

  // 7c: Save config
  saveOnboardConfig({
    endpointType,
    endpointUrl,
    ncpPartner,
    model,
    profile,
    credentialEnv,
    provider: providerName,
    providerLabel: summaryConfig.providerLabel,
    onboardedAt: new Date().toISOString(),
  });

  // Step 9: Success
  logger.info("");
  logger.info("Onboarding complete!");
  logger.info("");
  logger.info(`  Endpoint:   ${describeOnboardEndpoint(summaryConfig)}`);
  logger.info(`  Provider:   ${summaryConfig.providerLabel}`);
  logger.info(`  Model:      ${model}`);
  logger.info(`  Credential: $${credentialEnv}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("  openclaw nemoclaw launch     # Bootstrap sandbox");
  logger.info("  openclaw nemoclaw status     # Check configuration");
}
