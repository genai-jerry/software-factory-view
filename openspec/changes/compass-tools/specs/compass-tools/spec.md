# Delta Spec: compass-tools

## ADDED Requirements

### Requirement: An admin adds an MCP server by URL

Compass SHALL let an org admin or owner add a remote MCP server with a URL
(https only), a transport (streamable HTTP or SSE) and optional request
headers. Compass SHALL connect and list the server's tools before saving, and
SHALL save nothing when the server does not answer as MCP or offers no tools.
Members SHALL see the org's servers but not change them.

#### Scenario: Adding the Sarvam docs server
- **WHEN** an admin adds `https://docs.sarvam.ai/_mcp/server`
- **THEN** Compass lists `searchDocs` (read-only), saves the server with it
  allowed, used in Shape, Ask and Builds

#### Scenario: A wrong URL
- **WHEN** the URL answers 405
- **THEN** nothing is saved and the admin is told the server answered 405

### Requirement: Only allowed tools reach sessions

Read-only tools SHALL start allowed and other tools off. A session SHALL get
only servers that are enabled and used in its place (Shape, Ask, Builds), and
only their allowed tools, with `--strict-mcp-config` so no other MCP
configuration applies.

### Requirement: Header values stay secret

Header values SHALL be sealed with `CONSOLE_MASTER_KEY`, never returned by
the API, written only to a 0600 file in the session's private HOME, and
redacted from run transcripts.
