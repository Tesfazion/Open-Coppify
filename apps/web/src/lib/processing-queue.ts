import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";

export const processingQueueName = "coppify-processing-v1";
export const processingTaskName = "process-source-asset";

export const processingQueuePayloadSchema = z
  .object({
    processingJobId: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    sourceAssetId: z.string().min(1).max(64),
  })
  .strict();

export type ProcessingQueuePayload = z.infer<
  typeof processingQueuePayloadSchema
>;

export class QueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConfigurationError";
  }
}

type RedisEnvironment = {
  NODE_ENV?: string;
  REDIS_URL?: string;
};

export function parseRedisUrl(
  env: RedisEnvironment = process.env,
): string {
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new QueueConfigurationError("REDIS_URL must be configured.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(redisUrl);
  } catch {
    throw new QueueConfigurationError("REDIS_URL must be a valid URL.");
  }
  if (!parsedUrl.hostname) {
    throw new QueueConfigurationError("REDIS_URL must include a host.");
  }
  if (parsedUrl.protocol !== "redis:" && parsedUrl.protocol !== "rediss:") {
    throw new QueueConfigurationError(
      "REDIS_URL must use the redis or rediss protocol.",
    );
  }
  if (env.NODE_ENV === "production" && parsedUrl.protocol !== "rediss:") {
    throw new QueueConfigurationError("REDIS_URL must use TLS in production.");
  }

  return redisUrl;
}

let connection: IORedis | undefined;
let queue: Queue<ProcessingQueuePayload> | undefined;

function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(parseRedisUrl(), {
      connectTimeout: 5000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
    });
    connection.on("error", (error: Error) => {
      console.error("Processing queue Redis connection error.", error.name);
    });
  }
  return connection;
}

export function getProcessingQueue(): Queue<ProcessingQueuePayload> {
  queue ??= new Queue<ProcessingQueuePayload>(processingQueueName, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    },
  });
  return queue;
}

export async function enqueueProcessingJob(
  value: ProcessingQueuePayload,
): Promise<void> {
  const payload = processingQueuePayloadSchema.parse(value);
  await getProcessingQueue().add(processingTaskName, payload, {
    jobId: payload.processingJobId,
  });
}

export async function closeProcessingQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
  connection?.disconnect();
  connection = undefined;
}
