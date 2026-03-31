---
title:
  page: "NemoClaw Security Best Practices — Controls, Risks, and Posture Profiles"
  nav: "Security Best Practices"
description: "A risk framework for every configurable security control in NemoClaw: defaults, what you can change, and what happens if you do."
keywords: ["nemoclaw security best practices", "sandbox security controls risk framework"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "security", "network_policy", "nemoclaw"]
content:
  type: concept
  difficulty: intermediate
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Security Best Practices

NemoClaw ships with deny-by-default security controls across four layers: network, filesystem, process, and inference.
Every control can be tuned, but each change shifts the risk profile.
This page documents every configurable knob, its default, what it protects, the concrete risk of relaxing it, and a recommendation for common use cases.

For background on how the layers fit together, refer to [How It Works](../about/how-it-works.md).

## Protection Layers at a Glance

NemoClaw enforces security at four layers.
Some are locked when the sandbox is created and require a restart to change.
Others can be hot-reloaded while the sandbox is running.

```{mermaid}
flowchart LR
    subgraph locked ["Locked at Creation"]
        FS["Filesystem<br/>Read-only mounts<br/>Landlock LSM<br/>Config integrity hash<br/>Immutable flag"]
        PROC["Process<br/>Capability drops<br/>ulimit · PATH lock<br/>Gateway user isolation<br/>Non-root agent"]
    end

    subgraph hotReload ["Hot-Reloadable at Runtime"]
        NET["Network<br/>Deny-by-default egress<br/>Binary-scoped rules<br/>Operator approval"]
        INF["Inference<br/>Routed via gateway<br/>Credential isolation<br/>Provider selection"]
    end

    AGENT["Agent in Sandbox"] --> NET
    AGENT --> FS
    AGENT --> PROC
    AGENT --> INF
```

:::{list-table}
:header-rows: 1
:widths: 20 30 20 30

* - Layer
  - What it protects
  - Enforcement point
  - Changeable at runtime

* - Network
  - Unauthorized outbound connections and data exfiltration.
  - OpenShell gateway
  - Yes. Use `openshell policy set` or operator approval.

* - Filesystem
  - System binary tampering, credential theft, config manipulation.
  - Landlock LSM + container mounts
  - No. Requires sandbox re-creation.

* - Process
  - Privilege escalation, fork bombs, syscall abuse.
  - Container runtime (Docker/K8s `securityContext`)
  - No. Requires sandbox re-creation.

* - Inference
  - Credential exposure, unauthorized model access, cost overruns.
  - OpenShell gateway
  - Yes. Use `openshell inference set`.

:::

## Network Controls

### Deny-by-Default Egress

