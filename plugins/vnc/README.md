# VNC Plugin

> Originally contributed by [@leoneparise](https://github.com/leoneparise).
> Reworked as a plugin for the Goliath extension system.

Interactive browser access via VNC. Log into sites visually, solve CAPTCHAs, approve OAuth prompts — then export the authenticated storage state for reuse by your agent.

## How it works

```
Goliath (dynamic Xvfb display, 1920x1080)
    ↑
x11vnc (attaches to the announced display, port 5900)
    ↑
noVNC / websockify (port 6080)
    ↑
Your browser → http://localhost:6080/vnc.html
```

The plugin overrides Goliath's default 1x1 virtual display with a human-usable resolution, then runs a watcher process that detects the Xvfb display and attaches x11vnc + noVNC. The watcher handles browser restarts automatically — when Goliath relaunches on a new display, x11vnc reattaches.

## Quick start

### Docker

The viewer requires Linux and Xvfb. On macOS or Windows, run the standard
Goliath image in Docker. The release image already contains the optional VNC
dependencies, although the plugin stays disabled until `ENABLE_VNC=1` is set.

```bash
docker run -p 9377:9377 -p 127.0.0.1:6080:6080 \
  -e ENABLE_VNC=1 \
  -e VNC_BIND=0.0.0.0 \
  goliath

# Open http://localhost:6080/vnc.html in your browser
```

### Watch humanized input live

Keep the noVNC page open, then send a humanized action through Goliath. The
viewer shows the curved pointer path and the resulting click in real time.

```bash
curl -sS -X POST http://localhost:9377/tabs/TAB_ID/click \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","ref":"e1","humanized":{"profile":"balanced","visualize":true}}'
```

Use `VIEW_ONLY=1` when the viewer should observe the run without being able to
send mouse or keyboard input back to Goliath.

### Config file

```json
{
  "plugins": {
    "vnc": {
      "enabled": true,
      "resolution": "1920x1080",
      "password": "optional-secret",
      "viewOnly": false,
      "novncPort": 6080
    }
  }
}
```

## Workflow: interactive login → agent reuse

1. **Start with VNC enabled:**
   ```bash
   docker run -p 9377:9377 -p 127.0.0.1:6080:6080 \
     -e ENABLE_VNC=1 \
     -e VNC_BIND=0.0.0.0 \
     goliath
   ```

2. **Create a session and navigate to the login page:**
   ```bash
   curl -X POST http://localhost:9377/tabs \
     -H 'Content-Type: application/json' \
     -d '{"userId": "my-agent", "sessionKey": "default", "url": "https://accounts.google.com"}'
   ```

3. **Log in visually** via http://localhost:6080/vnc.html — complete MFA, solve CAPTCHAs, etc.

4. **Export the authenticated state:**
   ```bash
   curl http://localhost:9377/sessions/my-agent/storage_state \
     -H 'Authorization: Bearer YOUR_GOLIATH_API_KEY' \
     -o storage_state.json
   ```

5. **Reuse on future runs** — pair with the [persistence plugin](../persistence/) to automatically restore state on session creation:
   ```json
   {
     "plugins": {
       "vnc": { "enabled": true },
       "persistence": { "enabled": true, "profileDir": "/data/profiles" }
     }
   }
   ```
   With both plugins active, the persistence plugin automatically checkpoints storage state on session close and restores it on creation. The VNC plugin's export endpoint also triggers a persistence checkpoint via the `session:storage:export` event.

## API

### GET /sessions/:userId/storage_state

Export the full Playwright storage state (cookies + localStorage origins) for a user's active browser context.

**Auth:** Same as cookie import — requires `GOLIATH_API_KEY` Bearer token, or loopback access in non-production.

**Response:**
```json
{
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": ".example.com",
      "path": "/",
      "expires": 1700000000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [
        { "name": "theme", "value": "dark" }
      ]
    }
  ]
}
```

**Errors:**
- `404` — No active session for the given userId
- `403` — Missing or invalid API key
- `500` — Context is dead or storageState export failed

## Configuration

| Source | Variable | Description | Default |
|--------|----------|-------------|---------|
| env | `ENABLE_VNC` | Enable the plugin (`1`) | off |
| env | `VNC_PASSWORD` | x11vnc password | none (open) |
| env | `VNC_RESOLUTION` | Xvfb screen resolution | `1920x1080` |
| env | `VIEW_ONLY` | Disable mouse/keyboard input (`1`) | off |
| env | `VNC_PORT` | x11vnc listen port | `5900` |
| env | `NOVNC_PORT` | noVNC web UI port | `6080` |
| env | `VNC_BIND` | noVNC bind address inside the container | `127.0.0.1` |
| config | `plugins.vnc.enabled` | Enable the plugin | `false` |
| config | `plugins.vnc.password` | x11vnc password | none |
| config | `plugins.vnc.resolution` | Xvfb screen resolution | `1920x1080` |
| config | `plugins.vnc.viewOnly` | View-only mode | `false` |
| config | `plugins.vnc.vncPort` | x11vnc listen port | `5900` |
| config | `plugins.vnc.novncPort` | noVNC web UI port | `6080` |

Environment variables override config file values.

## Security

⚠️ **VNC is unencrypted by default.** When running in production:

- **Set `VNC_PASSWORD`** — without it, anyone who can reach port 6080 has full browser control
- **Bind 6080 to localhost** and access via SSH tunnel: `ssh -L 6080:localhost:6080 your-server`
- **Or use a firewall** to restrict access to port 6080
- In Docker: `-p 127.0.0.1:6080:6080` binds only to localhost

## System dependencies

The plugin declares its apt dependencies in `apt.txt`. Release Docker images install dependencies for all bundled plugins via `scripts/install-plugin-deps.sh`, even when a plugin remains disabled at runtime:

- `x11vnc` — attaches to Xvfb display
- `novnc` + `python3-websockify` — web-based VNC client
- `net-tools` + `procps` — display detection utilities

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `vnc:watcher:started` | `{ pid }` | Watcher process spawned |
| `vnc:watcher:stopped` | `{ code, signal }` | Watcher exited |
| `vnc:storage:exported` | `{ userId, cookies, origins }` | Storage state exported via API |
| `session:storage:export` | `{ userId }` | Emitted after export (persistence plugin listens) |
