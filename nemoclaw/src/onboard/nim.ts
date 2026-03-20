// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import path from "node:path";
import nimImages from "../../../bin/lib/nim-images.json";

export interface GpuInfo {
  type: "nvidia" | "apple";
  count: number;
  totalMemoryMB: number;
  perGpuMB: number;
  nimCapable: boolean;
  family?: string | null;
  families?: string[];
  names?: string[];
  freeDiskGB?: number | null;
  name?: string;
  cores?: number | null;
  spark?: boolean;
}

export interface NimProfile {
  gpuFamilies?: string[];
  minGpuCount?: number;
  minPerGpuMemoryMB?: number;
  minDiskSpaceGB?: number;
  precision?: string;
  diskSource?: string;
}

export interface NimModel {
  name: string;
  image: string;
  minGpuMemoryMB: number;
  servedModel?: string;
  recommendedRank?: number;
  recommendedFor?: string[];
  profiles?: NimProfile[];
}

export type NimModelAssessmentStatus = "recommended" | "supported" | "unsupported";

export interface NimModelAssessment {
  model: NimModel;
  status: NimModelAssessmentStatus;
  score: number;
  reason: string;
  matchedProfile?: NimProfile;
  unmetRequirements?: string[];
}

export interface NimRuntime {
  exec(command: string): string;
}

export interface NimStartupResult {
  healthy: boolean;
  reason?: string;
  detail?: string;
  state?: string;
  fatalPattern?: string;
  idleSeconds?: number;
}

const MODEL_PULL_FALLBACKS: Record<string, string[]> = {
  "nvidia/nemotron-3-nano-30b-a3b": ["nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"],
};
const MODEL_SERVED_ID_ALIASES: Record<string, string> = {
  "nvidia/nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano",
  "z-ai/glm5": "zai-org/GLM-5",
};

function normalizeGpuFamily(name: string): string | null {
  const value = name.toLowerCase();
  if (value.includes("gb10") || value.includes("dgx spark")) return "dgx-spark";
  if (value.includes("gb200")) return "gb200";
  if (value.includes("b200")) return "b200";
  if (value.includes("gh200")) return "gh200";
  if (value.includes("h200")) return "h200";
  if (value.includes("h100")) return "h100";
  if (value.includes("h20")) return "h20";
  if (value.includes("l40s")) return "l40s";
  if (value.includes("a10g")) return "a10g";
  if (value.includes("a100")) return "a100";
  if (value.includes("rtx 6000 ada")) return "rtx6000-ada";
  if (value.includes("blackwell server edition")) return "rtx-pro-6000-blackwell";
  if (value.includes("rtx 5090")) return "rtx5090";
  if (value.includes("rtx 4090")) return "rtx4090";
  return null;
}

export function createNimRuntime(): NimRuntime {
  return {
    exec(command: string): string {
      return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" });
    },
  };
}

function tryExec(runtime: NimRuntime, command: string): string {
  try {
    return runtime.exec(command).trim();
  } catch {
    return "";
  }
}

function extractExecErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }
  const stderr = "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
  const message = "message" in err ? String((err as { message?: unknown }).message ?? "") : "";
  return `${message}\n${stderr}`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getNimCacheCandidatePaths(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const user = process.env.USER || "user";
  const push = (candidate?: string | null): void => {
    if (!candidate) return;
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(process.env.NEMOCLAW_NIM_CACHE_DIR);
  push(process.env.LOCAL_NIM_CACHE);

  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) {
    push(path.join(xdgCacheHome, "nim"));
  }

  const home = process.env.HOME?.trim();
  if (home) {
    push(path.join(home, ".cache", "nim"));
    push(path.join(home, ".local", "share", "nim-cache"));
  }

  for (const root of ["/workspace", "/data", "/scratch", "/mnt", "/media", "/Volumes", "/var/tmp", "/tmp"]) {
    push(path.join(root, `nemoclaw-nim-cache-${user}`));
  }

  return candidates;
}

