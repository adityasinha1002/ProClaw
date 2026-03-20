"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_OLLAMA_MODEL = exports.CONTAINER_REACHABILITY_IMAGE = exports.HOST_GATEWAY_URL = void 0;
exports.getLocalProviderBaseUrl = getLocalProviderBaseUrl;
exports.getLocalProviderHealthCheck = getLocalProviderHealthCheck;
exports.getLocalProviderContainerReachabilityCheck = getLocalProviderContainerReachabilityCheck;
exports.validateLocalProvider = validateLocalProvider;
exports.parseOllamaList = parseOllamaList;
exports.getOllamaModelOptions = getOllamaModelOptions;
exports.getDefaultOllamaModel = getDefaultOllamaModel;
exports.HOST_GATEWAY_URL = "http://host.openshell.internal";
exports.CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
exports.DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
function getLocalProviderBaseUrl(provider) {
    switch (provider) {
        case "nim-local":
        case "vllm-local":
            return `${exports.HOST_GATEWAY_URL}:8000/v1`;
        case "ollama-local":
            return `${exports.HOST_GATEWAY_URL}:11434/v1`;
    }
}
function getLocalProviderHealthCheck(provider) {
    switch (provider) {
        case "nim-local":
        case "vllm-local":
            return "curl -sf http://localhost:8000/v1/models 2>/dev/null";
        case "ollama-local":
            return "curl -sf http://localhost:11434/api/tags 2>/dev/null";
    }
}
function getLocalProviderContainerReachabilityCheck(provider) {
    switch (provider) {
        case "nim-local":
        case "vllm-local":
            return `docker run --rm --add-host host.openshell.internal:host-gateway ${exports.CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
        case "ollama-local":
            return `docker run --rm --add-host host.openshell.internal:host-gateway ${exports.CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`;
    }
}
function validateLocalProvider(provider, runCapture) {
    const output = runCapture(getLocalProviderHealthCheck(provider));
    if (!output) {
        switch (provider) {
            case "nim-local":
                return {
                    ok: false,
                    message: "Local NIM was selected, but nothing is responding on http://localhost:8000.",
                };
            case "vllm-local":
                return {
                    ok: false,
                    message: "Local vLLM was selected, but nothing is responding on http://localhost:8000.",
                };
            case "ollama-local":
                return {
                    ok: false,
                    message: "Local Ollama was selected, but nothing is responding on http://localhost:11434.",
                };
        }
    }
    const containerOutput = runCapture(getLocalProviderContainerReachabilityCheck(provider));
    if (containerOutput) {
        return { ok: true };
    }
    switch (provider) {
        case "nim-local":
            return {
                ok: false,
                message: "Local NIM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the NIM container publishes port 8000 and the host gateway alias is available to sandboxes.",
            };
        case "vllm-local":
            return {
                ok: false,
                message: "Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the server is reachable from containers, not only from the host shell.",
            };
        case "ollama-local":
            return {
                ok: false,
                message: "Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:11434. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.",
            };
    }
}
function parseOllamaList(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^NAME\s+/i.test(line))
        .map((line) => line.split(/\s{2,}/)[0])
        .filter(Boolean);
}
function getOllamaModelOptions(runCapture) {
    const parsed = parseOllamaList(runCapture("ollama list 2>/dev/null"));
    return parsed.length > 0 ? parsed : [exports.DEFAULT_OLLAMA_MODEL];
}
function getDefaultOllamaModel(runCapture) {
    const models = getOllamaModelOptions(runCapture);
    return models.includes(exports.DEFAULT_OLLAMA_MODEL) ? exports.DEFAULT_OLLAMA_MODEL : models[0];
}
//# sourceMappingURL=local-inference.js.map