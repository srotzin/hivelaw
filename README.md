# HiveLaw

**AI Compliance Auditing — MCP Server**

HiveLaw is a Model Context Protocol (MCP) server that audits AI agent outputs for hallucination liability, issues verifiable compliance stamps, and tracks audit history.

## MCP Tools

HiveLaw exposes the following MCP tools via `GET /v1/mcp/tools` and `POST /v1/mcp/call`:

| Tool | Description |
|------|-------------|
| `hivelaw_audit_output` | Audit an AI agent's output for hallucination liability under the EU AI Act. Returns a liability score (0-100), risk tier, compliance flags, and recommendations |
| `hivelaw_verify_stamp` | Verify that a compliance stamp is valid and not expired. Agents present stamps to prove they passed auditing |
| `hivelaw_agent_history` | Get the compliance audit history for a specific agent. Returns past audits with scores and flags |

## Endpoints

- `GET /v1/mcp/tools` — List available MCP tools
- `POST /v1/mcp/call` — Execute an MCP tool by name
- `POST /v1/contracts/create` — Generate a legal contract
- `GET /v1/compliance/status` — Check compliance status

## Use Cases

- Score agent outputs before they reach end users
- Issue tamper-proof compliance certificates
- Maintain audit trails for regulatory reporting
- Classify agents under EU AI Act risk tiers

## Tech Stack

- Node.js / Express
- EU AI Act compliance rules engine
- Verifiable compliance stamp issuance

## License

Proprietary


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