function detectPathFreeDiskGB(runtime: NimRuntime, targetPath: string): number | null {
  const availableKB = tryExec(runtime, `df -Pk ${shellQuote(targetPath)} | awk 'NR==2 {print $4}'`);
  const available = parseInt(availableKB, 10);
  if (!Number.isFinite(available) || available <= 0) {
    return null;
  }
  return Math.floor(available / 1024 / 1024);
}

function isWritableDirectory(runtime: NimRuntime, targetPath: string): boolean {
  return (
    tryExec(runtime, `mkdir -p ${shellQuote(targetPath)} && test -w ${shellQuote(targetPath)} && printf ok`) === "ok"
  );
}

const NIM_FATAL_LOG_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /error decoding response body/i,
    reason: "NIM failed while downloading model files from NGC. This is usually a network or partial-download issue.",
  },
  {
    pattern: /requires an API key, but none was found/i,
    reason: "NIM startup failed because NVIDIA_API_KEY/NGC_API_KEY was not provided to the container.",
  },
  {
    pattern: /manifestdownloaderror/i,
    reason: "NIM failed while downloading the model manifest or weights.",
  },
  {
    pattern: /access denied|401 authorization required|denied: please accept license/i,
    reason: "NIM could not access required model artifacts from NGC.",
  },
  {
    pattern: /no compatible profile/i,
    reason: "NIM could not find a compatible runtime profile for this machine.",
  },
  {
    pattern: /detected 0 compatible profile\(s\)/i,
    reason: "NIM did not find a compatible profile for the detected hardware.",
  },
  {
    pattern: /traceback \(most recent call last\)/i,
    reason: "NIM startup hit a Python exception before becoming healthy.",
  },
];

function getPullCandidatesForModel(modelName: string): string[] {
  const primary = getImageForModel(modelName);
  if (!primary) {
    return [];
  }
  return [primary, ...(MODEL_PULL_FALLBACKS[modelName] ?? [])];
}

export function getServedModelForModel(modelName: string): string {
  return MODEL_SERVED_ID_ALIASES[modelName] ?? modelName;
}

function getContainerCredentialArgs(): string[] {
  const credentials: string[] = [];
  const ngcApiKey = process.env.NGC_API_KEY?.trim();
  const nvidiaApiKey = process.env.NVIDIA_API_KEY?.trim();
  if (nvidiaApiKey) {
    credentials.push(`-e NVIDIA_API_KEY=${shellQuote(nvidiaApiKey)}`);
  }
  const effectiveNgcApiKey = ngcApiKey || nvidiaApiKey;
  if (effectiveNgcApiKey) {
    credentials.push(`-e NGC_API_KEY=${shellQuote(effectiveNgcApiKey)}`);
  }
  return credentials;
}

function getModelCacheRequirementGB(modelName: string, overrideDiskGB?: number | null): number {
  if (typeof overrideDiskGB === "number" && overrideDiskGB > 0) {
    return overrideDiskGB;
  }
  const model = listModels().find((entry) => entry.name === modelName);
  const requirements = (model?.profiles ?? [])
    .map((profile) => profile.minDiskSpaceGB ?? 0)
    .filter((value) => value > 0);
  return requirements.length > 0 ? Math.min(...requirements) : 0;
}

function resolveNimCacheDirectory(
  runtime: NimRuntime,
  modelName?: string,
  requiredDiskGB?: number | null,
): { hostPath: string; freeDiskGB: number | null } | null {
  const required = getModelCacheRequirementGB(modelName ?? "", requiredDiskGB);
  const reserveGB = required > 0 ? 20 : 10;
  let best: { hostPath: string; freeDiskGB: number | null } | null = null;

  for (const candidate of getNimCacheCandidatePaths()) {
    if (!isWritableDirectory(runtime, candidate)) {
      continue;
    }
    const freeDiskGB = detectPathFreeDiskGB(runtime, candidate);
    if (
      process.env.NEMOCLAW_NIM_CACHE_DIR?.trim() === candidate ||
      process.env.LOCAL_NIM_CACHE?.trim() === candidate
    ) {
      return { hostPath: candidate, freeDiskGB };
    }
    if (freeDiskGB !== null && freeDiskGB >= required + reserveGB) {
      if (!best || (best.freeDiskGB ?? -1) < freeDiskGB) {
        best = { hostPath: candidate, freeDiskGB };
      }
      continue;
    }
    if (!best || (best.freeDiskGB ?? -1) < (freeDiskGB ?? -1)) {
      best = { hostPath: candidate, freeDiskGB };
    }
  }

  return best;
}

