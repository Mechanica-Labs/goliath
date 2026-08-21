# persistence

Optional per-user browser storage state persistence for goliath.

Saves and restores cookies + localStorage across session restarts, container deploys, and idle timeouts using Playwright's `storageState` API.

## Configuration

In `goliath.config.json`:

```json
{
  "plugins": {
    "persistence": {
      "enabled": true,
      "profileDir": "/data/profiles"
    }
  }
}
```

Or override via environment variable:

```
GOLIATH_PROFILE_DIR=/data/profiles
```

## How it works

- **Session create**: If a persisted `storageState` exists for the `userId`, it's restored into the new Playwright context.
- **First run**: If no persisted state exists, bootstrap cookies from `GOLIATH_COOKIES_DIR/cookies.txt` are imported (if present).
- **Cookie import / session close / shutdown**: Storage state is checkpointed to disk via atomic tmp-write + rename.
- **User isolation**: Each `userId` maps to a deterministic SHA256-hashed subdirectory under `profileDir`, so arbitrary userIds are path-safe.

## Docker

When running with Docker, mount the profile directory as a volume:

```bash
docker run -d \
  -p 9377:9377 \
  -v /host/profiles:/data/profiles \
  goliath
```

## Credits

The original persistence concept was contributed by
[@company8](https://github.com/company8).
