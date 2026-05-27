import type { AgentLogEntry } from "@optio/shared";

/**
 * Parse a single NDJSON line from the Codex CLI's --json output.
 *
 * Codex CLI JSON event shapes have changed over time. Older versions emitted
 * direct events like `{ type: "message", role: "assistant", content: ... }`;
 * newer versions commonly wrap Responses-style items in lifecycle events such
 * as `{ type: "item.completed", item: { type: "agent_message", ... } }` or
 * output text events such as `{ type: "response.output_text.done", text: ... }`.
 *
 * This parser intentionally accepts both families. Unknown non-lifecycle JSON
 * events are surfaced as a compact `system` log rather than silently discarded,
 * so future Codex CLI event-shape changes are visible in the UI.
 */
export function parseCodexEvent(
  line: string,
  taskId: string,
): { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean } {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return rawTextEntry(line, taskId);
  }

  const timestamp = new Date().toISOString();
  const entries: AgentLogEntry[] = [];
  const sessionId = getSessionId(event);
  const eventType = typeof event.type === "string" ? event.type : undefined;
  const payload = getPayload(event);
  const payloadType = typeof payload?.type === "string" ? payload.type : undefined;

  if (event.error && typeof event.error === "object" && event.error.message) {
    entries.push(makeEntry(taskId, timestamp, sessionId, "error", event.error.message));
    return { entries, sessionId };
  }

  if (eventType === "error" || payloadType === "error") {
    const msg =
      event.message ?? event.error ?? payload?.message ?? payload?.error ?? JSON.stringify(event);
    entries.push(makeEntry(taskId, timestamp, sessionId, "error", stringifyValue(msg)));
    return { entries, sessionId };
  }

  const commandExecution = parseCommandExecution(event, payload);
  if (commandExecution) {
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "tool_use",
      content: `$ ${commandExecution.command.split("\n")[0].slice(0, 120)}`,
      metadata: {
        toolName: "command_execution",
        toolInput: { command: commandExecution.command },
        toolUseId: commandExecution.id,
      },
    });
    const trimmed =
      commandExecution.output.length > 300
        ? commandExecution.output.slice(0, 300) + "…"
        : commandExecution.output;
    if (trimmed.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "tool_result",
        content: trimmed,
        metadata: {
          toolUseId: commandExecution.id,
          exitCode: commandExecution.exitCode,
          status: commandExecution.status,
        },
      });
    }
    return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  const toolUse = parseToolUse(event, payload);
  if (toolUse) {
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "tool_use",
      content: formatCodexToolUse(toolUse.name, toolUse.args),
      metadata: {
        toolName: toolUse.name,
        toolInput: toolUse.args,
        toolUseId: toolUse.id,
      },
    });
    return { entries, sessionId };
  }

  const toolResult = parseToolResult(event, payload);
  if (toolResult) {
    const trimmed =
      toolResult.output.length > 300 ? toolResult.output.slice(0, 300) + "…" : toolResult.output;
    if (trimmed.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "tool_result",
        content: trimmed,
        metadata: { toolUseId: toolResult.id },
      });
    }
    return { entries, sessionId };
  }

  const message = parseMessage(event, payload);
  if (message) {
    if (message.content.trim()) {
      entries.push(
        makeEntry(
          taskId,
          timestamp,
          sessionId,
          message.role === "system" ? "system" : "text",
          message.content,
        ),
      );
    }
    addUsageEntry(entries, taskId, timestamp, sessionId, event);
    addUsageEntry(entries, taskId, timestamp, sessionId, payload);
    return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  const reasoning = parseReasoning(event, payload);
  if (reasoning.trim()) {
    entries.push(makeEntry(taskId, timestamp, sessionId, "thinking", reasoning));
    return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  const outputText = parseOutputTextEvent(event);
  if (outputText.trim()) {
    entries.push(makeEntry(taskId, timestamp, sessionId, "text", outputText));
    addUsageEntry(entries, taskId, timestamp, sessionId, event);
    return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  addUsageEntry(entries, taskId, timestamp, sessionId, event);
  addUsageEntry(entries, taskId, timestamp, sessionId, payload);
  if (entries.length > 0) return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };

  // Some terminal response events put the full output under response.output.
  const responseText = extractText(event.response?.output ?? event.output);
  if (responseText.trim()) {
    entries.push(makeEntry(taskId, timestamp, sessionId, "text", responseText));
    return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  if (shouldIgnoreLifecycleEvent(eventType)) {
    return { entries: [], sessionId, isTerminal: isTerminalEvent(eventType) };
  }

  if (eventType) {
    entries.push(
      makeEntry(
        taskId,
        timestamp,
        sessionId,
        "system",
        `Unhandled Codex event ${eventType}: ${truncate(stringifyValue(event), 1000)}`,
        { codexEventType: eventType },
      ),
    );
  }

  return { entries, sessionId, isTerminal: isTerminalEvent(eventType) };
}

function rawTextEntry(
  line: string,
  taskId: string,
): { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean } {
  if (!line.trim()) return { entries: [] };
  const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "").trim();
  if (!clean || clean.length < 2) return { entries: [] };
  return {
    entries: [{ taskId, timestamp: new Date().toISOString(), type: "text", content: clean }],
  };
}

function makeEntry(
  taskId: string,
  timestamp: string,
  sessionId: string | undefined,
  type: AgentLogEntry["type"],
  content: string,
  metadata?: Record<string, unknown>,
): AgentLogEntry {
  return { taskId, timestamp, sessionId, type, content, metadata };
}

function getSessionId(event: any): string | undefined {
  return (event.session_id ??
    event.conversation_id ??
    event.thread_id ??
    event.response?.id ??
    event.item?.id ??
    event.id) as string | undefined;
}

function getPayload(event: any): any {
  return event.item ?? event.message ?? event.delta ?? event.response ?? event;
}

function parseMessage(event: any, payload: any): { role: string; content: string } | null {
  if (event.type === "message" && event.role) {
    return { role: event.role, content: extractText(event.content) };
  }
  if (payload?.type === "message" && payload.role) {
    return { role: payload.role, content: extractText(payload.content ?? payload.text) };
  }
  if (payload?.type === "agent_message") {
    return {
      role: "assistant",
      content: extractText(payload.text ?? payload.content ?? payload.message),
    };
  }
  if (event.type === "response.output_item.done" && payload?.role) {
    return { role: payload.role, content: extractText(payload.content ?? payload.text) };
  }
  return null;
}

function parseReasoning(event: any, payload: any): string {
  const eventType = typeof event.type === "string" ? event.type : "";
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  if (eventType.includes("reasoning") || payloadType === "reasoning") {
    return extractText(
      payload?.summary ??
        payload?.content ??
        payload?.text ??
        event.summary ??
        event.content ??
        event.text ??
        event.delta,
    );
  }
  return "";
}

function parseOutputTextEvent(event: any): string {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (
    eventType === "response.output_text.done" ||
    eventType === "response.output_text.delta" ||
    eventType === "output_text" ||
    eventType === "message_delta"
  ) {
    return extractText(event.text ?? event.delta ?? event.content);
  }
  return "";
}

function parseCommandExecution(
  event: any,
  payload: any,
): { id?: string; command: string; output: string; exitCode?: number; status?: string } | null {
  const eventType = typeof event.type === "string" ? event.type : "";
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  if (payloadType !== "command_execution" && eventType !== "command_execution") return null;
  const source = payloadType === "command_execution" ? payload : event;
  const command = stringifyValue(source.command ?? source.cmd ?? "").trim();
  if (!command) return null;
  return {
    id: source.id ?? event.id,
    command,
    output: stringifyValue(source.aggregated_output ?? source.output ?? source.result ?? ""),
    exitCode: typeof source.exit_code === "number" ? source.exit_code : undefined,
    status: typeof source.status === "string" ? source.status : undefined,
  };
}

function parseToolUse(
  event: any,
  payload: any,
): { name: string; args?: Record<string, unknown>; id?: string } | null {
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  const source =
    payloadType.includes("function_call") || payloadType.includes("tool_call") ? payload : event;
  const sourceType = typeof source?.type === "string" ? source.type : "";
  if (!sourceType.includes("function_call") && !sourceType.includes("tool_call")) return null;

  const name = source.name ?? source.function?.name ?? source.tool_name ?? "tool";
  return {
    name,
    args: parseArgs(source.arguments ?? source.args ?? source.input ?? source.function?.arguments),
    id: source.call_id ?? source.id ?? source.tool_call_id ?? event.call_id,
  };
}

function parseToolResult(event: any, payload: any): { output: string; id?: string } | null {
  const eventType = typeof event.type === "string" ? event.type : "";
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  if (
    !eventType.includes("function_call_output") &&
    !payloadType.includes("function_call_output")
  ) {
    return null;
  }
  const source = payloadType.includes("function_call_output") ? payload : event;
  return {
    output: stringifyValue(source.output ?? source.result ?? source.content ?? ""),
    id: source.call_id ?? source.id ?? source.tool_call_id ?? event.call_id,
  };
}

function addUsageEntry(
  entries: AgentLogEntry[],
  taskId: string,
  timestamp: string,
  sessionId: string | undefined,
  source: any,
): void {
  const usage = source?.usage ?? source?.response?.usage;
  if (!usage) return;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cost = source.total_cost_usd ?? source.response?.total_cost_usd;
  const meta: string[] = [];
  if (inputTokens) meta.push(`${inputTokens} input tokens`);
  if (outputTokens) meta.push(`${outputTokens} output tokens`);
  if (cost) meta.push(`$${Number(cost).toFixed(4)}`);
  if (!meta.length) return;
  const alreadyRecorded = entries.some(
    (entry) => entry.type === "info" && entry.content.startsWith("Usage:"),
  );
  if (alreadyRecorded) return;
  entries.push({
    taskId,
    timestamp,
    sessionId,
    type: "info",
    content: `Usage: ${meta.join(" · ")}`,
    metadata: { inputTokens, outputTokens, cost },
  });
}

function extractText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  if (
    type === "text" ||
    type === "output_text" ||
    type === "summary_text" ||
    type === "input_text"
  ) {
    return extractText(obj.text ?? obj.content);
  }
  if (type === "message") return extractText(obj.content ?? obj.text);
  if (type === "agent_message") return extractText(obj.text ?? obj.content ?? obj.message);
  if (type === "reasoning") return extractText(obj.summary ?? obj.content ?? obj.text);

  // Do not treat tool-call argument JSON as natural-language output.
  if (type.includes("function_call") || type.includes("tool_call") || type === "command_execution")
    return "";

  for (const key of ["text", "output_text", "content", "message", "summary", "result", "delta"]) {
    if (key in obj) {
      const text = extractText(obj[key]);
      if (text) return text;
    }
  }

  return "";
}