export function containerName(sandboxName: string): string {
  return `nemoclaw-nim-${sandboxName}`;
}

export function listModels(): NimModel[] {
  return nimImages.models.map((model) => ({
    name: model.name,
    image: model.image,
    minGpuMemoryMB: model.minGpuMemoryMB,
    servedModel: model.servedModel ?? getServedModelForModel(model.name),
    recommendedRank: model.recommendedRank ?? Number.MAX_SAFE_INTEGER,
    recommendedFor: model.recommendedFor ?? [],
    profiles: model.profiles ?? [],
  }));
}

export function getImageForModel(modelName: string): string | null {
  return listModels().find((model) => model.name === modelName)?.image ?? null;
}

export function detectGpu(runtime: NimRuntime): GpuInfo | null {
  const nvidiaNames = tryExec(
    runtime,
    "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null",
  );
  const nvidiaMemory = tryExec(
    runtime,
    "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null",
  );
  if (nvidiaMemory) {
    const perGpuMB = nvidiaMemory
      .split(/\r?\n/)
      .map((line) => parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (perGpuMB.length > 0) {
      const names = nvidiaNames
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const families = [...new Set(names.map(normalizeGpuFamily).filter((family): family is string => Boolean(family)))];
      return {
        type: "nvidia",
        count: perGpuMB.length,
        totalMemoryMB: perGpuMB.reduce((sum, value) => sum + value, 0),
        perGpuMB: perGpuMB[0],
        names,
        family: families[0] ?? null,
        families,
        freeDiskGB: detectDiskSpaceGB(runtime),
        nimCapable: true,
      };
    }
  }

  const nvidiaName = tryExec(
    runtime,
    "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null",
  );
  if (nvidiaName.includes("GB10")) {
    const totalMemoryMB = parseInt(tryExec(runtime, "free -m | awk '/Mem:/ {print $2}'"), 10) || 0;
    return {
      type: "nvidia",
      count: 1,
      totalMemoryMB,
      perGpuMB: totalMemoryMB,
      names: ["NVIDIA GB10"],
      family: "dgx-spark",
      families: ["dgx-spark"],
      freeDiskGB: detectDiskSpaceGB(runtime),
      nimCapable: true,
      spark: true,
    };
  }

  if (process.platform !== "darwin") {
    return null;
  }

  const systemProfiler = tryExec(runtime, "system_profiler SPDisplaysDataType 2>/dev/null");
  if (!systemProfiler) {
    return null;
  }

  const chipMatch = systemProfiler.match(/Chipset Model:\s*(.+)/);
  if (!chipMatch) {
    return null;
  }

  const vramMatch = systemProfiler.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
  const coresMatch = systemProfiler.match(/Total Number of Cores:\s*(\d+)/);
  let memoryMB = 0;
  if (vramMatch) {
    memoryMB = parseInt(vramMatch[1], 10);
    if (vramMatch[2].toUpperCase() === "GB") {
      memoryMB *= 1024;
    }
  } else {
    memoryMB = Math.floor((parseInt(tryExec(runtime, "sysctl -n hw.memsize"), 10) || 0) / 1024 / 1024);
  }

  return {
    type: "apple",
    name: chipMatch[1].trim(),
    count: 1,
    cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
    totalMemoryMB: memoryMB,
    perGpuMB: memoryMB,
    nimCapable: false,
  };
}

export function pullNimImage(model: string, runtime: NimRuntime): string {
  const candidates = getPullCandidatesForModel(model);
  if (candidates.length === 0) {
    throw new Error(`Unknown NIM model: ${model}`);
  }

  let lastError = "";
  for (const image of candidates) {
    try {
      runtime.exec(`docker pull ${image}`);
      return image;
    } catch (err) {
      lastError = extractExecErrorMessage(err);
    }
  }

  throw new Error(
    `Failed to pull a local NIM image for ${model}. Tried: ${candidates.join(", ")}${lastError ? `\n${lastError}` : ""}`,
  );
}

export function detectDiskSpaceGB(runtime: NimRuntime): number | null {
  const cacheDir = resolveNimCacheDirectory(runtime);
  if (cacheDir?.freeDiskGB !== null && cacheDir?.freeDiskGB !== undefined) {
    return cacheDir.freeDiskGB;
  }
  const dockerRoot = tryExec(runtime, "docker info --format '{{.DockerRootDir}}' 2>/dev/null") || "/var/lib/docker";
  return detectPathFreeDiskGB(runtime, dockerRoot);
}

function profileMatches(profile: NimProfile, gpu: GpuInfo, freeDiskGB: number | null): boolean {
  if ((profile.gpuFamilies?.length ?? 0) > 0) {
    const families = gpu.families ?? [];
    if (!families.some((family) => profile.gpuFamilies?.includes(family))) {
      return false;
    }
  }
  if ((profile.minGpuCount ?? 1) > gpu.count) {
    return false;
  }
  if ((profile.minPerGpuMemoryMB ?? 0) > gpu.perGpuMB) {
    return false;
  }
  if (freeDiskGB !== null && (profile.minDiskSpaceGB ?? 0) > freeDiskGB) {
    return false;
  }
  return true;
}

function describeGpuFamilies(profile: NimProfile): string {
  const families = profile.gpuFamilies ?? [];
  if (families.length === 0) {
    return "supported GPU";
  }
  if (families.length <= 3) {
    return families.join("/");
  }
  return `${families.slice(0, 3).join("/")}+`;
}

function describeDetectedGpu(gpu: GpuInfo): string {
  if (gpu.family) {
    return gpu.family;
  }
  if ((gpu.families?.length ?? 0) > 0) {
    return gpu.families!.join("/");
  }
  return "detected GPU";
}

function describeProfile(profile: NimProfile): string {
  const count = profile.minGpuCount ?? 1;
  const family = describeGpuFamilies(profile);
  const precision = profile.precision ? ` ${profile.precision.toUpperCase()}` : "";
  const disk = profile.minDiskSpaceGB ? `, ${String(profile.minDiskSpaceGB)} GB disk` : "";
  return `${String(count)}x ${family}${precision}${disk}`;
}

function evaluateProfile(
  profile: NimProfile,
  gpu: GpuInfo,
  freeDiskGB: number | null,
): { matches: boolean; unmetRequirements: string[]; gap: number } {
  const unmetRequirements: string[] = [];
  let gap = 0;

  if ((profile.gpuFamilies?.length ?? 0) > 0) {
    const families = gpu.families ?? [];
    if (!families.some((family) => profile.gpuFamilies?.includes(family))) {
      unmetRequirements.push(
        `published support for ${describeGpuFamilies(profile)} (detected ${describeDetectedGpu(gpu)})`,
      );
      gap += 1000;
    }
  }

  const minGpuCount = profile.minGpuCount ?? 1;
  if (minGpuCount > gpu.count) {
    unmetRequirements.push(`${String(minGpuCount)} GPU${minGpuCount === 1 ? "" : "s"}`);
    gap += (minGpuCount - gpu.count) * 100;
  }

  const minPerGpuMemoryMB = profile.minPerGpuMemoryMB ?? 0;
  if (minPerGpuMemoryMB > gpu.perGpuMB) {
    const requiredGB = Math.ceil(minPerGpuMemoryMB / 1024);
    unmetRequirements.push(`${String(requiredGB)} GB per GPU`);
    gap += Math.ceil((minPerGpuMemoryMB - gpu.perGpuMB) / 1024);
  }

  if (freeDiskGB !== null && (profile.minDiskSpaceGB ?? 0) > freeDiskGB) {
    unmetRequirements.push(`${String(profile.minDiskSpaceGB)} GB free disk`);
    gap += (profile.minDiskSpaceGB ?? 0) - freeDiskGB;
  }

  return {
    matches: unmetRequirements.length === 0,
    unmetRequirements,
    gap,
  };
}

function scoreMatchedProfile(
  model: NimModel,
  profile: NimProfile,
  gpu: GpuInfo,
  freeDiskGB: number | null,
): number {
  let score = 200;
  score -= (model.recommendedRank ?? 50) * 10;

  const tags = new Set(model.recommendedFor ?? []);
  if (tags.has("general")) score += 20;
  if (tags.has("tool-use")) score += 18;
  if (tags.has("coding")) score += 16;
  if (tags.has("reasoning")) score += 12;
  if (tags.has("chat")) score += 8;
  if (tags.has("multimodal")) score -= 10;
  if (tags.has("quality")) score += 4;

  const minGpuCount = profile.minGpuCount ?? 1;
  if (gpu.count === 1 && minGpuCount === 1) {
    score += 20;
  } else if (minGpuCount === gpu.count) {
    score += 10;
  } else {
    score -= (minGpuCount - 1) * 4;
  }

  const requiredPerGpuMB = profile.minPerGpuMemoryMB ?? model.minGpuMemoryMB;
  const memoryHeadroomMB = gpu.perGpuMB - requiredPerGpuMB;
  if (memoryHeadroomMB > 0) {
    score += Math.min(12, Math.floor(memoryHeadroomMB / 8192));
  }

  const requiredDiskGB = profile.minDiskSpaceGB ?? 0;
  if (requiredDiskGB > 0) {
    score -= Math.floor(requiredDiskGB / 40);
  }
  if (freeDiskGB !== null && requiredDiskGB > 0) {
    score += Math.max(0, Math.min(8, Math.floor((freeDiskGB - requiredDiskGB) / 50)));
  }

  if ((profile.gpuFamilies ?? []).includes(gpu.family ?? "")) {
    score += 6;
  }
  if (profile.precision && ["fp8", "mxfp4", "nvfp4", "int4"].includes(profile.precision)) {
    score += 4;
  }
  if (profile.diskSource === "estimate") {
    score -= 3;
  }

  return score;
}

export function assessNimModels(
  gpu: GpuInfo,
  freeDiskGB: number | null = gpu.freeDiskGB ?? null,
): NimModelAssessment[] {
  const compatible: NimModelAssessment[] = [];
  const incompatible: NimModelAssessment[] = [];

  for (const model of listModels()) {
    const profiles = model.profiles ?? [];
    if (profiles.length === 0) {
      const supported = model.minGpuMemoryMB <= gpu.totalMemoryMB;
      if (supported) {
        compatible.push({
          model,
          status: "supported",
          score: 100 - (model.recommendedRank ?? 50),
          reason: `Fits detected hardware (${String(Math.floor(gpu.totalMemoryMB / 1024))} GB total GPU memory).`,
        });
      } else {
        incompatible.push({
          model,
          status: "unsupported",
          score: Number.NEGATIVE_INFINITY,
          reason: `Needs at least ${String(Math.ceil(model.minGpuMemoryMB / 1024))} GB total GPU memory.`,
          unmetRequirements: [`${String(Math.ceil(model.minGpuMemoryMB / 1024))} GB total GPU memory`],
        });
      }
      continue;
    }

    const evaluations = profiles.map((profile) => ({
      profile,
      ...evaluateProfile(profile, gpu, freeDiskGB),
    }));
    const matches = evaluations.filter((evaluation) => evaluation.matches);

    if (matches.length > 0) {
      const bestMatch = matches
        .map((evaluation) => ({
          profile: evaluation.profile,
          score: scoreMatchedProfile(model, evaluation.profile, gpu, freeDiskGB),
        }))
        .sort((left, right) => right.score - left.score)[0];
      compatible.push({
        model,
        status: "supported",
        score: bestMatch.score,
        matchedProfile: bestMatch.profile,
        reason: `Matches the published support profile for ${describeDetectedGpu(gpu)} via ${describeProfile(bestMatch.profile)}.`,
      });
      continue;
    }

    const closest = evaluations.sort((left, right) => left.gap - right.gap)[0];
    incompatible.push({
      model,
      status: "unsupported",
      score: Number.NEGATIVE_INFINITY,
      matchedProfile: closest?.profile,
      unmetRequirements: closest?.unmetRequirements ?? [],
      reason:
        closest && closest.unmetRequirements.length > 0
          ? `Needs ${closest.unmetRequirements.join(", ")}.`
          : "Does not match the detected GPU profile.",
    });
  }

  compatible.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const leftRank = left.model.recommendedRank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.model.recommendedRank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.model.minGpuMemoryMB - right.model.minGpuMemoryMB;
  });

  const recommendedLimit = compatible.length <= 3 ? compatible.length : Math.min(4, compatible.length);
  const topScore = compatible[0]?.score ?? Number.NEGATIVE_INFINITY;
  for (const [index, assessment] of compatible.entries()) {
    if (index < recommendedLimit && assessment.score >= topScore - 18) {
      assessment.status = "recommended";
      assessment.reason = `Recommended on ${describeDetectedGpu(gpu)} based on the published support profile ${describeProfile(assessment.matchedProfile ?? {})}.`;
    }
  }

  incompatible.sort((left, right) => {
    const leftUnmet = left.unmetRequirements?.length ?? 99;
    const rightUnmet = right.unmetRequirements?.length ?? 99;
    if (leftUnmet !== rightUnmet) {
      return leftUnmet - rightUnmet;
    }
    const leftRank = left.model.recommendedRank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.model.recommendedRank ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });

  return [...compatible, ...incompatible];
}

