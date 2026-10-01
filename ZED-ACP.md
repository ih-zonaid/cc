# Using the CC Bridge inside Zed (ACP external agents)

Notes for wiring the Zed **external agents** to this bridge, plus the OpenCode
ACP database issue and its fix. See `README.md` for the bridge itself and for
plain-terminal Claude Code.

Config file: `C:\Users\ihzon\AppData\Roaming\Zed\settings.json`

Start the bridge first (must be running or nothing below will work):

```powershell
cd C:\Users\ihzon\code\ih\cc
node index.mjs
```

Health check: `http://localhost:3456/healthz` -> `{"ok":true}`

---

## 1. Claude Agent (`claude-acp`) via the bridge

Zed's `claude-acp` registry entry is a wrapper around the Claude Agent SDK. It
reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` **from its own process env**, and
bakes them into the Claude Code subprocess. Zed passes `agent_servers.<id>.env`
to that process, so the same trick as the terminal works:

```json
"claude-acp": {
  "type": "registry",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_API_KEY": "dummy"
  }
}
```

Why it works / why it's safe:

- Zed builds the npx agent env as
  `npm env -> registry distribution env -> extra env -> settings env`.
  The settings `env` is applied **last**, so nothing clobbers it.
- The `claude-acp` registry entry ships no env of its own, so there is no clash.
- `ANTHROPIC_API_KEY="dummy"` only satisfies the local login check; the bridge
  uses your CommandCode credentials.

Model mapping (same as terminal Claude Code):

| Pick in `/model` | Goes to gateway model |
| :--- | :--- |
| Opus | `z-ai/glm-5.3-flash` |
| Sonnet | `deepseek/deepseek-v4.1-flash` |
| Haiku | `xiaomi/mimo-v2.5` |

The bridge terminal logs each hit, e.g.
`[bridge] Anthropic requested: "claude-opus-5-5" -> gateway model: "z-ai/glm-5.3-flash"`.

---

## 2. OpenCode (`opencode`) ACP — "Database is not empty and has no session table"

### Symptom

Installing OpenCode from Zed's ACP registry fails to launch:

```
Server exited with status exit code: 1
Error: Unexpected error
Database is not empty and has no session table
```

### Cause

Zed's ACP registry serves **OpenCode V1** (`1.18.33`, still current in the
registry). It defaults to the same database as the V2 CLI:

```
~/.local/share/opencode/opencode.db
```

That file is a **V2** database (it has a `session_v2` table). V1 bootstraps with
a query against a `session` table, which doesn't exist in the V2 schema, so it
aborts before speaking any ACP.

### Fix — give the V1 agent its own data dir

Point the registry `opencode` agent at a separate data home:

```json
"opencode": {
  "type": "registry",
  "env": {
    "XDG_DATA_HOME": "C:\\Users\\ihzon\\AppData\\Local\\opencode-v1"
  },
  "default_config_options": {
    "model": "commandcode/deepseek-v4.1-flash"
  }
}
```

V1 then uses `C:\Users\ihzon\AppData\Local\opencode-v1\opencode\opencode.db`,
fully separate from the V2 CLI history. Because V1 reads your existing legacy
`provider` config, **all bridge models appear** in the ACP picker
(`commandcode/deepseek-v4.1-flash`, `commandcode/glm-5.3-flash`, `naraya/...`,
...).

### Verify manually (optional)

Run the exact registry binary with the override and list its models:

```powershell
$v1 = "$env:LOCALAPPDATA\Zed\external_agents\registry\opencode\v_1.18.33_7abe994e7e676226_7b2a434f22736cea\opencode.exe"
$env:XDG_DATA_HOME = "C:\Users\ihzon\AppData\Local\opencode-v1"
& $v1 acp   # should NOT print the database error
```

---

## Full working `agent_servers` block

```json
"agent_servers": {
  "opencode": {
    "type": "registry",
    "env": {
      "XDG_DATA_HOME": "C:\\Users\\ihzon\\AppData\\Local\\opencode-v1"
    },
    "default_config_options": {
      "model": "commandcode/deepseek-v4.1-flash"
    }
  },
  "claude-acp": {
    "type": "registry",
    "env": {
      "ANTHROPIC_BASE_URL": "http://localhost:3456",
      "ANTHROPIC_API_KEY": "dummy"
    }
  }
}
```

---

## Gotchas

- **Don't add/remove these agents through Zed's Agent Settings UI.** It rewrites
  `settings.json` and can drop entries or mangle the `env` blocks. If you do,
  re-check the file afterwards.
- **Use the exact registry id** for registry agents: `opencode` (lowercase), not
  `OpenCode`. A mismatched id is ignored with
  `Registry agent '...' not found in ACP registry`.
- **Restart Zed** after editing the file so agents relaunch with the new env.
- **Bridge must be running** before launching a thread; the ACP process will fail
  to reach models otherwise.
- The V2 CLI path lives under an nvm Node install
  (`...\nvm\installs\v24.21.0\node_modules\@opencode\cli\bin\opencode.exe`), so a
  Node upgrade will break any custom agent pointing at it.
- Keep a backup of `settings.json` before big edits.
