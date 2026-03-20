export interface GpuInfo {
    type: "nvidia" | "apple";
    count: number;
    totalMemoryMB: number;
    perGpuMB: number;
    nimCapable: boolean;
    name?: string;
    cores?: number | null;
    spark?: boolean;
}
export interface NimModel {
    name: string;
    image: string;
    minGpuMemoryMB: number;
}
export interface NimRuntime {
    exec(command: string): string;
}
export declare function createNimRuntime(): NimRuntime;
export declare function containerName(sandboxName: string): string;
export declare function listModels(): NimModel[];
export declare function getImageForModel(modelName: string): string | null;
export declare function detectGpu(runtime: NimRuntime): GpuInfo | null;
export declare function pullNimImage(model: string, runtime: NimRuntime): string;
export declare function startNimContainer(sandboxName: string, model: string, runtime: NimRuntime, port?: number, imageOverride?: string): string;
export declare function waitForNimHealth(runtime: NimRuntime, port?: number, timeoutSeconds?: number, sleepSeconds?: number): boolean;
//# sourceMappingURL=nim.d.ts.map