export function getCompatibleModels(gpu: GpuInfo, freeDiskGB: number | null = gpu.freeDiskGB ?? null): NimModel[] {
  return assessNimModels(gpu, freeDiskGB)
    .filter((assessment) => assessment.status !== "unsupported")
    .map((assessment) => assessment.model);
}

export function getRecommendedModels(gpu: GpuInfo, freeDiskGB: number | null = gpu.freeDiskGB ?? null): NimModel[] {
  return assessNimModels(gpu, freeDiskGB)
    .filter((assessment) => assessment.status === "recommended")
    .map((assessment) => assessment.model);
}

export function resolveRunningNimModel(
  runtime: NimRuntime,
  requestedModel: string,
  port = 8000,
): string {
  const fallback = getServedModelForModel(requestedModel);
  const output = tryExec(runtime, `curl -sf http://localhost:${String(port)}/v1/models 2>/dev/null`);
  if (!output) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(output) as { data?: Array<{ id?: string }> };
    const ids = (parsed.data ?? [])
      .map((entry) => entry.id?.trim())
      .filter((value): value is string => Boolean(value));
    if (ids.includes(requestedModel)) {
      return requestedModel;
    }
    if (ids.includes(fallback)) {
      return fallback;
    }
    if (ids.length === 1) {
      return ids[0];
    }
  } catch {}

  return fallback;
}

