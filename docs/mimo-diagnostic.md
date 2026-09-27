# MiMo diagnostic — 2026-09-25

Tested the installed OpenCode 1.18.32 with model `opencode/mimo-v2.6-flash-free`.
Prompt: “Reply only OK. Do not use any tools or read or change files.”

| Invocation | Observed result |
| --- | --- |
| Normal `opencode run`, existing local configuration | Returned `OK`, finish `stop`, cost 0 |
| Same command with `OPENCODE_CONFIG_CONTENT={"permission":"deny","tools":{"*":false}}` | HTTP 403 `FreeTierError` |
| Isolated configuration, built-in build agent through serve, deny-all session | HTTP 403 `FreeTierError` |
| Normal `opencode run --agent plan`, existing local configuration | Returned `OK`, finish `stop`, cost 0 |
| Same Plan command with only `OPENCODE_CONFIG_CONTENT={"permission":{"*":"deny"}}` | HTTP 403 `FreeTierError` |

The model is usable in normal OpenCode. Failure in OW Bridge must not be
reported as general model unavailability. The restrictive inference-only
configuration is a demonstrated difference; the exact server-side condition
has not been established. Do not restore native tool execution merely to make
the request succeed: keeping execution in WorkBuddy is a user requirement.

## Official configuration research

- https://opencode.ai/docs/permissions/ recommends `permission`; legacy boolean
  `tools` settings are deprecated but still supported. `deny` blocks actions,
  `ask` waits for approval, and later matching rules override earlier rules.
- https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/agent/agent.ts
  shows that Plan retains tools and permits edits to designated plan files.
  Plan is not a no-tools mode. The current documentation's default description
  differs from this pinned version's source, so use the versioned implementation
  when assessing actual permissions.
- https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/permission/index.ts
  shows that a catch-all deny also removes tools from the model-visible tool list.
  This explains a request-shape difference, not the upstream service's exact
  reason for returning 403.

## Adapter follow-up

Plain Plan answered a simple prompt, but refused an external write request as a
Plan-mode modification. A dedicated agent using official `ask` permissions can
return external calls. Native approval requests are rejected with corrective
feedback (at most two), never approved. Official structured output plus the
external tool schemas is used; a plain JSON fallback is validated if OpenCode
reports `StructuredOutputError`.

MiMo and Space Bunny both passed the proxy's three-turn synthetic write/read
round trip after these changes. See `validation.md` for WorkBuddy engine results.
