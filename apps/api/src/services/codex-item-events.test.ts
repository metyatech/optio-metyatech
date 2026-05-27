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

  it("parses command_execution items as tool use and tool result logs", () => {
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
    expect(result.entries[1].type).toBe("tool_result");
    expect(result.entries[1].content).toBe("tests passed");
    expect(result.entries[1].metadata?.exitCode).toBe(0);
  });
});