export function startNimContainer(
  sandboxName: string,
  model: string,
  runtime: NimRuntime,
  port = 8000,
  imageOverride?: string,
  requiredDiskGB?: number | null,
): string {
  const name = containerName(sandboxName);
  const image = imageOverride ?? getImageForModel(model);
  if (!image) {
    throw new Error(`Unknown NIM model: ${model}`);
  }

  tryExec(runtime, `docker rm -f ${name} 2>/dev/null`);
  const runArgs = getContainerCredentialArgs();
  const cacheDir = resolveNimCacheDirectory(runtime, model, requiredDiskGB);
  if (cacheDir) {
    runArgs.push(`-e NIM_CACHE_PATH=${shellQuote("/opt/nim/.cache")}`);
    runArgs.push(`-v ${shellQuote(cacheDir.hostPath)}:/opt/nim/.cache`);
  }
  const envArgs = runArgs.length > 0 ? `${runArgs.join(" ")} ` : "";
  runtime.exec(
    `docker run -d --gpus all -p ${String(port)}:8000 --name ${name} --shm-size 16g ${envArgs}${image}`,
  );
  return name;
}

function getContainerState(runtime: NimRuntime, container: string): string | null {
  const state = tryExec(runtime, `docker inspect --format '{{.State.Status}}' ${container} 2>/dev/null`);
  return state || null;
}

