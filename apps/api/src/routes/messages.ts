import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import * as messageService from "../services/task-message-service.js";
import { publishTaskMessage } from "../services/task-message-bus.js";
import { publishEvent } from "../services/event-bus.js";
import { getRedisClient } from "../services/event-bus.js";
import { taskQueue } from "../workers/task-worker.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskMessageSchema } from "../schemas/task.js";
import { buildPlanReviewResumePayload } from "../services/planning-resume-service.js";

export const PRE_RUN_MESSAGE_STATES = [
  TaskState.PENDING,
  TaskState.WAITING_ON_DEPS,
  TaskState.QUEUED,
  TaskState.PROVISIONING,
] as const;

// States from which a stopped task can be resumed by sending a chat message.
// Matches the states accepted by POST /api/tasks/:id/resume and force-restart.
export const STOPPED_RESUME_STATES = [
  TaskState.NEEDS_ATTENTION,
  TaskState.PR_OPENED,
  TaskState.FAILED,
  TaskState.CANCELLED,
] as const;

const sendMessageSchema = z
  .object({
    content: z.string().min(1).max(8000).describe("Message body to deliver to the agent"),
    mode: z
      .enum(["soft", "interrupt"])
      .default("soft")
      .describe(
        "`soft` queues the message for the next turn; `interrupt` attempts " +
          "to preempt the running turn (claude-code only for now)",
      ),
  })
  .describe("Body for sending a follow-up message to a task");

const MessageAcceptedResponseSchema = z
  .object({
    message: TaskMessageSchema,
  })
  .describe("Message accepted and queued for delivery");

