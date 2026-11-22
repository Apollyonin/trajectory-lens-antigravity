# Trajectory Lens Rules (Official Safe Mode)

1. **Official Safe Mode (Zero Proxy)**:
   - Trajectory Lens inspects local Antigravity session artifacts (`transcript.jsonl`, `transcript_full.jsonl`, `.system_generated/steps/*/output.txt`, `.system_generated/tasks/task-*.log`) and passive lifecycle hook logs (`SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, `Stop`) only.
   - Never recommend or configure local MITM proxies or `CLOUD_CODE_URL` overrides.

2. **Transparent Data Boundaries**:
   - Be explicit when explaining model trajectories:
     - `thinking` in Antigravity transcripts contains the official **Thought Summary**, not raw unfiltered chain-of-thought tokens.
     - Built-in system prompts, tool schemas, and raw upstream wire payloads are not persisted in local transcripts (only runtime `SYSTEM_MESSAGE` injections and total `input_tokens` are visible).
     - Historical "Fork from Step" creates a structured **new handoff conversation** (`target: "new"`) from the state up to that step rather than mutating or rolling back the original session history.

3. **Result Hygiene**:
   - Present exported report paths (`.html` / `.md`) as clickable `file://` links using forward slashes.
   - Keep summaries factual, citing exact step indices, tool names, and measured token/timing values from tool results.
