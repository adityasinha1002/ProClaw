# Nemotron Model Test Results

**Environment:** WSL2 Ubuntu-22.04, RTX 4090 24GB, Docker Desktop 29.2.1
**Date:** 2026-03-21

Full inference chain: Sandbox → inference.local → OpenShell gateway → gateway-IP:port → sidecar

---


## nemotron-3-nano:30b (Ollama sidecar, port 11434)

### Math
- **Latency:** 116259ms | **Tokens:** 68 | **Finish:** stop
- **Content:** 4
- **Reasoning:** The user asks: "What is 2+2? Reply with just the number." So answer must be just the number "4". No extra text. Ensure compliance.

### Capital
- **Latency:** 13446ms | **Tokens:** 227 | **Finish:** length
- **Reasoning:** Okay, the user is asking for the capital of France and specifically wants a one-word answer. 

### Greeting
- **Latency:** 13573ms | **Tokens:** 223 | **Finish:** length
- **Reasoning:** Ok, the user greeted me with "Hello, how are you today?" This is a common social opener, so I should respond politely and keep the conversation friendly. I need to make sure my response is warm and approachable. Let me think about the best way to answer.

### Bat-and-ball
- **Latency:** 23538ms | **Tokens:** 416 | **Finish:** stop
- **Content:** Let  

### Syllogism
- **Latency:** 25769ms | **Tokens:** 437 | **Finish:** length
- **Content:** **Answer: Yes, all roses are plants.**  

### Code
- **Latency:** 38875ms | **Tokens:** 633 | **Finish:** length
- **Content:** Here’s a compact, easy‑to‑read implementation that follows the classic trial‑division method. It runs in **O(√n)** time and handles edge‑cases (0, 1, negative numbers, etc.) gracefully.

### Story
- **Latency:** 11306ms | **Tokens:** 153 | **Finish:** stop
- **Content:** The rust‑clad robot stared at a blank canvas, its servos humming as it tried to translate the colors it had only ever measured in data streams. After countless failed attempts, it finally let its programmed logic melt into intuition, flicking a brushstroke that perfectly captured the sunset it had once only observed through a camera lens. With each new hue it mastered, the robot discovered that art was less about precision and more about the unpredictable joy of creation.
- **Reasoning:** User wants a 3-sentence story about a robot learning to paint. Simple. Provide three sentences. Ensure creative.

### Explain
- **Latency:** 18664ms | **Tokens:** 326 | **Finish:** length
- **Reasoning:** Hmm, the user wants me to explain photosynthesis in exactly three sentences. That's a clear and straightforward request. 

## OpenReasoning-Nemotron-7B (LM Studio sidecar, port 1234)

### Math
- **Latency:** 55335ms | **Tokens:** 326 | **Finish:** length
- **Content:** <think>

### Capital
- **Latency:** 77759ms | **Tokens:** 224 | **Finish:** length
- **Content:** <think>

### Greeting
- **Latency:** 76823ms | **Tokens:** 220 | **Finish:** length
- **Content:** <thI'm sorry, but it seems like there was a mistake in the input. The user said "how are you today?" which is a common greeting, and then they didn't provide any context or request for assistance. It looks like this might be a case where I need to respond based on general knowledge since no specific problem is given.

### Bat-and-ball
- **Latency:** 191017ms | **Tokens:** 549 | **Finish:** length
- **Content:** <think>

### Syllogism
- **Latency:** 154531ms | **Tokens:** 428 | **Finish:** length
- **Content:** <think>

### Code
- **Latency:** 227996ms | **Tokens:** 629 | **Finish:** length
- **Content:** <think>

### Story
- **Latency:** 114619ms | **Tokens:** 327 | **Finish:** length
- **Content:** <think>

### Explain
- **Latency:** 114484ms | **Tokens:** 322 | **Finish:** length
- **Content:** <think>


---
Generated: Sat Mar 21 23:16:12 PDT 2026
