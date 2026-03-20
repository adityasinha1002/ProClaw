export declare const HOST_GATEWAY_URL = "http://host.openshell.internal";
export declare const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
export declare const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
export interface LocalProviderValidation {
    ok: boolean;
    message?: string;
}
type LocalProvider = "nim-local" | "ollama-local" | "vllm-local";
type RunCapture = (command: string) => string;
export declare function getLocalProviderBaseUrl(provider: LocalProvider): string;
export declare function getLocalProviderHealthCheck(provider: LocalProvider): string;
export declare function getLocalProviderContainerReachabilityCheck(provider: LocalProvider): string;
export declare function validateLocalProvider(provider: LocalProvider, runCapture: RunCapture): LocalProviderValidation;
export declare function parseOllamaList(output: string): string[];
export declare function getOllamaModelOptions(runCapture: RunCapture): string[];
export declare function getDefaultOllamaModel(runCapture: RunCapture): string;
export {};
//# sourceMappingURL=local-inference.d.ts.map