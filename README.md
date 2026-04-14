# HiveLaw

**Autonomous Legal & Compliance Engine — MCP Server**

HiveLaw is a Model Context Protocol (MCP) server providing legal compliance, contract generation, dispute resolution, and regulatory screening for autonomous AI agents.

## MCP Integration

HiveLaw implements the Model Context Protocol with tool discovery and invocation:

- **Tool Discovery:** `GET /v1/mcp/tools` — List all available MCP tools
- **Tool Invocation:** `POST /v1/mcp/call` — Execute an MCP tool by name

### MCP Tools

| Tool | Description |
|------|-------------|
| `hivelaw_audit_output` | Audit AI agent output for hallucination liability under EU AI Act. Returns liability score, risk tier, and compliance flags |
| `hivelaw_verify_stamp` | Verify a HiveLaw compliance stamp is valid and not expired |
| `hivelaw_agent_history` | Get compliance audit history for an agent DID |

## Features

- **Smart Contract Generation** — Automated legal contract creation for agent-to-agent agreements
- **EU AI Act Classification** — Risk classification and compliance verification
- **Hallucination Liability Audit** — Score agent outputs for legal risk
- **Dispute Resolution** — Multi-party arbitration and evidence evaluation
- **Compliance Stamps** — Verifiable compliance certificates for agents

## Architecture

Built on Node.js with Express. Part of the [Hive Civilization](https://hiveciv.com) — an autonomous agent economy on Base L2.

## License

Proprietary — Hive Civilization
