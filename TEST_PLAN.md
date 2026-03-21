# Nemotron Model Test Plan

## Models to Test

### Ollama sidecar
- [x] qwen3:0.6b (test model, already working)
- [ ] nemotron-3-nano:30b (18GB, primary Nemotron model — DOWNLOADING)

### LM Studio sidecar (Nemotron GGUF models that fit RTX 4090 24GB)
- [ ] nvidia-nemotron-3-nano-4b@q4_k_m (3GB, smallest Nemotron)
- [ ] nvidia-nemotron-3-nano-30b-a3b@q4_k_m (18GB, 30B MoE)
- [ ] openreasoning-nemotron-1.5b@q4_k_m (~1GB, tiny reasoning)
- [ ] openreasoning-nemotron-7b@q4_k_m (~5GB, reasoning)
- [ ] openreasoning-nemotron-14b@q4_k_m (~9GB, reasoning)
- [ ] opencodereasoning-nemotron-14b@q4_k_m (~9GB, code reasoning)
- [ ] llama-3.1-nemotron-nano-4b-v1.1@q4_k_m (~3GB, Llama-based Nemotron)

## Prompt Battery (run on each model)

### Simple
1. "What is 2+2?" — verify numeric answer
2. "What is the capital of France?" — verify factual recall
3. "Hello, how are you?" — verify conversational response

### Long-form
4. "Explain how photosynthesis works in detail" — verify multi-paragraph output
5. "Write a short story about a robot learning to paint" — verify creative output

### Reasoning
6. "If all roses are flowers and all flowers are plants, are all roses plants? Explain your reasoning step by step." — verify chain-of-thought
7. "A bat and a ball cost $1.10 total. The bat costs $1.00 more than the ball. How much does the ball cost?" — classic reasoning trap (answer: $0.05, not $0.10)

### Code
8. "Write a Python function that checks if a number is prime" — verify code generation

## Onboard Logic Gaps to Investigate

- [ ] Does the onboard script handle the case where the Ollama sidecar is already running?
- [ ] What happens if the model pull fails mid-download?
- [ ] Does the provider URL update if the gateway container IP changes?
- [ ] Is the model name correctly passed through the Dockerfile ARG?
- [ ] Does `selectInferenceProvider` handle the single-option case (only cloud)?

## Test Protocol

For each model:
1. Pull the model into the running sidecar
2. Update the inference route: `openshell inference set --no-verify --provider ollama-k3s --model <model>`
3. Run all 8 prompts from inside the sandbox
4. Record: response quality, token counts, latency, any errors
5. Verify reasoning tokens appear where expected

## Results

### qwen3:0.6b (Ollama sidecar) — 5/9 pass
- Simple: 1/3 (hallucinated capital of France as "Lyon")
- Reasoning: 0/2 (too small for reasoning chains, runs out of tokens)
- Long-form: 1/2 (photosynthesis good, code truncated)
- Performance: 2/2 (379ms short, 1011ms medium)
- **Verdict**: Too small for production. Good for testing infrastructure.

### nemotron-3-nano:30b (Ollama sidecar) — 7/9 pass
- Simple: 2/3 (Paris correct, greeting good; math content empty due to thinking tokens)
- Reasoning: 2/2 (bat-and-ball $0.05 CORRECT, logic syllogism CORRECT)
- Long-form: 1/2 (photosynthesis good; code in reasoning not content)
- Performance: 2/2 (1.5s short, 4.3s medium)
- **Verdict**: Production-quality. Reasoning is strong. 2-20s latency on RTX 4090.

### LM Studio models — TODO (need separate onboard run)

## Status
- [x] Ollama sidecar tested with qwen3:0.6b and nemotron-3-nano:30b
- [x] Inference routing verified through full chain (sandbox → inference.local → gateway → sidecar)
- [ ] LM Studio sidecar testing (requires uninstall + re-onboard)
- [ ] Concurrency testing (multiple simultaneous requests)