/** Parse function call arguments (may be a JSON string or object) */
function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return undefined;
}

/** Format a Codex tool use into a concise human-readable string */
function formatCodexToolUse(name: string, args: Record<string, unknown> | undefined): string {
  if (!name) return "unknown tool";
  if (!args) return name;

  switch (name) {
    case "shell":
    case "bash":
    case "terminal":
    case "exec_command":
      return `$ ${String(args.command ?? args.cmd ?? "")
        .split("\n")[0]
        .slice(0, 120)}`;
    case "read_file":
    case "readFile":
      return `Read ${args.path ?? args.file_path ?? ""}`;
    case "write_file":
    case "writeFile":
    case "create_file":
      return `Write ${args.path ?? args.file_path ?? ""}`;
    case "edit_file":
    case "editFile":
    case "apply_diff":
      return `Edit ${args.path ?? args.file_path ?? ""}`;
    case "search":
    case "grep":
      return `Search: ${args.query ?? args.pattern ?? ""}`;
    case "list_dir":
    case "listDir":
      return `List ${args.path ?? args.dir ?? "."}`;
    default:
      return name;
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}

function isTerminalEvent(eventType: string | undefined): boolean {
  return (
    !!eventType &&
    /^(response\.|turn\.|thread\.)?(completed|failed|cancelled|done)$/.test(eventType)
  );
}

function shouldIgnoreLifecycleEvent(eventType: string | undefined): boolean {
  if (!eventType) return true;
  return (
    eventType.endsWith(".created") ||
    eventType.endsWith(".started") ||
    eventType.endsWith(".in_progress") ||
    eventType.endsWith(".delta") ||
    eventType === "turn.started" ||
    eventType === "thread.started" ||
    eventType === "response.created"
  );
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}
