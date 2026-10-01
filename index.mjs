#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const PORT = Number(process.env.CC_BRIDGE_PORT || 3456);
const GATEWAY = process.env.CC_GATEWAY || "https://api.commandcode.ai";
const MODEL = process.env.CC_MODEL || "deepseek/deepseek-v4.1-flash";

const MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.7-plus",
  "xiaomi/mimo-v2.5",
  "meituan/longcat-2.0:free",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-sante:free",
];

function resolveGatewayModel(requestedModel) {
  if (process.env.CC_FORCE_MODEL) return process.env.CC_FORCE_MODEL;
  if (!requestedModel) return MODEL;

  const m = requestedModel.toLowerCase();

  if (m.includes("opus")) {
    return "z-ai/glm-5.3-flash";
  }
  if (m.includes("sonnet")) {
    return "deepseek/deepseek-v4.1-flash";
  }
  if (m.includes("haiku")) {
    return "xiaomi/mimo-v2.5";
  }
  if (m.includes("claude")) {
    return MODEL;
  }

  return requestedModel;
}

const shortModel = (m) => String(m || "?").replace(/^claude-/, "").replace(/-\d{6,}$/, "");
const elapsed = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const levelFromBudget = (bt) => {
  if (bt == null) return "on";
  if (bt <= 4000) return "low";
  if (bt <= 16000) return "medium";
  return "high";
};
const thinkInfo = (b) => {
  const explicit = b?.output_config?.effort;
  const t = b?.thinking;
  if (t?.type === "disabled") return "effort:off";
  if (explicit) return `effort:${explicit}`;
  const bt = t?.budget_tokens ?? b?.thinking_budget;
  if (bt) return `effort:${levelFromBudget(bt)}(${Math.round(bt / 1000)}k)`;
  return t ? "effort:on" : "effort:off";
};
const logReq = (p) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${p}`);

function getApiKey() {
  const fromEnv = process.env.COMMAND_CODE_API_KEY;
  if (fromEnv) return fromEnv;
  const p = path.join(os.homedir(), ".commandcode", "auth.json");
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!d.apiKey) throw new Error(`No apiKey in ${p}`);
  return d.apiKey;
}

function gitInfo(cwd) {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const currentBranch = run("git rev-parse --abbrev-ref HEAD");
  const isGitRepo = run("git rev-parse --is-inside-work-tree");
  const mainBranch = run("git symbolic-ref refs/remotes/origin/HEAD --short") || run("git branch -l main --format %(refname:short)") || run("git branch -l master --format %(refname:short)");
  const gitStatus = run("git status --short");
  const recentCommits = run("git log -3 --pretty=%h %s")
    ? run("git log -3 --pretty=%h %s").split("\n")
    : [];
  return {
    isGitRepo: isGitRepo === "true",
    currentBranch: currentBranch || "",
    mainBranch: mainBranch || "main",
    gitStatus: gitStatus ? "Working tree dirty" : "Working tree clean",
    recentCommits,
  };
}

function toGatewayMessages(openaiMessages) {
  let systemText = "";
  const out = [];
  for (const m of openaiMessages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      systemText += (systemText ? "\n\n" : "") + text;
      continue;
    }
    if (m.role === "user") {
      const blocks = [];
      if (typeof m.content === "string") {
        blocks.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text") blocks.push({ type: "text", text: c.text });
          else if (c.type === "image_url" && c.image_url?.url) {
            const url = c.image_url.url;
            const mime = url.startsWith("data:")
              ? url.slice(5, url.indexOf(";")) || "image/png"
              : "image/png";
            blocks.push({ type: "image", image: url, mimeType: mime });
          }
        }
      }
      if (blocks.length) out.push({ role: "user", content: blocks });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (typeof m.content === "string") {
        if (m.content) blocks.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
          else if (c.type === "reasoning" && c.text) blocks.push({ type: "reasoning", text: c.text });
        }
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        blocks.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function.name, input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      const value = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      out.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: m.tool_call_id, toolName: "", output: { type: "text", value } }],
      });
    }
  }
  return { systemText, messages: out };
}

function toGatewayTools(tools) {
  return (tools || [])
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

function toGatewayRequest(body, cwd) {
  const { systemText, messages } = toGatewayMessages(body.messages || []);
  const git = gitInfo(cwd);
  return {
    config: {
      workingDir: cwd,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      ...git,
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: crypto.randomUUID(),
    params: {
      model: resolveGatewayModel(body.model),
      messages,
      tools: toGatewayTools(body.tools),
      system: systemText || "You are a helpful assistant.",
      max_tokens: body.max_tokens || 64000,
      stream: true,
      temperature: body.temperature,
      top_p: body.top_p,
    },
  };
}

function gatewayHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "cli",
    "x-cli-environment": "production",
    "x-command-code-version": "1.9.0",
    "x-session-id": crypto.randomUUID(),
    "x-project-slug": path.basename(process.cwd()).replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    "x-taste-learning": "false",
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendSse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function proxyStream(req, res, body) {
  const apiKey = getApiKey();
  const gwBody = toGatewayRequest(body, process.cwd());
  let gwRes;
  try {
    gwRes = await fetch(`${GATEWAY}/alpha/generate`, {
      method: "POST",
      headers: gatewayHeaders(apiKey),
      body: JSON.stringify(gwBody),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    sendJson(res, 502, { error: { message: `Gateway request failed: ${e.message}`, type: "gateway_error" } });
    return;
  }
  if (!gwRes.ok || !gwRes.body) {
    const text = await gwRes.text().catch(() => "");
    sendJson(res, gwRes.status, { error: { message: `Gateway error ${gwRes.status}: ${text.slice(0, 500)}`, type: "gateway_error" } });
    return;
  }

  const sse = body.stream === true;
  if (sse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }

  const reader = gwRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let started = false;
  let finishReason = "stop";
  let usage;
  const toolIndexes = new Map();
  let nextToolIndex = 0;

  const emitChunk = (chunk, isDone = false) => {
    const obj = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model || MODEL, choices: [{ index: 0, ...chunk }] };
    if (sse) {
      sendSse(res, obj);
    }
  };
  const emitFinal = () => {
    if (sse) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "text-start":
          if (!started) {
            started = true;
            emitChunk({ delta: { role: "assistant", content: "" } });
          }
          break;
        case "text-delta":
          if (!started) {
            started = true;
            emitChunk({ delta: { role: "assistant", content: ev.text ?? "" } });
          } else {
            emitChunk({ delta: { content: ev.text ?? "" } });
          }
          break;
        case "reasoning-delta":
          break;
        case "tool-input-start": {
          let index = toolIndexes.get(ev.id);
          if (index === undefined) {
            index = nextToolIndex++;
            toolIndexes.set(ev.id, index);
          }
          if (!started) {
            started = true;
            emitChunk({ delta: { role: "assistant", content: "" } });
          }
          emitChunk({ delta: { tool_calls: [{ index, id: ev.id, type: "function", function: { name: ev.toolName, arguments: "" } }] } });
          break;
        }
        case "tool-input-delta": {
          const index = toolIndexes.get(ev.id);
          if (index !== undefined) {
            emitChunk({ delta: { tool_calls: [{ index, function: { arguments: ev.delta ?? "" } }] } });
          }
          break;
        }
        case "finish-step":
        case "finish": {
          const fr = ev.finishReason || ev.rawFinishReason || "";
          if (/tool-call|tool_use/i.test(fr)) finishReason = "tool_calls";
          else if (/length|max_tokens/i.test(fr)) finishReason = "length";
          else finishReason = "stop";
          const u = ev.totalUsage || ev.usage;
          if (u) usage = { prompt_tokens: u.inputTokens ?? 0, completion_tokens: u.outputTokens ?? 0, total_tokens: u.totalTokens ?? 0 };
          break;
        }
      }
    }
  }

  if (!started) {
    emitChunk({ delta: { role: "assistant", content: "" } });
  }
  if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  emitChunk({ delta: {}, finish_reason: finishReason, usage });
  emitFinal();
}

async function handleNonStream(req, res, body) {
  const apiKey = getApiKey();
  const gwBody = toGatewayRequest(body, process.cwd());
  let gwRes;
  try {
    gwRes = await fetch(`${GATEWAY}/alpha/generate`, {
      method: "POST",
      headers: gatewayHeaders(apiKey),
      body: JSON.stringify(gwBody),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    sendJson(res, 502, { error: { message: e.message, type: "gateway_error" } });
    return;
  }
  if (!gwRes.ok || !gwRes.body) {
    sendJson(res, 502, { error: { message: `Gateway error ${gwRes.status}`, type: "gateway_error" } });
    return;
  }
  const reader = gwRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const toolCalls = [];
  const toolById = new Map();
  let finishReason = "stop";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "text-delta") text += ev.text ?? "";
      else if (ev.type === "tool-call") {
        toolCalls.push({ id: ev.toolCallId, type: "function", function: { name: ev.toolName, arguments: typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input ?? {}) } });
      } else if (ev.type === "tool-input-start") {
        toolById.set(ev.id, { id: ev.id, type: "function", function: { name: ev.toolName, arguments: "" } });
      } else if (ev.type === "tool-input-delta") {
        const tc = toolById.get(ev.id);
        if (tc) tc.function.arguments += ev.delta ?? "";
      } else if (ev.type === "finish-step" || ev.type === "finish") {
        const fr = ev.finishReason || ev.rawFinishReason || "";
        if (/tool-call|tool_use/i.test(fr)) finishReason = "tool_calls";
        else if (/length|max_tokens/i.test(fr)) finishReason = "length";
        else finishReason = "stop";
      }
    }
  }
  for (const tc of toolById.values()) {
    if (!toolCalls.find((x) => x.id === tc.id)) toolCalls.push(tc);
  }
  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  sendJson(res, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || MODEL,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function anthropicSystemToString(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

function anthropicToGatewayMessages(anthropicMessages) {
  const out = [];
  const toolNames = new Map();
  for (const m of anthropicMessages || []) {
    if (m.role === "user") {
      const blocks = [];
      const toolResults = [];
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
      for (const b of content) {
        if (b.type === "text") {
          blocks.push({ type: "text", text: b.text ?? "" });
        } else if (b.type === "image") {
          const src = b.source || {};
          if (src.type === "base64") {
            blocks.push({ type: "image", image: `data:${src.media_type || "image/png"};base64,${src.data ?? ""}`, mimeType: src.media_type || "image/png" });
          } else if (src.type === "url") {
            blocks.push({ type: "image", image: src.url, mimeType: "image/png" });
          }
        } else if (b.type === "tool_result") {
          const value = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? null);
          toolResults.push({ role: "tool", content: [{ type: "tool-result", toolCallId: b.tool_use_id || "", toolName: toolNames.get(b.tool_use_id) || "", output: { type: "text", value } }] });
        }
      }
      out.push(...toolResults);
      if (blocks.length) out.push({ role: "user", content: blocks });
    } else if (m.role === "assistant") {
      const blocks = [];
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
      for (const b of content) {
        if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && b.thinking) blocks.push({ type: "reasoning", text: b.thinking });
        else if (b.type === "tool_use" && b.id) {
          toolNames.set(b.id, b.name || "");
          blocks.push({ type: "tool-call", toolCallId: b.id, toolName: b.name || "", input: b.input ?? {} });
        }
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    }
  }
  return out;
}

function toGatewayRequestAnthropic(body, cwd, systemText, messages) {
  const git = gitInfo(cwd);
  return {
    config: {
      workingDir: cwd,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      ...git,
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: crypto.randomUUID(),
    params: {
      model: resolveGatewayModel(body.model),
      messages,
      tools: (body.tools || []).map((t) => ({
        name: t.name,
        description: t.description || "",
        input_schema: t.input_schema || { type: "object", properties: {} },
      })),
      system: systemText || "You are a helpful assistant.",
      max_tokens: body.max_tokens || 64000,
      thinking: body.thinking,
      output_config: body.output_config,
      stream: true,
      temperature: body.thinking ? undefined : body.temperature,
      top_p: body.top_p,
    },
  };
}

function sendAnthropicEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function anthropicStopReason(fr) {
  if (/tool-call|tool_use/i.test(fr)) return "tool_use";
  if (/length|max_tokens/i.test(fr)) return "max_tokens";
  return "end_turn";
}

async function handleAnthropicMessages(req, res, body) {
  const streaming = body.stream === true;
  const apiKey = getApiKey();
  const systemText = anthropicSystemToString(body.system);
  const messages = anthropicToGatewayMessages(body.messages);
  const gwBody = toGatewayRequestAnthropic(body, process.cwd(), systemText, messages);
  const t0 = Date.now();
  const tag = shortModel(body.model);
  const streamFlag = body.stream === true ? "stream" : "block";
  logReq(`-> ${tag} | ${thinkInfo(body)} | ${shortModel(gwBody.params.model)}`);
  if (process.env.CC_DEBUG) {
    const shape = messages
      .map((m) => `${m.role[0]}[${(m.content || []).map((b) => (b.type === "tool-call" ? `call:${String(b.toolCallId).slice(-6)}` : b.type === "tool-result" ? `res:${String(b.toolCallId).slice(-6)}` : b.type)).join(",")}]`)
      .join(" ");
    logReq(`   shape: ${shape}`);
    logReq(`   body keys: ${Object.keys(body).join(",")}`);
    logReq(`   effort: thinking=${JSON.stringify(body.thinking)} budget=${body.thinking_budget} reasoning_effort=${body.reasoning_effort} effort=${body.effort}`);
    logReq(`   output_config=${JSON.stringify(body.output_config)} metadata=${JSON.stringify(body.metadata)}`);
    const em = systemText.match(/effort[^\n]{0,60}/i);
    if (em) logReq(`   sys effort hint: ${em[0]}`);
  }

  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

  if (process.env.CC_DUMP) {
    try {
      const dumpPath = path.join(os.tmpdir(), "cc-last-request.json");
      fs.writeFileSync(dumpPath, JSON.stringify(gwBody, null, 2));
      logReq(`   dump: ${dumpPath}`);
    } catch {}
  }

  let gwRes;
  try {
    gwRes = await fetch(`${GATEWAY}/alpha/generate`, {
      method: "POST",
      headers: gatewayHeaders(apiKey),
      body: JSON.stringify(gwBody),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    sendJson(res, 502, { error: { message: `Gateway request failed: ${e.message}`, type: "gateway_error" } });
    return;
  }
  if (!gwRes.ok || !gwRes.body) {
    const text = await gwRes.text().catch(() => "");
    let code = "";
    try {
      code = JSON.parse(text)?.error?.code || "";
    } catch {}
    logReq(`   x ${tag} ${gwRes.status}${code ? ` ${code}` : ""} (${elapsed(t0)})`);
    sendJson(res, gwRes.status, { error: { message: `Gateway error ${gwRes.status}: ${text.slice(0, 500)}`, type: "gateway_error" } });
    return;
  }

  if (streaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    sendAnthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: body.model || MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  let nextIndex = 0;
  let active = null;
  let finishReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const blocks = [];
  let textBuf = "";
  let currentToolId = null;
  let currentToolIndex = null;
  let thinkingText = "";
  let textOpened = false;
  let reasoningOpened = false;
  const rawTypes = new Map();
  const rawByType = new Map();
  let rawSampleCount = 0;

  const openBlock = (kind, content_block) => {
    if (active && active.kind === kind) return;
    if (active) {
      if (streaming) sendAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: active.index });
      active = null;
    }
    const index = nextIndex++;
    active = { kind, index };
    if (streaming) sendAnthropicEvent(res, "content_block_start", { type: "content_block_start", index, content_block });
    blocks.push(content_block);
  };
  const closeActive = () => {
    if (active) {
      if (streaming) sendAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: active.index });
      active = null;
    }
  };

  const reader = gwRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      rawTypes.set(ev.type, (rawTypes.get(ev.type) || 0) + 1);
      if (!rawByType.has(ev.type) && rawSampleCount < 6) {
        rawByType.set(ev.type, line.slice(0, 200));
        rawSampleCount++;
      }
      switch (ev.type) {
        case "text-start":
        case "text-delta": {
          const delta = ev.text ?? "";
          textBuf += delta;
          openBlock("text", { type: "text", text: "" });
          if (streaming) {
            sendAnthropicEvent(res, "content_block_delta", { type: "content_block_delta", index: active.index, delta: { type: "text_delta", text: delta } });
          }
          break;
        }
        case "reasoning-delta": {
          const delta = ev.text ?? "";
          thinkingText += delta;
          openBlock("reasoning", { type: "thinking", thinking: "" });
          if (streaming) {
            sendAnthropicEvent(res, "content_block_delta", { type: "content_block_delta", index: active.index, delta: { type: "thinking_delta", thinking: delta } });
          }
          break;
        }
        case "tool-input-start": {
          const id = ev.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
          closeActive();
          const index = nextIndex++;
          active = { kind: `tool:${id}`, index };
          if (streaming) {
            sendAnthropicEvent(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: ev.toolName || "", input: {} } });
          }
          blocks.push({ type: "tool_use", id, name: ev.toolName || "", input: undefined, __args: "" });
          currentToolId = id;
          currentToolIndex = index;
          break;
        }
        case "tool-input-delta": {
          const b = blocks[blocks.length - 1];
          if (b && currentToolId && b.type === "tool_use") {
            b.__args += ev.delta ?? "";
            if (streaming) {
              sendAnthropicEvent(res, "content_block_delta", { type: "content_block_delta", index: currentToolIndex, delta: { type: "input_json_delta", partial_json: ev.delta ?? "" } });
            }
          }
          break;
        }
        case "finish-step":
        case "finish": {
          const fr = ev.finishReason || ev.rawFinishReason || "";
          finishReason = anthropicStopReason(fr);
          const u = ev.totalUsage || ev.usage;
          if (u) usage = { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0 };
          break;
        }
      }
    }
  }

  const finalBlocks = [];
  if (!textBuf && !thinkingText && !blocks.length) {
    finalBlocks.push({ type: "text", text: "" });
  }
  for (const b of blocks) {
    if (b.type === "text") {
      finalBlocks.push({ type: "text", text: textBuf });
    } else if (b.type === "thinking") {
      finalBlocks.push({ type: "thinking", thinking: thinkingText });
    } else if (b.type === "tool_use") {
      let input = b.__args;
      try {
        input = JSON.parse(b.__args || "{}");
      } catch {}
      finalBlocks.push({ type: "tool_use", id: b.id, name: b.name, input });
    }
  }

  logReq(`<- ${tag} ${finishReason} in:${usage.input_tokens} out:${usage.output_tokens} ${elapsed(t0)}`);
  if (process.env.CC_DEBUG) {
    for (const type of ["error"]) {
      const s = rawByType.get(type);
      if (s) logReq(`   ! ${s}`);
    }
  }

  if (streaming) {
    closeActive();
    sendAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: finishReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    sendAnthropicEvent(res, "message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  sendJson(res, 200, {
    id: msgId,
    type: "message",
    role: "assistant",
    model: body.model || MODEL,
    content: finalBlocks,
    stop_reason: finishReason,
    stop_sequence: null,
    usage,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "commandcode" })),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } });
        return;
      }
      try {
        if (body.stream === true) await proxyStream(req, res, body);
        else await handleNonStream(req, res, body);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: "bridge_error" } });
        else res.end();
      }
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } });
        return;
      }
      try {
        await handleAnthropicMessages(req, res, body);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: { message: e.message, type: "bridge_error" } });
        else res.end();
      }
    });
    return;
  }

  sendJson(res, 404, { error: { message: `Not found: ${req.method} ${url.pathname}`, type: "invalid_request_error" } });
});

server.listen(PORT, () => {
  console.log(`cc-bridge listening on http://localhost:${PORT}/v1`);
  console.log(`gateway: ${GATEWAY}  model: ${MODEL}`);
  try {
    console.log(`auth: ${getApiKey() ? "api key loaded" : "missing"}`);
  } catch (e) {
    console.log(`auth: ${e.message}`);
  }
});
