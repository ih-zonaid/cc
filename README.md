# CC Bridge for Claude Code (Windows PowerShell Guide)

This bridge acts as a local proxy that translates requests from **Claude Code** (Anthropic Messages API) and **OpenAI-compatible clients** to the **CommandCode Gateway** (`api.commandcode.ai`).

---

## Model Mappings

When using Claude Code, selecting a model via `/model` automatically routes to your CommandCode models:

| Claude Code Model | Gateway Backend Model |
| :--- | :--- |
| **Sonnet** (Options 3 & 4) | `deepseek/deepseek-v4.1-flash` |
| **Opus** (Options 1 & 2) | `z-ai/glm-5.3-flash` |
| **Haiku** (Option 5) | `xiaomi/mimo-v2.5` |

---

## Prerequisites

1. **Node.js** installed (v18+ recommended).
2. **Claude Code** installed:
   ```powershell
   npm install -g @anthropic-ai/claude-code
   ```
3. **CommandCode Authentication**:
   Ensure your CommandCode API key is present either at `~/.commandcode/auth.json` or via environment variable:
   ```powershell
   $env:COMMAND_CODE_API_KEY="your-commandcode-api-key"
   ```

---

## How to Run in Windows PowerShell

### Step 1: Start the Bridge (Terminal 1)

Open a PowerShell window in this directory (`C:\Users\ihzon\code\ih\cc`) and start the server:

```powershell
node index.mjs
```

You should see output similar to:
```
cc-bridge listening on http://localhost:3456/v1
gateway: https://api.commandcode.ai  model: deepseek/deepseek-v4.1-flash
auth: api key loaded
```

Keep this terminal open while using Claude Code.

---

### Step 2: Start Claude Code (Terminal 2)

Open a second PowerShell window in your project directory and run:

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:3456"; $env:ANTHROPIC_API_KEY="dummy"; claude
```

> **Why `$env:ANTHROPIC_API_KEY="dummy"`?**  
> Claude Code requires an API key to initialize. Since the bridge uses your CommandCode credentials, any dummy string satisfies Claude Code's local check.

---

## Switching Models Inside Claude Code

Inside your running Claude Code session:
1. Type `/model` and hit Enter.
2. Select your desired option:
   - Choose **Sonnet** to use **DeepSeek v4.1 Flash**
   - Choose **Opus** to use **GLM 5.3 Flash**
   - Choose **Haiku** to use **Xiaomi Mimo v2.5**

The bridge terminal (Terminal 1) will log incoming requests and the routed model:
```
[bridge] Anthropic requested: "claude-3-7-sonnet-20250219" -> gateway model: "deepseek/deepseek-v4.1-flash"
```

---

## One-Liner Quick Launch (Optional)

If you want a single command that sets environment variables and launches Claude in PowerShell:

```powershell
powershell -NoExit -Command "$env:ANTHROPIC_BASE_URL='http://localhost:3456'; $env:ANTHROPIC_API_KEY='dummy'; claude"
```
