# Compass Tools (MCP servers for the factory's Claude)

## Why

The factory's Claude runs headless on the orchestrator: Shape, Ask (thread
questions and Telegram discussions) and every role run. It can read the code
and the threads; builds can also use the web. It cannot use any MCP server.
Connectors a person adds on claude.ai belong to their claude.ai account and
never reach these sessions, which start from an empty HOME with a stored
token. On 8 Nov 2026 a Shape conversation about a Sarvam spike stalled on
exactly this: the Sarvam docs connector was on in claude.ai, and Shape could
not see it (and wrongly told the person to approve a prompt that does not
exist in a headless run).

## What Changes

- **Compass → Tools (`/tools`).** Per org, an admin adds a remote MCP server
  by URL (streamable HTTP or SSE), with optional request headers for an API
  key. Compass connects and lists the server's tools before saving; nothing
  is saved if it does not answer as MCP.
- **Per-tool allow.** Read-only tools (`readOnlyHint`) start allowed; tools
  that can change things start off. "Test again" refreshes the list and
  keeps earlier choices.
- **Per-place use.** Each server is used in Shape, Ask and/or Builds
  (all on by default); a server can be turned off without removing it.
- **Sealed headers.** Header values are sealed with `CONSOLE_MASTER_KEY`,
  never returned to the browser, and redacted from run transcripts.
- **The orchestrator reads `mcp_servers` directly** (as it reads
  `orchestrator_secrets`), re-read every 60 s, and gives each session an
  `--mcp-config` file in its private HOME with `--strict-mcp-config`, plus
  the allowed `mcp__<server>__<tool>` names in `--allowedTools`. Shape and
  Ask are told which tools they have. Factory PR: claude-software-factory.

## Out of scope

- MCP servers that need an OAuth sign-in (Notion, Linear…): Compass would
  have to run the OAuth flow and refresh tokens. Header-key servers only.
- Repos whose factory runs on GitHub Actions: the workflow would need the
  config passed through `claude_args`. Beacon runs on the orchestrator.
- Local (stdio) MCP servers.
- Web access (WebFetch/WebSearch) for Shape and Ask.
