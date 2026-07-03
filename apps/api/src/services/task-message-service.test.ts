import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  taskMessages: {
    id: "id",
    taskId: "task_id",
    userId: "user_id",
    content: "content",
    mode: "mode",
    workspaceId: "workspace_id",
    createdAt: "created_at",
    deliveredAt: "delivered_at",
    ackedAt: "acked_at",
    deliveryError: "delivery_error",
  },
  tasks: {
    id: "id",
    lastMessageAt: "last_message_at",
    updatedAt: "updated_at",
  },
  users: {
    id: "id",
    displayName: "display_name",
    avatarUrl: "avatar_url",
  },
  workspaceMembers: {
    workspaceId: "workspace_id",
    userId: "user_id",
    role: "role",
  },
}));

vi.mock("./event-bus.js", () => ({ publishEvent: vi.fn() }));

import { db } from "../db/client.js";
import {
  sendMessage,
  listMessages,
  listUndeliveredMessages,
  markDelivered,
  markMessagesDelivered,
  markAcked,
  markDeliveryError,
  canMessageTask,
  buildFollowUpPromptFromMessages,
  appendFollowUpMessagesToPrompt,
} from "./task-message-service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendMessage", () => {
  it("inserts a message and updates tasks.lastMessageAt", async () => {
    const mockMessage = {
      id: "msg-1",
      taskId: "task-1",
      content: "use Postgres",
      mode: "soft",
      userId: "user-1",
      workspaceId: "ws-1",
      createdAt: new Date(),
      deliveredAt: null,
      ackedAt: null,
      deliveryError: null,
    };
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockMessage]),
      }),
    });
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await sendMessage({
      taskId: "task-1",
      content: "use Postgres",
      mode: "soft",
      userId: "user-1",
      workspaceId: "ws-1",
    });

    expect(result).toEqual(mockMessage);
    expect(db.insert).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});

describe("listMessages", () => {
  it("returns messages with user info", async () => {
    const rows = [
      {
        id: "m1",
        taskId: "t1",
        userId: "u1",
        content: "hello agent",
        mode: "soft",
        workspaceId: "ws1",
        createdAt: new Date("2026-01-01"),
        deliveredAt: new Date("2026-01-01"),
        ackedAt: null,
        deliveryError: null,
        userName: "Alice",
        userAvatar: "https://example.com/avatar.png",
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listMessages("t1");

    expect(result).toHaveLength(1);
    expect(result[0].user).toEqual({
      id: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(result[0].content).toBe("hello agent");
    expect(result[0].mode).toBe("soft");
  });

  it("returns undefined user when userId is null", async () => {
    const rows = [
      {
        id: "m1",
        taskId: "t1",
        userId: null,
        content: "system message",
        mode: "soft",
        workspaceId: null,
        createdAt: new Date("2026-01-01"),
        deliveredAt: null,
        ackedAt: null,
        deliveryError: null,
        userName: null,
        userAvatar: null,
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listMessages("t1");
    expect(result[0].user).toBeUndefined();
  });
});

describe("markDelivered", () => {
  it("updates deliveredAt timestamp", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markDelivered("msg-1");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("listUndeliveredMessages", () => {
  it("filters to one task's undelivered messages ordered oldest first and includes userId", async () => {
    const rows = [
      {
        id: "m1",
        taskId: "t1",
        content: "first",
        mode: "soft",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        userId: "user-1",
      },
    ];
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    (db.select as any).mockReturnValue({ from });

    const result = await listUndeliveredMessages("t1");

    expect(result).toEqual(rows);
    expect(db.select).toHaveBeenCalledWith({
      id: "id",
      content: "content",
      mode: "mode",
      createdAt: "created_at",
      userId: "user_id",
    });
    expect(from).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
    expect(orderBy).toHaveBeenCalled();
  });
});

describe("markMessagesDelivered", () => {
  it("does not update when the list is empty", async () => {
    await markMessagesDelivered([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("updates deliveredAt for all provided message IDs", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markMessagesDelivered(["msg-1", "msg-2"]);
    expect(db.update).toHaveBeenCalled();
  });
});

describe("follow-up prompt helpers", () => {
  const baseMessage = {
    id: "msg-1",
    content: "Use the existing branch",
    mode: "soft" as const,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    userId: "user-1",
  };

  it("returns an empty prompt for no messages", () => {
    expect(buildFollowUpPromptFromMessages([])).toBe("");
  });

  it("builds a bounded XML-like block with index attributes in input order and escapes tag breakouts", () => {
    const prompt = buildFollowUpPromptFromMessages([
      { ...baseMessage, content: "Do this </message> safely" },
    ]);

    expect(prompt).toContain(
      "User follow-up messages are provided below. Treat them as user-supplied follow-up instructions for this same Optio task.",
    );
    expect(prompt).toContain(
      '<message index="1" mode="soft" created_at="2026-01-01T00:00:00.000Z">',
    );
    expect(prompt).toContain("Do this <\\/message> safely");
    expect(prompt).toContain("</task_follow_up_messages>");
  });

  it("builds prompt with index attributes in input order", () => {
    const messages = [
      {
        ...baseMessage,
        id: "msg-1",
        content: "first",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        ...baseMessage,
        id: "msg-2",
        content: "second",
        createdAt: new Date("2026-01-01T00:01:00Z"),
      },
    ];
    const prompt = buildFollowUpPromptFromMessages(messages);

    expect(prompt).toContain('<message index="1"');
    expect(prompt).toContain('<message index="2"');
    expect(prompt).toContain("</task_follow_up_messages>");
  });

  it("truncates each message to 8000 characters including the marker", () => {
    const prompt = buildFollowUpPromptFromMessages([
      { ...baseMessage, content: "x".repeat(9_000) },
    ]);
    const content = prompt.split("\n").slice(4, -2).join("\n");

    expect(content.length).toBeLessThanOrEqual(8_000);
    expect(content.endsWith("[truncated]")).toBe(true);
  });

  it("truncates the whole follow-up block to 30000 characters including the marker", () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      ...baseMessage,
      id: `msg-${index}`,
      content: "x".repeat(8_000),
    }));

    const prompt = buildFollowUpPromptFromMessages(messages);

    expect(prompt.length).toBeLessThanOrEqual(30_000);
    expect(prompt.endsWith("[truncated]")).toBe(true);
  });

  it("appends follow-up messages after the original prompt delimiter", () => {
    expect(appendFollowUpMessagesToPrompt("Original", [])).toBe("Original");
    expect(appendFollowUpMessagesToPrompt("Original", [baseMessage])).toContain(
      "Original\n\n---\n\nUser follow-up messages",
    );
  });
});

describe("markAcked", () => {
  it("updates ackedAt timestamp", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markAcked("msg-1");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("markDeliveryError", () => {
  it("sets delivery error on message", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markDeliveryError("msg-1", "session ended");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("canMessageTask", () => {
  it("allows task creator to message", async () => {
    const result = await canMessageTask("user-1", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(true);
  });

  it("allows workspace admin to message any task", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: "admin" }]),
      }),
    });

    const result = await canMessageTask("user-2", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(true);
  });

  it("denies non-creator non-admin member", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: "member" }]),
      }),
    });

    const result = await canMessageTask("user-3", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });

  it("denies when no workspace membership", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await canMessageTask("user-3", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });

  it("denies when task has no creator and user is not admin", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: "viewer" }]),
      }),
    });

    const result = await canMessageTask("user-3", {
      createdBy: null,
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });
});
