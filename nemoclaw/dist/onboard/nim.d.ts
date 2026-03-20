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
export declare function createNimRuntime(): NimRuntime;
export declare function getServedModelForModel(modelName: string): string;
export declare function containerName(sandboxName: string): string;
export declare function listModels(): NimModel[];
export declare function getImageForModel(modelName: string): string | null;
export declare function detectGpu(runtime: NimRuntime): GpuInfo | null;
export declare function pullNimImage(model: string, runtime: NimRuntime): string;
export declare function detectDiskSpaceGB(runtime: NimRuntime): number | null;
export declare function assessNimModels(gpu: GpuInfo, freeDiskGB?: number | null): NimModelAssessment[];
export declare function getCompatibleModels(gpu: GpuInfo, freeDiskGB?: number | null): NimModel[];
export declare function getRecommendedModels(gpu: GpuInfo, freeDiskGB?: number | null): NimModel[];
export declare function resolveRunningNimModel(runtime: NimRuntime, requestedModel: string, port?: number): string;
export declare function startNimContainer(sandboxName: string, model: string, runtime: NimRuntime, port?: number, imageOverride?: string, requiredDiskGB?: number | null): string;
export declare function monitorNimStartup(runtime: NimRuntime, sandboxName: string, port?: number, idleTimeoutSeconds?: number, sleepSeconds?: number, maxTimeoutSeconds?: number): NimStartupResult;
export declare function waitForNimHealth(runtime: NimRuntime, port?: number, timeoutSeconds?: number, sleepSeconds?: number): boolean;
//# sourceMappingURL=nim.d.ts.map