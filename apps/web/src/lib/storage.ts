import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

type StorageConfig = {
  bucket: string;
  endpoint?: string;
  forcePathStyle: boolean;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

type StorageEnvironment = {
  NODE_ENV?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_REGION?: string;
};

export function parseStorageConfig(
  env: StorageEnvironment = process.env,
): StorageConfig {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) {
    throw new StorageConfigurationError("S3_BUCKET must be configured.");
  }

  const endpointValue = env.S3_ENDPOINT?.trim();
  let endpoint: string | undefined;
  if (endpointValue) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpointValue);
    } catch {
      throw new StorageConfigurationError("S3_ENDPOINT must be a valid URL.");
    }

    if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
      throw new StorageConfigurationError(
        "S3_ENDPOINT must use HTTP or HTTPS.",
      );
    }
    if (
      parsedEndpoint.username ||
      parsedEndpoint.password ||
      parsedEndpoint.search ||
      parsedEndpoint.hash
    ) {
      throw new StorageConfigurationError(
        "S3_ENDPOINT must not contain credentials, query parameters, or a fragment.",
      );
    }
    if (env.NODE_ENV === "production" && parsedEndpoint.protocol !== "https:") {
      throw new StorageConfigurationError(
        "S3_ENDPOINT must use HTTPS in production.",
      );
    }
    endpoint = parsedEndpoint.toString().replace(/\/$/, "");
  }

  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new StorageConfigurationError(
      "Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither.",
    );
  }

  const forcePathStyleValue = env.S3_FORCE_PATH_STYLE;
  if (
    forcePathStyleValue !== undefined &&
    forcePathStyleValue !== "true" &&
    forcePathStyleValue !== "false"
  ) {
    throw new StorageConfigurationError(
      "S3_FORCE_PATH_STYLE must be true or false.",
    );
  }

  return {
    bucket,
    endpoint,
    forcePathStyle:
      forcePathStyleValue === undefined
        ? Boolean(endpoint)
        : forcePathStyleValue === "true",
    region: env.S3_REGION?.trim() || "us-east-1",
    ...(accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : {}),
  };
}

function readUploadUrlTtl(env: NodeJS.ProcessEnv = process.env): number {
  const ttl = Number(env.S3_UPLOAD_URL_TTL_SECONDS ?? "600");
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) {
    throw new StorageConfigurationError(
      "S3_UPLOAD_URL_TTL_SECONDS must be an integer between 60 and 900.",
    );
  }
  return ttl;
}

let client: S3Client | undefined;

function getStorageClient(): { client: S3Client; config: StorageConfig } {
  const config = parseStorageConfig();
  client ??= new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }
      : {}),
  });
  return { client, config };
}

export function storageErrorResponse(error: unknown): Response | null {
  if (error instanceof StorageConfigurationError) {
    return Response.json(
      { error: "Object storage is not configured correctly." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof S3ServiceException) {
    console.error("Object storage request failed.", {
      name: error.name,
      statusCode: error.$metadata.httpStatusCode,
      requestId: error.$metadata.requestId,
    });
    return Response.json(
      { error: "Object storage service is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

export async function createUploadForm(
  storageKey: string,
  mimeType: string,
  sizeBytes: number,
): Promise<{ url: string; fields: Record<string, string>; expiresIn: number }> {
  const { client: storageClient, config } = getStorageClient();
  const expiresIn = readUploadUrlTtl();
  const form = await createPresignedPost(storageClient, {
    Bucket: config.bucket,
    Key: storageKey,
    Expires: expiresIn,
    Fields: { "Content-Type": mimeType },
    Conditions: [
      ["eq", "$Content-Type", mimeType],
      ["content-length-range", sizeBytes, sizeBytes],
    ],
  });

  return { ...form, expiresIn };
}

export async function getStoredObjectMetadata(
  storageKey: string,
): Promise<{ sizeBytes: number | undefined; mimeType: string | undefined } | null> {
  const { client: storageClient, config } = getStorageClient();
  try {
    const result = await storageClient.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: storageKey }),
    );
    return {
      sizeBytes: result.ContentLength,
      mimeType: result.ContentType,
    };
  } catch (error) {
    if (
      error instanceof S3ServiceException &&
      error.$metadata.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

export async function deleteStoredObject(storageKey: string): Promise<void> {
  const { client: storageClient, config } = getStorageClient();
  await storageClient.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: storageKey }),
  );
}

export async function createDownloadUrl(
  storageKey: string,
  mimeType: string,
  fileName: string,
): Promise<string> {
  const { client: storageClient, config } = getStorageClient();
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: storageKey,
    ResponseContentType: mimeType,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    ResponseCacheControl: "private, no-store",
  });
  const ttl = Number(process.env.S3_DOWNLOAD_URL_TTL_SECONDS ?? "300");
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) {
    throw new StorageConfigurationError(
      "S3_DOWNLOAD_URL_TTL_SECONDS must be an integer between 60 and 900.",
    );
  }
  return getSignedUrl(storageClient, command, { expiresIn: ttl });
}
