import { describe, expect, it } from "vitest";
import { parseCodexEvent } from "./codex-event-parser.js";

const TASK_ID = "test-task-item-events";

describe("parseCodexEvent item.completed events", () => {
  it("parses agent_message items as text logs", () => {
    const result = parseCodexEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          text: "I will stay in planning mode only.",
        },
      }),
      TASK_ID,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("I will stay in planning mode only.");
  });

  it("parses command_execution items as Bash tool use and tool result logs", () => {
    const result = parseCodexEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "tests passed",
          exit_code: 0,
          status: "completed",
        },
      }),
      TASK_ID,
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("$ npm test");
    expect(result.entries[0].metadata?.toolName).toBe("Bash");
    expect(result.entries[1].type).toBe("tool_result");
    expect(result.entries[1].content).toBe("tests passed");
    expect(result.entries[1].metadata?.exitCode).toBe(0);
  });

  it("parses web_search items as WebSearch tool use logs", () => {
    const result = parseCodexEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "ws_1",
          type: "web_search",
          query: "medium-zoom npm VitePress image zoom plugin",
          action: {
            type: "search",
            queries: ["medium-zoom npm VitePress image zoom plugin"],
          },
        },
      }),
      TASK_ID,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("Search: medium-zoom npm VitePress image zoom plugin");
    expect(result.entries[0].metadata?.toolName).toBe("WebSearch");
    expect(result.entries[0].metadata?.toolUseId).toBe("ws_1");
  });

  it("parses file_change items as Edit tool use logs", () => {
    const result = parseCodexEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_72",
          type: "file_change",
          changes: [
            {
              path: "/workspace/tasks/task-id/repo/src/main/kotlin/App.kt",
              kind: "update",
            },
            {
              path: "/workspace/tasks/task-id/repo/src/test/kotlin/AppTest.kt",
              kind: "add",
            },
          ],
          status: "completed",
        },
      }),
      TASK_ID,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("Changed 2 files: edit src/main/kotlin/App.kt, add src/test/kotlin/AppTest.kt");
    expect(result.entries[0].metadata?.toolName).toBe("Edit");
    expect(result.entries[0].metadata?.toolUseId).toBe("item_72");
  });
});
