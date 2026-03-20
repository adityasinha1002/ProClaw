// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const path = require("node:path");
const runner = require("./runner");
const nimImages = require("./nim-images.json");
const MODEL_PULL_FALLBACKS = {
  "nvidia/nemotron-3-nano-30b-a3b": ["nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"],
};
const MODEL_SERVED_ID_ALIASES = {
  "nvidia/nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano",
  "z-ai/glm5": "zai-org/GLM-5",
};

function normalizeGpuFamily(name) {
  const value = String(name || "").toLowerCase();
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

function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

function getPullCandidatesForModel(modelName) {
  const primary = getImageForModel(modelName);
  if (!primary) return [];
  return [primary, ...(MODEL_PULL_FALLBACKS[modelName] || [])];
}

function getServedModelForModel(modelName) {
  return MODEL_SERVED_ID_ALIASES[modelName] || modelName;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getNimCacheCandidatePaths() {
  const candidates = [];
  const seen = new Set();
  const user = process.env.USER || "user";
  const push = (candidate) => {
    if (!candidate) return;
    const normalized = String(candidate).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(process.env.NEMOCLAW_NIM_CACHE_DIR);
  push(process.env.LOCAL_NIM_CACHE);

  if (process.env.XDG_CACHE_HOME) {
    push(path.join(process.env.XDG_CACHE_HOME, "nim"));
  }
  if (process.env.HOME) {
    push(path.join(process.env.HOME, ".cache", "nim"));
    push(path.join(process.env.HOME, ".local", "share", "nim-cache"));
  }
  for (const root of ["/workspace", "/data", "/scratch", "/mnt", "/media", "/Volumes", "/var/tmp", "/tmp"]) {
    push(path.join(root, `nemoclaw-nim-cache-${user}`));
  }

  return candidates;
}

function detectPathFreeDiskGB(targetPath) {
  try {
    const availableKB = runner.runCapture(`df -Pk ${shellQuote(targetPath)} | awk 'NR==2 {print $4}'`, {
      ignoreError: true,
    });
    const available = parseInt(availableKB, 10);
    if (!isNaN(available) && available > 0) {
      return Math.floor(available / 1024 / 1024);
    }
  } catch {}
  return null;
}

function isWritableDirectory(targetPath) {
  return (
    runner.runCapture(`mkdir -p ${shellQuote(targetPath)} && test -w ${shellQuote(targetPath)} && printf ok`, {
      ignoreError: true,
    }) === "ok"
  );
}

const NIM_FATAL_LOG_PATTERNS = [
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

function getContainerCredentialArgs() {
  const args = [];
  const nvidiaApiKey = (process.env.NVIDIA_API_KEY || "").trim();
  const ngcApiKey = (process.env.NGC_API_KEY || "").trim() || nvidiaApiKey;
  if (nvidiaApiKey) {
    args.push(`-e NVIDIA_API_KEY=${shellQuote(nvidiaApiKey)}`);
  }
  if (ngcApiKey) {
    args.push(`-e NGC_API_KEY=${shellQuote(ngcApiKey)}`);
  }
  return args;
}

function getModelCacheRequirementGB(modelName, overrideDiskGB) {
  if (typeof overrideDiskGB === "number" && overrideDiskGB > 0) {
    return overrideDiskGB;
  }
  const model = listModels().find((entry) => entry.name === modelName);
  const requirements = (model?.profiles || [])
    .map((profile) => profile.minDiskSpaceGB || 0)
    .filter((value) => value > 0);
  return requirements.length > 0 ? Math.min(...requirements) : 0;
}

function resolveNimCacheDirectory(modelName, requiredDiskGB) {
  const required = getModelCacheRequirementGB(modelName || "", requiredDiskGB);
  const reserveGB = required > 0 ? 20 : 10;
  let best = null;

  for (const candidate of getNimCacheCandidatePaths()) {
    if (!isWritableDirectory(candidate)) continue;
    const freeDiskGB = detectPathFreeDiskGB(candidate);
    if (
      (process.env.NEMOCLAW_NIM_CACHE_DIR || "").trim() === candidate ||
      (process.env.LOCAL_NIM_CACHE || "").trim() === candidate
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

function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
    servedModel: m.servedModel || getServedModelForModel(m.name),
    recommendedRank: m.recommendedRank || Number.MAX_SAFE_INTEGER,
    recommendedFor: m.recommendedFor || [],
    profiles: m.profiles || [],
  }));
}

function detectDiskSpaceGB() {
  const cacheDir = resolveNimCacheDirectory();
  if (cacheDir && cacheDir.freeDiskGB !== null && cacheDir.freeDiskGB !== undefined) {
    return cacheDir.freeDiskGB;
  }
  let dockerRoot = "";
  try {
    dockerRoot = runner.runCapture("docker info --format '{{.DockerRootDir}}'", {
      ignoreError: true,
    });
  } catch {}
  return detectPathFreeDiskGB(dockerRoot || "/var/lib/docker");
}

function profileMatches(profile, gpu, freeDiskGB) {
  const gpuFamilies = profile.gpuFamilies || [];
  if (gpuFamilies.length > 0) {
    const families = gpu.families || [];
    if (!families.some((family) => gpuFamilies.includes(family))) {
      return false;
    }
  }
  if ((profile.minGpuCount || 1) > gpu.count) {
    return false;
  }
  if ((profile.minPerGpuMemoryMB || 0) > gpu.perGpuMB) {
    return false;
  }
  if (freeDiskGB !== null && (profile.minDiskSpaceGB || 0) > freeDiskGB) {
    return false;
  }
  return true;
}

function describeGpuFamilies(profile) {
  const families = profile.gpuFamilies || [];
  if (families.length === 0) return "supported GPU";
  if (families.length <= 3) return families.join("/");
  return `${families.slice(0, 3).join("/")}+`;
}

function describeDetectedGpu(gpu) {
  if (gpu.family) return gpu.family;
  if ((gpu.families || []).length > 0) return gpu.families.join("/");
  return "detected GPU";
}

function describeProfile(profile) {
  const count = profile.minGpuCount || 1;
  const family = describeGpuFamilies(profile);
  const precision = profile.precision ? ` ${String(profile.precision).toUpperCase()}` : "";
  const disk = profile.minDiskSpaceGB ? `, ${String(profile.minDiskSpaceGB)} GB disk` : "";
  return `${String(count)}x ${family}${precision}${disk}`;
}

function evaluateProfile(profile, gpu, freeDiskGB) {
  const unmetRequirements = [];
  let gap = 0;

  if ((profile.gpuFamilies || []).length > 0) {
    const families = gpu.families || [];
    if (!families.some((family) => profile.gpuFamilies.includes(family))) {
      unmetRequirements.push(
        `published support for ${describeGpuFamilies(profile)} (detected ${describeDetectedGpu(gpu)})`
      );
      gap += 1000;
    }
  }

  const minGpuCount = profile.minGpuCount || 1;
  if (minGpuCount > gpu.count) {
    unmetRequirements.push(`${String(minGpuCount)} GPU${minGpuCount === 1 ? "" : "s"}`);
    gap += (minGpuCount - gpu.count) * 100;
  }

  const minPerGpuMemoryMB = profile.minPerGpuMemoryMB || 0;
  if (minPerGpuMemoryMB > gpu.perGpuMB) {
    unmetRequirements.push(`${String(Math.ceil(minPerGpuMemoryMB / 1024))} GB per GPU`);
    gap += Math.ceil((minPerGpuMemoryMB - gpu.perGpuMB) / 1024);
  }

  if (freeDiskGB !== null && (profile.minDiskSpaceGB || 0) > freeDiskGB) {
    unmetRequirements.push(`${String(profile.minDiskSpaceGB)} GB free disk`);
    gap += (profile.minDiskSpaceGB || 0) - freeDiskGB;
  }

  return { matches: unmetRequirements.length === 0, unmetRequirements, gap };
}

function scoreMatchedProfile(model, profile, gpu, freeDiskGB) {
  let score = 200;
  score -= (model.recommendedRank || 50) * 10;

  const tags = new Set(model.recommendedFor || []);
  if (tags.has("general")) score += 20;
  if (tags.has("tool-use")) score += 18;
  if (tags.has("coding")) score += 16;
  if (tags.has("reasoning")) score += 12;
  if (tags.has("chat")) score += 8;
  if (tags.has("multimodal")) score -= 10;
  if (tags.has("quality")) score += 4;

  const minGpuCount = profile.minGpuCount || 1;
  if (gpu.count === 1 && minGpuCount === 1) score += 20;
  else if (minGpuCount === gpu.count) score += 10;
  else score -= (minGpuCount - 1) * 4;

  const requiredPerGpuMB = profile.minPerGpuMemoryMB || model.minGpuMemoryMB;
  const memoryHeadroomMB = gpu.perGpuMB - requiredPerGpuMB;
  if (memoryHeadroomMB > 0) {
    score += Math.min(12, Math.floor(memoryHeadroomMB / 8192));
  }

  const requiredDiskGB = profile.minDiskSpaceGB || 0;
  if (requiredDiskGB > 0) score -= Math.floor(requiredDiskGB / 40);
  if (freeDiskGB !== null && requiredDiskGB > 0) {
    score += Math.max(0, Math.min(8, Math.floor((freeDiskGB - requiredDiskGB) / 50)));
  }

  if ((profile.gpuFamilies || []).includes(gpu.family || "")) score += 6;
  if (profile.precision && ["fp8", "mxfp4", "nvfp4", "int4"].includes(profile.precision)) score += 4;
  if (profile.diskSource === "estimate") score -= 3;
  return score;
}

function assessNimModels(gpu, freeDiskGB = gpu.freeDiskGB ?? null) {
  const compatible = [];
  const incompatible = [];

  for (const model of listModels()) {
    const profiles = model.profiles || [];
    if (profiles.length === 0) {
      const supported = model.minGpuMemoryMB <= gpu.totalMemoryMB;
      if (supported) {
        compatible.push({
          model,
          status: "supported",
          score: 100 - (model.recommendedRank || 50),
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

    const evaluations = profiles.map((profile) => ({ profile, ...evaluateProfile(profile, gpu, freeDiskGB) }));
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
      matchedProfile: closest && closest.profile,
      unmetRequirements: (closest && closest.unmetRequirements) || [],
      reason:
        closest && closest.unmetRequirements.length > 0
          ? `Needs ${closest.unmetRequirements.join(", ")}.`
          : "Does not match the detected GPU profile.",
    });
  }

  compatible.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if ((left.model.recommendedRank || Number.MAX_SAFE_INTEGER) !== (right.model.recommendedRank || Number.MAX_SAFE_INTEGER)) {
      return (left.model.recommendedRank || Number.MAX_SAFE_INTEGER) - (right.model.recommendedRank || Number.MAX_SAFE_INTEGER);
    }
    return left.model.minGpuMemoryMB - right.model.minGpuMemoryMB;
  });

  const recommendedLimit = compatible.length <= 3 ? compatible.length : Math.min(4, compatible.length);
  const topScore = compatible[0] ? compatible[0].score : Number.NEGATIVE_INFINITY;
  compatible.forEach((assessment, index) => {
    if (index < recommendedLimit && assessment.score >= topScore - 18) {
      assessment.status = "recommended";
      assessment.reason = `Recommended on ${describeDetectedGpu(gpu)} based on the published support profile ${describeProfile(assessment.matchedProfile || {})}.`;
    }
  });

  incompatible.sort((left, right) => {
    const leftUnmet = (left.unmetRequirements || []).length;
    const rightUnmet = (right.unmetRequirements || []).length;
    if (leftUnmet !== rightUnmet) return leftUnmet - rightUnmet;
    return (left.model.recommendedRank || Number.MAX_SAFE_INTEGER) - (right.model.recommendedRank || Number.MAX_SAFE_INTEGER);
  });

  return [...compatible, ...incompatible];
}

function getCompatibleModels(gpu, freeDiskGB = null) {
  return assessNimModels(gpu, freeDiskGB)
    .filter((assessment) => assessment.status !== "unsupported")
    .map((assessment) => assessment.model);
}

function getRecommendedModels(gpu, freeDiskGB = gpu.freeDiskGB ?? null) {
  return assessNimModels(gpu, freeDiskGB)
    .filter((assessment) => assessment.status === "recommended")
    .map((assessment) => assessment.model);
}

function resolveRunningNimModel(requestedModel, port = 8000) {
  const fallback = getServedModelForModel(requestedModel);
  try {
    const output = runner.runCapture(`curl -sf http://localhost:${port}/v1/models 2>/dev/null`, {
      ignoreError: true,
    });
    if (!output) return fallback;
    const parsed = JSON.parse(output);
    const ids = (parsed.data || []).map((entry) => (entry.id || "").trim()).filter(Boolean);
    if (ids.includes(requestedModel)) return requestedModel;
    if (ids.includes(fallback)) return fallback;
    if (ids.length === 1) return ids[0];
  } catch {}
  return fallback;
}

function detectGpu() {
  // Try NVIDIA first — query VRAM
  try {
    const nameOutput = runner.runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    const output = runner.runCapture(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
      const names = nameOutput.split("\n").map((line) => line.trim()).filter(Boolean);
      const families = [...new Set(names.map(normalizeGpuFamily).filter(Boolean))];
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          names,
          family: families[0] || null,
          families,
          freeDiskGB: detectDiskSpaceGB(),
          nimCapable: true,
        };
      }
    }
  } catch {}

  // Fallback: DGX Spark (GB10) — VRAM not queryable due to unified memory architecture
  try {
    const nameOutput = runner.runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      // GB10 has 128GB unified memory shared with Grace CPU — use system RAM
      let totalMemoryMB = 0;
      try {
        const memLine = runner.runCapture("free -m | awk '/Mem:/ {print $2}'", { ignoreError: true });
        if (memLine) totalMemoryMB = parseInt(memLine.trim(), 10) || 0;
      } catch {}
      return {
        type: "nvidia",
        count: 1,
        totalMemoryMB,
        perGpuMB: totalMemoryMB,
        names: ["NVIDIA GB10"],
        family: "dgx-spark",
        families: ["dgx-spark"],
        freeDiskGB: detectDiskSpaceGB(),
        nimCapable: true,
        spark: true,
      };
    }
  } catch {}

  // macOS: detect Apple Silicon or discrete GPU
  if (process.platform === "darwin") {
    try {
      const spOutput = runner.runCapture(
        "system_profiler SPDisplaysDataType 2>/dev/null",
        { ignoreError: true }
      );
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            // Apple Silicon shares system RAM — read total memory
            try {
              const memBytes = runner.runCapture("sysctl -n hw.memsize", { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {}
  }

  return null;
}

function pullNimImage(model) {
  const images = getPullCandidatesForModel(model);
  if (images.length === 0) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  let lastError = null;
  for (const image of images) {
    console.log(`  Pulling NIM image: ${image}`);
    const result = runner.run(`docker pull ${image}`, { ignoreError: true });
    if (result.status === 0) {
      return image;
    }
    lastError = new Error(`docker pull failed for ${image} (exit ${result.status || 1})`);
  }

  if (lastError) {
    throw lastError;
  }
  return null;
}

function startNimContainer(sandboxName, model, port = 8000, imageOverride = null, requiredDiskGB = null) {
  const name = containerName(sandboxName);
  const image = imageOverride || getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  // Stop any existing container with same name
  runner.run(`docker rm -f ${name} 2>/dev/null || true`, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  const envArgs = getContainerCredentialArgs();
  const cacheDir = resolveNimCacheDirectory(model, requiredDiskGB);
  if (cacheDir) {
    envArgs.push(`-e NIM_CACHE_PATH=${shellQuote("/opt/nim/.cache")}`);
    envArgs.push(`-v ${shellQuote(cacheDir.hostPath)}:/opt/nim/.cache`);
  }
  runner.run(
    `docker run -d --gpus all -p ${port}:8000 --name ${name} --shm-size 16g ${envArgs.join(" ")} ${image}`.trim()
  );
  return name;
}

function getContainerState(container) {
  const state = runner.runCapture(
    `docker inspect --format '{{.State.Status}}' ${container} 2>/dev/null`,
    { ignoreError: true }
  );
  return state || null;
}

function getContainerLogs(container, lines = 120) {
  return runner.runCapture(`docker logs --tail ${String(lines)} ${container} 2>&1`, {
    ignoreError: true,
  });
}

function summarizeLogs(logs) {
  return logs.trim().split(/\r?\n/).slice(-20).join("\n");
}

function detectFatalLog(logs) {
  if (!logs) return null;
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

function monitorNimStartup(sandboxName, port = 8000, idleTimeout = 1200, sleepSeconds = 5, maxTimeout = 14400) {
  const container = containerName(sandboxName);
  const start = Date.now();
  let lastProgressAt = start;
  let previousState = null;
  let previousLogs = "";
  console.log(`  Waiting for NIM health on port ${port} (idle timeout: ${idleTimeout}s, max: ${maxTimeout}s)...`);

  while ((Date.now() - start) / 1000 < maxTimeout) {
    try {
      const result = runner.runCapture(`curl -sf http://localhost:${port}/v1/models`, {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return { healthy: true, state: "running" };
      }
    } catch {}

    const state = getContainerState(container);
    const logs = getContainerLogs(container);
    if (state !== previousState || logs !== previousLogs) {
      lastProgressAt = Date.now();
      previousState = state;
      previousLogs = logs;
    }
    const fatal = detectFatalLog(logs);
    if (fatal) {
      return { healthy: false, state: state || "unknown", ...fatal };
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
    if (idleSeconds >= idleTimeout) {
      return {
        healthy: false,
        state: state || "unknown",
        idleSeconds,
        reason: `Local NIM made no startup progress for ${idleTimeout}s.`,
        detail: summarizeLogs(logs),
      };
    }

    require("child_process").spawnSync("sleep", [String(sleepSeconds)]);
  }

  const finalLogs = getContainerLogs(container);
  return {
    healthy: false,
    state: getContainerState(container) || "unknown",
    reason: `Local NIM did not become healthy within the maximum startup window of ${maxTimeout}s.`,
    detail: summarizeLogs(finalLogs),
  };
}

function waitForNimHealth(port = 8000, timeout = 300) {
  const start = Date.now();
  const interval = 5000;
  console.log(`  Waiting for NIM health on port ${port} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runner.runCapture(`curl -sf http://localhost:${port}/v1/models`, {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {}
    // Synchronous sleep via spawnSync
    require("child_process").spawnSync("sleep", ["5"]);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

function stopNimContainer(sandboxName) {
  const name = containerName(sandboxName);
  console.log(`  Stopping NIM container: ${name}`);
  runner.run(`docker stop ${name} 2>/dev/null || true`, { ignoreError: true });
  runner.run(`docker rm ${name} 2>/dev/null || true`, { ignoreError: true });
}

function nimStatus(sandboxName) {
  const name = containerName(sandboxName);
  try {
    const state = runner.runCapture(
      `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`,
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      const health = runner.runCapture(`curl -sf http://localhost:8000/v1/models 2>/dev/null`, {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  getServedModelForModel,
  listModels,
  detectGpu,
  detectDiskSpaceGB,
  assessNimModels,
  getCompatibleModels,
  getRecommendedModels,
  resolveRunningNimModel,
  monitorNimStartup,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};