The sandbox blocks all outbound connections unless an endpoint is explicitly listed in the policy file `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.

| Aspect | Detail |
|---|---|
| Default | All egress denied. Only endpoints in the baseline policy are reachable. |
| What you can change | Add endpoints to the policy file (static) or via `openshell policy set` (dynamic). |
| Risk if relaxed | Each allowed endpoint is a potential data exfiltration path. The agent can send workspace content, credentials, or conversation history to any reachable host. |
| Recommendation | Add only endpoints the agent needs for its task. Prefer operator approval for one-off requests over permanently widening the baseline. |

### Binary-Scoped Endpoint Rules

Each network policy entry restricts which executables can reach the endpoint via the `binaries` field.

OpenShell identifies the calling binary by reading `/proc/<pid>/exe` (the kernel-trusted executable path, not `argv[0]`), walking the process tree for ancestor binaries, and computing a SHA256 hash of each binary on first use.
If a binary is replaced while the sandbox is running, the hash mismatch triggers an immediate deny.

| Aspect | Detail |
|---|---|
| Default | Endpoints are restricted to specific binaries. For example, only `/usr/bin/gh` and `/usr/bin/git` can reach `github.com`. Binary paths support glob patterns (`*` matches one path component, `**` matches recursively). |
| What you can change | Add binaries to an endpoint entry, or omit the `binaries` field to allow any executable. |
| Risk if relaxed | Removing binary restrictions lets any process in the sandbox reach the endpoint. An agent could use `curl`, `wget`, or a Python script to exfiltrate data to an allowed host, bypassing the intended usage pattern. |
| Recommendation | Always scope endpoints to the binaries that need them. If the agent needs a host from a new binary, add that binary explicitly rather than removing the restriction. |

### Path-Scoped HTTP Rules

Endpoint rules can restrict allowed HTTP methods and URL paths.

| Aspect | Detail |
|---|---|
| Default | Most endpoints allow GET and POST on `/**`. Some are read-only (GET only), such as `docs.openclaw.ai`. |
| What you can change | Add methods (PUT, DELETE, PATCH) or restrict paths to specific prefixes. |
| Risk if relaxed | Allowing all methods on an API endpoint gives the agent write and delete access. For example, allowing DELETE on `api.github.com` lets the agent delete repositories. |
| Recommendation | Use GET-only rules for endpoints that the agent only reads. Add write methods only for endpoints where the agent must create or modify resources. Restrict paths to specific API routes when possible. |

### L4-Only vs L7 Inspection (`protocol` Field)

All sandbox egress goes through OpenShell's CONNECT proxy.
The `protocol` field on an endpoint controls whether the proxy also inspects individual HTTP requests inside the tunnel.

| Aspect | Detail |
|---|---|
| Default | Endpoints without a `protocol` field use L4-only enforcement: the proxy checks host, port, and binary identity, then relays the TCP stream without inspecting payloads. Endpoints with `protocol: rest` enable L7 inspection: the proxy auto-detects and terminates TLS, then evaluates each HTTP request's method and path against the endpoint's `rules` or `access` preset. |
| What you can change | Add `protocol: rest` to an endpoint to enable per-request HTTP inspection. Use the `access` preset (`full`, `read-only`, `read-write`) or explicit `rules` to control allowed methods and paths. |
| Risk if relaxed | L4-only endpoints (no `protocol` field) allow the agent to send any data through the tunnel after the initial connection is permitted. The proxy cannot see or filter the HTTP method, path, or body. The `access: full` preset with `protocol: rest` enables inspection but allows all methods and paths, so it does not restrict what the agent can do at the HTTP level. |
| Recommendation | Use `protocol: rest` with specific `rules` for REST APIs where you want method and path control. Use `protocol: rest` with `access: read-only` for endpoints that should be read-only. Omit `protocol` only for non-HTTP protocols (WebSocket, gRPC streaming) or endpoints where HTTP inspection is not needed. |

### Operator Approval Flow

When the agent reaches an unlisted endpoint, OpenShell blocks the request and prompts the operator in the TUI.

| Aspect | Detail |
|---|---|
| Default | Enabled. All unlisted endpoints are blocked and require approval. |
| What you can change | Approved endpoints are merged into the sandbox's policy as a new durable revision. They persist across sandbox restarts within the same sandbox instance. However, when the sandbox is destroyed and recreated (for example, by running `nemoclaw onboard`), the policy resets to the baseline defined in the blueprint. |
| Risk if relaxed | Approving an endpoint permanently widens the running sandbox's policy. If you approve a broad domain (such as a CDN that hosts arbitrary content), the agent can fetch anything from that domain until the sandbox is destroyed and recreated. |
| Recommendation | Review each blocked request before approving. If you find yourself approving the same endpoint repeatedly, add it to the baseline policy with appropriate binary and path restrictions. To reset approved endpoints, destroy and recreate the sandbox. |

### Policy Presets

NemoClaw ships preset policy files in `nemoclaw-blueprint/policies/presets/` for common integrations.

| Preset | What it enables | Key risk |
|---|---|---|
| `discord` | Discord REST API, WebSocket gateway, CDN. | CDN endpoint (`cdn.discordapp.com`) allows GET to any path. WebSocket uses `access: full` (no inspection). |
| `docker` | Docker Hub, NVIDIA container registry. | Allows pulling arbitrary container images into the sandbox. |
| `huggingface` | Hugging Face model registry. | Allows downloading arbitrary models and datasets. |
| `jira` | Atlassian Jira API. | Gives agent read/write access to project issues and comments. |
| `npm` | npm and Yarn registries. | Allows installing arbitrary npm packages, which may contain malicious code. |
| `outlook` | Microsoft 365, Outlook. | Gives agent access to email. |
| `pypi` | Python Package Index. | Allows installing arbitrary Python packages, which may contain malicious code. |
| `slack` | Slack API, Socket Mode, webhooks. | WebSocket uses `access: full`. Agent can post to any channel the bot token has access to. |
| `telegram` | Telegram Bot API. | Agent can send messages to any chat the bot token has access to. |

**Recommendation:** Apply presets only when the agent's task requires the integration. Review the preset's YAML file before applying to understand the endpoints, methods, and binary restrictions it adds.

## Filesystem Controls

### Read-Only System Paths

System directories are mounted read-only to prevent the agent from modifying binaries, libraries, or configuration files.

| Aspect | Detail |
|---|---|
| Default | `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/app`, `/etc`, `/var/log` are read-only. |
| What you can change | Add or remove paths in the `filesystem_policy.read_only` section of the policy file. |
| Risk if relaxed | Making `/usr` or `/lib` writable lets the agent replace system binaries (such as `curl` or `node`) with trojanized versions. Making `/etc` writable lets the agent modify DNS resolution, TLS trust stores, or user accounts. |
| Recommendation | Never make system paths writable. If the agent needs a writable location for generated files, use a subdirectory of `/sandbox`. |

### Read-Only `.openclaw` Config

The `/sandbox/.openclaw` directory contains the OpenClaw gateway configuration, including auth tokens and CORS settings.
It is mounted read-only while writable agent state (plugins, agent data) lives in `/sandbox/.openclaw-data` via symlinks.

Multiple defense layers protect this directory:

- **DAC permissions.** The directory and `openclaw.json` are owned by root with `chmod 444`, so the sandbox user cannot write to them.
- **Immutable flag.** The entrypoint applies `chattr +i` to the directory and all symlinks, preventing modification even if other controls are bypassed.
- **Symlink validation.** At startup, every symlink in `.openclaw` is verified to point to the expected `.openclaw-data` target. If any symlink points elsewhere, the container refuses to start.
- **Config integrity hash.** A sha256 hash of `openclaw.json` is pinned at build time. The entrypoint verifies it at startup and refuses to start if the hash does not match.

| Aspect | Detail |
|---|---|
| Default | `/sandbox/.openclaw` is read-only, root-owned, immutable, and integrity-verified at startup. `/sandbox/.openclaw-data` is writable. |
| What you can change | Move `/sandbox/.openclaw` from `read_only` to `read_write` in the policy file. |
| Risk if relaxed | A writable `.openclaw` directory lets the agent modify its own gateway config: disabling CORS, changing auth tokens, or redirecting inference to an attacker-controlled endpoint. This is the single most dangerous filesystem change. |
| Recommendation | Never make `/sandbox/.openclaw` writable. |

### Writable Paths

The agent has read-write access to `/sandbox`, `/tmp`, and `/dev/null`.

| Aspect | Detail |
|---|---|
| Default | `/sandbox` (agent workspace), `/tmp` (temporary files), `/dev/null`. |
| What you can change | Add additional writable paths in `filesystem_policy.read_write`. |
| Risk if relaxed | Each additional writable path expands the agent's ability to persist data and potentially modify system behavior. Adding `/var` lets the agent write to log directories. Adding `/home` gives access to other user directories. |
| Recommendation | Keep writable paths to `/sandbox` and `/tmp`. If the agent needs a persistent working directory, create a subdirectory under `/sandbox`. |

### Landlock LSM Enforcement

Landlock is a Linux Security Module that enforces filesystem access rules at the kernel level.

| Aspect | Detail |
|---|---|
| Default | `compatibility: best_effort`. Landlock rules are applied when the kernel supports them and silently skipped on older kernels. |
| What you can change | This is a NemoClaw default, not a user-facing knob. |
| Risk if relaxed | On kernels without Landlock support (pre-5.13), filesystem restrictions rely solely on container mount configuration, which is less granular. |
| Recommendation | Run on a kernel that supports Landlock (5.13+). Ubuntu 22.04 LTS and later include Landlock support. |

## Process Controls

### Capability Drops

The entrypoint drops dangerous Linux capabilities from the bounding set at startup using `capsh`.
This limits what capabilities any child process (gateway, sandbox, agent) can ever acquire.

The following capabilities are dropped: `cap_net_raw`, `cap_dac_override`, `cap_sys_chroot`, `cap_fsetid`, `cap_setfcap`, `cap_mknod`, `cap_audit_write`, `cap_net_bind_service`.
The following are kept because the entrypoint needs them for privilege separation via gosu: `cap_chown`, `cap_setuid`, `cap_setgid`, `cap_fowner`, `cap_kill`.

This is best-effort: if `capsh` is not available or `CAP_SETPCAP` is not in the bounding set, the entrypoint logs a warning and continues with the default capability set.
For additional protection, pass `--cap-drop=ALL` via `docker run` or Compose (see [Sandbox Hardening](../deployment/sandbox-hardening.md)).

| Aspect | Detail |
|---|---|
| Default | Dangerous capabilities dropped at startup via `capsh`. Best-effort. |
| What you can change | When launching with `docker run` directly, pass `--cap-drop=ALL --cap-add=NET_BIND_SERVICE` for stricter enforcement. In the standard NemoClaw flow (via `nemoclaw onboard`), the entrypoint handles capability dropping automatically. |
| Risk if relaxed | `CAP_NET_RAW` allows raw socket access for network sniffing. `CAP_DAC_OVERRIDE` bypasses filesystem permission checks. `CAP_SYS_CHROOT` can be used in container escape chains. If `capsh` is unavailable, the container runs with the default Docker capability set. |
| Recommendation | Run on an image that includes `capsh` (the NemoClaw image does via `libcap2-bin`). For defense-in-depth, also pass `--cap-drop=ALL` at the container runtime level. |

### Gateway Process Isolation

The OpenClaw gateway runs as a separate `gateway` user, not as the `sandbox` user that runs the agent.

| Aspect | Detail |
|---|---|
| Default | The entrypoint starts the gateway process via `gosu gateway`, isolating it from the agent's `sandbox` user. |
| What you can change | This is not a user-facing knob. It is enforced by the entrypoint when running as root. In non-root mode (when OpenShell sets `no-new-privileges`), gateway process isolation is not available because `gosu` cannot change users. |
| Risk if relaxed | If the gateway and agent run as the same user, the agent can kill the gateway process and restart it with a tampered configuration (the "fake-HOME" attack). |
| Recommendation | No action needed. The entrypoint handles this automatically. Be aware that non-root mode disables this isolation. |

### No New Privileges

The `no-new-privileges` flag prevents processes from gaining additional privileges through setuid binaries or capability inheritance.

| Aspect | Detail |
|---|---|
| Default | OpenShell sets `PR_SET_NO_NEW_PRIVS` via `prctl()` inside the sandbox process as part of the seccomp filter setup. The NemoClaw Compose example also shows the equivalent `security_opt: no-new-privileges:true` setting. |
| What you can change | This is enforced inside the sandbox by OpenShell's seccomp path. It is not a user-facing knob. |
| Risk if relaxed | Without this flag, a compromised process could execute a setuid binary to escalate to root inside the container, then attempt container escape techniques. |
| Recommendation | No action needed. OpenShell enforces this automatically when the sandbox network policy is active. Note: this flag prevents `gosu` from switching users, so gateway process isolation in the NemoClaw entrypoint is disabled in non-root mode. |

### Process Limit

A process limit caps the number of processes the sandbox user can spawn.
The entrypoint sets both soft and hard limits via `ulimit -u 512`.
This is best-effort: if the container runtime restricts `ulimit` modification, the entrypoint logs a security warning and continues without the limit.

| Aspect | Detail |
|---|---|
| Default | 512 processes (`ulimit -u 512`), best-effort. |
| What you can change | Increase or decrease the limit via `--ulimit nproc=N:N` in `docker run` or the `ulimits` section in Compose. The runtime-level ulimit takes precedence over the entrypoint's setting. |
| Risk if relaxed | Removing or raising the limit makes the sandbox vulnerable to fork-bomb attacks, where a runaway process spawns children until the host runs out of resources. If the entrypoint cannot set the limit (logs `[SECURITY] Could not set soft/hard nproc limit`), the container runs without process limits. |
| Recommendation | Keep the default at 512. If the agent runs workloads that spawn many child processes (such as parallel test runners), increase to 1024 and monitor host resource usage. If the entrypoint logs a warning about ulimit restrictions, set the limit via the container runtime instead. |

### Non-Root User

The sandbox runs agent processes as a dedicated `sandbox` user and group.
The entrypoint starts as root for privilege separation, then drops to the `sandbox` user for all agent commands.

| Aspect | Detail |
|---|---|
| Default | `run_as_user: sandbox`, `run_as_group: sandbox`. A separate `gateway` user runs the gateway process. |
| What you can change | Change the `process` section in the policy file to run as a different user. |
| Risk if relaxed | Running as `root` inside the container gives the agent access to modify any file in the container filesystem and increases the impact of container escape vulnerabilities. |
| Recommendation | Never run as root. Keep the `sandbox` user. |

### PATH Hardening

The entrypoint locks the `PATH` environment variable to system directories, preventing the agent from injecting malicious binaries into command resolution.

| Aspect | Detail |
|---|---|
| Default | `PATH` is set to `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` at startup. |
| What you can change | This is not a user-facing knob. It is enforced by the entrypoint. |
| Risk if relaxed | Without PATH hardening, the agent could create an executable named `curl` or `git` in a writable directory earlier in the PATH, intercepting commands run by the entrypoint or other processes. |
| Recommendation | No action needed. The entrypoint handles this automatically. |

### Build Toolchain Removal

Compilers and network probes are removed from the runtime image.

| Aspect | Detail |
|---|---|
| Default | `gcc`, `gcc-12`, `g++`, `g++-12`, `cpp`, `cpp-12`, `make`, `netcat-openbsd`, `netcat-traditional`, and `ncat` are purged from the sandbox image. |
| What you can change | Modify the Dockerfile to keep these tools, or install them at runtime if package manager access is allowed. |
| Risk if relaxed | A compiler lets the agent build arbitrary native code, including kernel exploits or custom network tools. `netcat` enables arbitrary TCP connections that bypass HTTP-level policy enforcement. |
| Recommendation | Keep build tools removed. If the agent needs to compile code, run the build in a separate, purpose-built container and copy artifacts into the sandbox. |

## Inference Controls

### Routed Inference via `inference.local`

All inference requests from the agent are intercepted by the OpenShell gateway and routed to the configured provider.
The agent never receives the provider API key.

| Aspect | Detail |
|---|---|
| Default | The agent talks to `inference.local`. The host owns the credential and upstream endpoint. |
| What you can change | This architecture is not configurable. It is always enforced. |
| Risk if bypassed | If the agent could reach an inference endpoint directly (by adding it to the network policy), it would need an API key. Since credentials are not in the sandbox, this is a defense-in-depth measure. However, adding an inference provider's host to the network policy without going through OpenShell routing could let the agent use a stolen or hardcoded key. |
| Recommendation | Do not add inference provider hosts (such as `api.openai.com` or `api.anthropic.com`) to the network policy. Use OpenShell inference routing instead. |

### Provider Trust Tiers

Different inference providers have different trust and cost profiles.

| Provider | Trust level | Cost risk | Data handling |
|---|---|---|---|
| NVIDIA Endpoints | High. Hosted on `build.nvidia.com`. | Pay-per-token via API key. Unattended agents can accumulate cost. | Requests processed by NVIDIA infrastructure. |
| OpenAI | High. Commercial API. | Pay-per-token. Same cost risk as NVIDIA Endpoints. | Subject to OpenAI data policies. |
| Anthropic | High. Commercial API. | Pay-per-token. Same cost risk. | Subject to Anthropic data policies. |
| Google Gemini | High. Commercial API. | Pay-per-token. Same cost risk. | Subject to Google data policies. |
| Local Ollama | Self-hosted. No data leaves the machine. | No per-token cost. GPU/CPU resource cost. | Data stays local. |
| Custom compatible endpoint | Varies. Depends on the proxy or gateway. | Varies. | Depends on the endpoint operator. |

**Recommendation:** For sensitive workloads, use local Ollama to keep data on-premise. For general use, NVIDIA Endpoints provide a good balance of capability and trust. Review the data policies of any cloud provider you use.

### Experimental Providers

Local NVIDIA NIM and local vLLM are gated behind the `NEMOCLAW_EXPERIMENTAL=1` environment variable.

| Aspect | Detail |
|---|---|
| Default | Disabled. These providers do not appear in the onboarding wizard. |
| What you can change | Set `NEMOCLAW_EXPERIMENTAL=1` before running `nemoclaw onboard`. |
| Risk if relaxed | These providers are not fully validated. NIM requires a NIM-capable GPU. vLLM must already be running on `localhost:8000`. Misconfiguration can result in failed inference or unexpected behavior. |
| Recommendation | Use experimental providers only for evaluation. Do not rely on them for always-on assistants. |

## Posture Profiles

The following profiles describe how to configure NemoClaw for different use cases.
They are not separate policy files. They are guidance on which controls to keep tight or relax.

### Locked-Down (Default)

Use for always-on assistants with minimal external access.

- Keep all defaults. Do not add presets.
- Use operator approval for any endpoint the agent requests.
- Use NVIDIA Endpoints or local Ollama for inference.
- Monitor the TUI for unexpected network requests.

### Development

Use when the agent needs package registries, Docker Hub, or broader GitHub access during development tasks.

- Apply the `pypi` and `npm` presets for package installation.
- Apply the `docker` preset if the agent builds or pulls container images.
- Keep binary restrictions on all presets.
- Review the agent's network activity periodically via `openshell term`.
- Use operator approval for any endpoint not covered by a preset.

### Integration Testing

Use when the agent talks to internal APIs or third-party services during testing.

- Add custom endpoint entries with tight path and method restrictions.
- Use `protocol: rest` for all HTTP APIs to maintain inspection.
- Use operator approval for unknown endpoints during test runs.
- Review and clean up the baseline policy after testing. Remove endpoints that are no longer needed.

## Common Mistakes

The following patterns weaken security without providing meaningful benefit.

**Omitting `protocol: rest` on REST API endpoints.**
Endpoints without a `protocol` field use L4-only enforcement.
The proxy allows the TCP stream through after checking host, port, and binary, but cannot see or filter individual HTTP requests.
Add `protocol: rest` with explicit `rules` to enable per-request method and path control on REST APIs.

**Adding endpoints to the baseline policy for one-off requests.**
If the agent needs an endpoint temporarily, use operator approval.
Approved endpoints persist within the sandbox instance but reset when the sandbox is destroyed and recreated.
Adding an endpoint to the baseline policy makes it permanently reachable across all sandbox instances.

**Relying solely on the entrypoint for capability drops.**
The entrypoint drops dangerous capabilities via `capsh`, but this is best-effort.
If `capsh` is unavailable or `CAP_SETPCAP` is not in the bounding set, the container runs with the default capability set.
Pass `--cap-drop=ALL` at the container runtime level as defense-in-depth.

**Granting write access to `/sandbox/.openclaw`.**
This directory contains the OpenClaw gateway configuration.
A writable `.openclaw` lets the agent modify auth tokens, disable CORS, or redirect inference routing.
Agent-writable state belongs in `/sandbox/.openclaw-data`.

**Adding inference provider hosts to the network policy.**
Do not add hosts like `api.openai.com` or `api.anthropic.com` to the network policy.
Use OpenShell inference routing instead.
Direct network access to an inference host bypasses credential isolation and usage tracking.

## Related Topics

- [Network Policies](../reference/network-policies.md) for the full baseline policy reference.
- [Customize the Network Policy](../network-policy/customize-network-policy.md) for static and dynamic policy changes.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) for the operator approval flow.
- [Sandbox Hardening](../deployment/sandbox-hardening.md) for container-level security measures.
- [Inference Profiles](../reference/inference-profiles.md) for provider configuration details.
- [How It Works](../about/how-it-works.md) for the protection layer architecture.