const MessagesListResponseSchema = z
  .object({
    messages: z.array(TaskMessageSchema),
  })
  .describe("All messages sent to a task");

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export async function messageRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/tasks/:id/message",
    {
      schema: {
        operationId: "sendTaskMessage",
        summary: "Send a follow-up message to a task",
        description:
          "Save a user follow-up message on the task's canonical conversation thread. Behavior depends on state:\n\n" +
          "- **running + claude-code**: mid-turn delivery via the Redis channel → task-worker " +
          "→ stream-json stdin.\n" +
          "- **running + other agents**: accepted for an automatic follow-up resume after the current run.\n" +
          "- **pending / waiting_on_deps / queued / provisioning**: accepted and appended to the initial prompt when the worker starts.\n" +
          "- **needs_attention / pr_opened / failed / cancelled**: resumes the " +
          "agent with the message as the new prompt (re-enqueues the task, " +
          "reusing the stored session id when available). Works for any agent " +
          "type.\n" +
          "- **completed** or stopped tasks whose PR is merged/closed: 409.\n\n" +
          "Rate limited to 10 messages per user per task per minute.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: sendMessageSchema,
        response: {
          202: MessageAcceptedResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { content, mode } = req.body;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      if (req.user?.id) {
        const allowed = await messageService.canMessageTask(req.user.id, task);
        if (!allowed) {
          return reply.status(403).send({ error: "Not authorized to message this task" });
        }
      }

      const isRunningClaude = task.state === TaskState.RUNNING && task.agentType === "claude-code";
      const isRunningNonLive = task.state === TaskState.RUNNING && task.agentType !== "claude-code";
      const isStoppedResume = (STOPPED_RESUME_STATES as readonly string[]).includes(task.state);
      const isPreRun = (PRE_RUN_MESSAGE_STATES as readonly string[]).includes(task.state);

      if (task.state === TaskState.COMPLETED) {
        return reply.status(409).send({
          error:
            "Completed tasks cannot be resumed with a message. Create a new task for follow-up work.",
        });
      }

      if (isStoppedResume && ["merged", "closed"].includes(String((task as any).prState ?? ""))) {
        return reply.status(409).send({
          error:
            "This task's PR is merged or closed and cannot be resumed. Create a new task for follow-up work.",
        });
      }

      if (!isRunningClaude && !isRunningNonLive && !isStoppedResume && !isPreRun) {
        return reply.status(409).send({
          error: `Task is in '${task.state}' state. This task is not in a state where a message can be delivered.`,
        });
      }

      if (req.user?.id) {
        const redis = getRedisClient();
        const rateLimitKey = `optio:msg-rate:${id}:${req.user.id}`;
        const count = await redis.incr(rateLimitKey);
        if (count === 1) {
          await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SECONDS);
        }
        if (count > RATE_LIMIT_MAX) {
          return reply.status(429).send({
            error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} messages per minute per task.`,
          });
        }
      }

      const message = await messageService.sendMessage({
        taskId: id,
        content,
        mode,
        userId: req.user?.id,
        workspaceId: task.workspaceId ?? undefined,
      });

      // Record the message arrival itself (non-transitioning event) so the
      // task timeline shows user input even for the running-delivery path.
      // The interrupt subtype is preserved when applicable.
      const messageTrigger =
        mode === "interrupt" && (isRunningClaude || isStoppedResume)
          ? "user_interrupt"
          : "user_message";
      await taskService.recordTaskEvent(
        id,
        task.state,
        messageTrigger,
        content.slice(0, 200),
        req.user?.id,
      );

      const userDisplayName = req.user?.displayName ?? null;
      await publishEvent({
        type: "task:message",
        taskId: id,
        messageId: message.id,
        userId: req.user?.id ?? null,
        userDisplayName,
        content,
        mode,
        createdAt: message.createdAt.toISOString(),
      });

      let deliveredAt: string | null = null;

      if (isRunningClaude) {
        // Deliver mid-turn via the Redis channel → task-worker → stream-json stdin.
        await publishTaskMessage(id, {
          messageId: message.id,
          content,
          mode,
          userDisplayName,
        });
      } else if (isStoppedResume) {
        // Stopped + resumable: transition to queued and enqueue a resume run
        // with the user's message as the new prompt. The agent picks up from
        // the stored session id (if any) so context is preserved.
        const events = await taskService.getTaskEvents(id);
        const latestTrigger = events[events.length - 1]?.trigger ?? null;
        const requestedPrompt = content.trim();
        const resumePayload = buildPlanReviewResumePayload({
          task,
          latestTrigger,
          requestedPrompt,
        });

        await taskService.transitionTask(
          id,
          TaskState.QUEUED,
          "user_message_resume",
          content.slice(0, 200),
        );
        await taskQueue.add(
          "process-task",
          {
            taskId: id,
            resumeSessionId: resumePayload.resumeSessionId,
            resumePrompt: resumePayload.resumePrompt,
            approvedPlanPath: resumePayload.approvedPlanPath,
            approvedPlanContent: resumePayload.approvedPlanContent,
            ...(task.prUrl ? { restartFromBranch: true } : {}),
          },
          {
            jobId: `${id}-chat-${Date.now()}`,
            attempts: 1,
          },
        );
        // We'll mark delivery once the worker picks up and writes the first
        // log; for the chat UX, acking when the resume is queued is accurate
        // enough — the user's message has been handed off to the agent.
        await messageService.markDelivered(message.id);
        deliveredAt = new Date().toISOString();
        await publishEvent({
          type: "task:message_delivered",
          taskId: id,
          messageId: message.id,
          timestamp: deliveredAt,
        });
      }

      app.log.info(
        {
          taskId: id,
          messageId: message.id,
          userId: req.user?.id,
          fromState: task.state,
          delivery: isRunningClaude
            ? "running-stdin"
            : isStoppedResume
              ? "resume-queue"
              : isPreRun
                ? "pre-run-prompt"
                : "after-run-follow-up",
          contentPreview: content.slice(0, 200),
        },
        "Task message sent",
      );

      reply.status(202).send({
        message: {
          id: message.id,
          taskId: message.taskId,
          userId: message.userId,
          content: message.content,
          mode: message.mode,
          createdAt: message.createdAt.toISOString(),
          deliveredAt,
          ackedAt: null,
        },
      });
    },
  );

  app.get(
    "/api/tasks/:id/messages",
    {
      schema: {
        operationId: "listTaskMessages",
        summary: "List messages sent to a task",
        description:
          "Return all messages ever sent to a task, including their delivery " +
          "state. The returned list is ordered chronologically.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: MessagesListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      const messages = await messageService.listMessages(id);
      reply.send({
        messages: messages.map((m) => ({
          id: m.id,
          taskId: m.taskId,
          userId: m.userId,
          content: m.content,
          mode: m.mode,
          createdAt: m.createdAt,
          deliveredAt: m.deliveredAt,
          ackedAt: m.ackedAt,
          deliveryError: m.deliveryError,
          user: m.user,
        })),
      });
    },
  );
}
