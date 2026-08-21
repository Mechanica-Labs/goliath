# Hermes-native harness setup

Goliath is the Hermes-native browser layer for tasks that simpler browsing tools cannot finish. Hermes remains responsible for planning and judgment; Goliath provides page observation, stable element refs, persistent login state, human-like actions, downloads, and secure file attachment. The integration is standard stdio MCP, so the same server remains portable to other compatible harnesses.

## Install and verify

```bash
npm install -g @mechanica-labs/goliath
goliath setup
goliath doctor
```

`goliath setup` creates `~/.goliath/`, downloads the Camoufox browser engine once (about 300 MB), and prints the configurations below. The MCP bridge also repairs a missing engine automatically before it starts the local REST server, so npm 12's secure install-script defaults do not require any special approval and a separate background service is not required.

## Hermes

Add this under the top level of Hermes `config.yaml`:

```yaml
mcp_servers:
  goliath:
    command: "npx"
    args: ["-y", "@mechanica-labs/goliath@0.1.1", "mcp"]
    env:
      GOLIATH_USER_ID: "personal-assistant"
```

Restart Hermes after changing its configuration. The agent will receive 14 `goliath_*` tools for tabs, snapshots, navigation, click/type, behavioral telemetry, human-like actions, uploads, screenshots, evaluation, cookie import, and cleanup. Pinning the npm version prevents a harness restart from silently changing the browser layer; run `goliath setup --hermes` after upgrading to print the new pinned configuration.

## Other MCP clients

Claude, Codex, Cursor, and other clients that accept `mcpServers` can use the same Goliath runtime:

```json
{
  "mcpServers": {
    "goliath": {
      "command": "npx",
      "args": ["-y", "@mechanica-labs/goliath@0.1.1", "mcp"],
      "env": {
        "GOLIATH_USER_ID": "personal-assistant"
      }
    }
  }
}
```

## Persistent identities

`GOLIATH_USER_ID` is the browser identity. Use a stable, distinct value per agent, such as `personal-assistant` or `research-agent`. Cookies and local storage for that identity are persisted under `~/.goliath/profiles/`, allowing an agent to resume authenticated sites across MCP and harness restarts.

`GOLIATH_SESSION_KEY` optionally groups tabs inside an identity and defaults to `default`.

## File uploads and signed documents

For safety, an agent may only attach files inside `GOLIATH_UPLOADS_DIR`, which defaults to `~/.goliath/uploads`. Put a document there before asking the agent to upload it:

```bash
cp ./document.pdf ~/.goliath/uploads/
```

The `goliath_upload` tool rejects traversal, directories, and symlinks that escape this location. An agent can use snapshots, typing, selection, key presses, drag-and-drop, and page evaluation around the upload step to complete document and form workflows.

## Use an existing or remote server

Set `GOLIATH_BASE_URL` when the REST server is managed separately:

```json
{
  "env": {
    "GOLIATH_BASE_URL": "http://127.0.0.1:9377",
    "GOLIATH_MCP_AUTO_START": "false",
    "GOLIATH_USER_ID": "personal-assistant"
  }
}
```

For a non-loopback server, configure `GOLIATH_ACCESS_KEY` on both sides and put TLS in front of the REST API. The MCP bridge will never auto-start a local process for a non-loopback URL.

## Commands

```bash
goliath serve          # foreground REST server
goliath mcp            # stdio bridge; normally launched by the harness
goliath setup          # create directories and print all configs
goliath setup --json   # print only JSON MCP config
goliath setup --hermes # print only Hermes YAML
goliath doctor         # installation and connectivity checks
```

If doctor reports a missing browser engine, run `goliath setup`. Server and download logs from an MCP-managed process are written to MCP stderr, never stdout, so they cannot corrupt the protocol stream.
