import { Redis } from "ioredis";
import { and, desc, eq } from "drizzle-orm";
import type { WsEvent } from "@optio/shared";
import { db } from "../db/client.js";
import { taskLogs } from "../db/schema.js";
import { redisConnectionUrl, redisTlsOptions } from "./redis-config.js";
import { getCurrentTraceId } from "../telemetry/spans.js";

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(redisConnectionUrl, { tls: redisTlsOptions });
  }
  return publisher;
}

export async function publishEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;

  const eventForPublish = await enrichTaskLogEvent(event);

  // Attach current trace ID for correlation in observability backends
  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...eventForPublish, traceId } : eventForPublish;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  // Also publish to entity-specific channels for targeted subscriptions
  if ("taskId" in eventForPublish) {
    await redis.publish(`optio:task:${eventForPublish.taskId}`, JSON.stringify(enrichedEvent));
  }
  if ("prReviewId" in eventForPublish && eventForPublish.prReviewId) {
    await redis.publish(`optio:pr-review:${eventForPublish.prReviewId}`, JSON.stringify(enrichedEvent));
  }
}

async function enrichTaskLogEvent(event: WsEvent): Promise<WsEvent> {
  if (event.type !== "task:log") return event;

  const taskLogEvent = event as WsEvent & {
    logId?: string;
    logType?: string;
    metadata?: Record<string, unknown> | null;
  };
  if (taskLogEvent.logId && taskLogEvent.logType !== undefined) return event;

  try {
    const [log] = await db
      .select({
        id: taskLogs.id,
        timestamp: taskLogs.timestamp,
        logType: taskLogs.logType,
        metadata: taskLogs.metadata,
      })
      .from(taskLogs)
      .where(
        and(
          eq(taskLogs.taskId, event.taskId),
          eq(taskLogs.stream, event.stream),
          eq(taskLogs.content, event.content),
        ),
      )
      .orderBy(desc(taskLogs.timestamp))
      .limit(1);

    if (!log) return event;

    return {
      ...event,
      logId: log.id,
      timestamp: log.timestamp.toISOString(),
      logType: log.logType ?? undefined,
      metadata: log.metadata ?? undefined,
    } as WsEvent;
  } catch {
    return event;
  }
}

export async function publishSessionEvent(sessionId: string, event: WsEvent): Promise<void> {
  const redis = getPublisher();
  await redis.publish(`optio:session:${sessionId}`, JSON.stringify(event));
}

export async function publishWorkflowRunEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;

  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...event, traceId } : event;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  // Also publish to workflow-run-specific channel for targeted subscriptions
  if ("workflowRunId" in event) {
    await redis.publish(`optio:workflow-run:${event.workflowRunId}`, JSON.stringify(enrichedEvent));
  }
}

export async function publishPersistentAgentEvent(event: WsEvent): Promise<void> {
  const redis = getPublisher();
  const channel = `optio:events`;
  const traceId = getCurrentTraceId();
  const enrichedEvent = traceId ? { ...event, traceId } : event;

  await redis.publish(channel, JSON.stringify(enrichedEvent));

  if ("agentId" in event && event.agentId) {
    await redis.publish(`optio:persistent-agent:${event.agentId}`, JSON.stringify(enrichedEvent));
  }
}

/** Return the shared Redis client (usable for pub/sub publishing and general commands). */
export function getRedisClient(): Redis {
  return getPublisher();
}

export function createSubscriber(): Redis {
  return new Redis(redisConnectionUrl, { tls: redisTlsOptions });
}