function getContainerLogs(runtime: NimRuntime, container: string, lines = 120): string {
  return tryExec(runtime, `docker logs --tail ${String(lines)} ${container} 2>&1`);
}

function summarizeLogs(logs: string): string {
  return logs.trim().split(/\r?\n/).slice(-20).join("\n");
}

function detectFatalLog(logs: string): { reason: string; detail: string; fatalPattern: string } | null {
  if (!logs) {
    return null;
  }
  for (const entry of NIM_FATAL_LOG_PATTERNS) {
    const match = logs.match(entry.pattern);
    if (match) {
      return {
        reason: entry.reason,
        detail: summarizeLogs(logs),
        fatalPattern: entry.pattern.source,
      };
    }
  }
  return null;
}

export function monitorNimStartup(
  runtime: NimRuntime,
  sandboxName: string,
  port = 8000,
  idleTimeoutSeconds = 1200,
  sleepSeconds = 5,
  maxTimeoutSeconds = 14400,
): NimStartupResult {
  const container = containerName(sandboxName);
  const startTime = Date.now();
  let lastProgressAt = startTime;
  let previousState: string | null = null;
  let previousLogs = "";

  while (Date.now() - startTime < maxTimeoutSeconds * 1000) {
    if (tryExec(runtime, `curl -sf http://localhost:${String(port)}/v1/models 2>/dev/null`)) {
      return { healthy: true, state: "running" };
    }

    const state = getContainerState(runtime, container);
    const logs = getContainerLogs(runtime, container);
    if (state !== previousState || logs !== previousLogs) {
      lastProgressAt = Date.now();
      previousState = state;
      previousLogs = logs;
    }
    const fatal = detectFatalLog(logs);
    if (fatal) {
      return {
        healthy: false,
        state: state ?? "unknown",
        reason: fatal.reason,
        detail: fatal.detail,
        fatalPattern: fatal.fatalPattern,
      };
    }

    if (state && state !== "running" && state !== "created") {
      return {
        healthy: false,
        state,
        reason: `Local NIM container exited before becoming healthy (state: ${state}).`,
        detail: summarizeLogs(logs),
      };
    }

    const idleSeconds = Math.floor((Date.now() - lastProgressAt) / 1000);
    if (idleSeconds >= idleTimeoutSeconds) {
      return {
        healthy: false,
        state: state ?? "unknown",
        idleSeconds,
        reason: `Local NIM made no startup progress for ${String(idleTimeoutSeconds)} seconds.`,
        detail: summarizeLogs(logs),
      };
    }

    tryExec(runtime, `sleep ${String(sleepSeconds)}`);
  }

  const finalLogs = getContainerLogs(runtime, container);
  return {
    healthy: false,
    state: getContainerState(runtime, container) ?? "unknown",
    reason: `Local NIM did not become healthy within the maximum startup window of ${String(maxTimeoutSeconds)} seconds.`,
    detail: summarizeLogs(finalLogs),
  };
}

export function waitForNimHealth(
  runtime: NimRuntime,
  port = 8000,
  timeoutSeconds = 300,
  sleepSeconds = 5,
): boolean {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (tryExec(runtime, `curl -sf http://localhost:${String(port)}/v1/models 2>/dev/null`)) {
      return true;
    }
    tryExec(runtime, `sleep ${String(sleepSeconds)}`);
  }
  return false;
}
