# Tasks: Compass Tools

## 1. Compass

- [x] 1.1 `mcp_servers` table (migration 0026) with sealed headers, tools,
      places, enabled, last test.
- [x] 1.2 `listMcpTools` client: streamable HTTP (JSON or SSE replies,
      session id) and HTTP+SSE; 15 s timeout; never throws.
- [x] 1.3 Routes: list (members), add/change/test/remove (admins), audit log.
- [x] 1.4 `/tools` page with nav link; tests for API and page.

## 2. Orchestrator (claude-software-factory)

- [x] 2.1 `mcp_tools.ConsoleMcpStore` reads enabled servers for CONSOLE_ORG;
      tolerates a Compass without the table.
- [x] 2.2 `wire()` writes a 0600 config into the session HOME; Shape/Ask get
      their servers and a note naming them; role runs get `build` servers.
- [x] 2.3 Header values redacted from transcripts.

## 3. Switch on

- [ ] 3.1 Merge and deploy both (either order: the orchestrator gives no
      tools until the table exists).
- [ ] 3.2 Add the Sarvam docs server in Compass → Tools and ask Shape a
      Sarvam question.
