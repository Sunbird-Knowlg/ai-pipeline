import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { z } from 'zod';

export interface UploadRequest {
  /** e.g. "content/do_123/transcripts/en/transcript.json" — no leading slash. */
  path: string;
  content: string;
  contentType: string;
}

export interface UploadResult {
  url: string;
}

/** The one blob operation workflows depend on; auth mode stays behind it. */
export type BlobUploader = (request: UploadRequest) => Promise<UploadResult>;

/** Reads back a blob's text content — used to resume work against an already-uploaded artifact. */
export type BlobDownloader = (path: string) => Promise<string>;

export type AuthType = 'ACCESS_KEY' | 'OIDC';

export interface BlobStorageOptions {
  accountName: string;
  container: string;
  authType: AuthType;
  /** Required when `authType` is `ACCESS_KEY` and `connectionString` is not given. */
  accountKey?: string;
  /**
   * Full connection string override — the local-dev path (Azurite). Takes precedence over
   * `accountName`/`accountKey` when set, regardless of `authType`.
   */
  connectionString?: string;
}

/**
 * Auth mode is config-driven, matching the platform's own `cloud_storage_auth_type` convention
 * (`ACCESS_KEY` for local/dev, `OIDC` for production — `DefaultAzureCredential` picks up Workload
 * Identity env vars automatically in AKS).
 *
 * `OIDC` only authenticates when actually running in the cluster (it needs
 * `AZURE_FEDERATED_TOKEN_FILE` mounted by the pod's service account) — it cannot work from a
 * local Docker container. Local testing uses `connectionString` (Azurite) instead.
 */
function buildContainerClient({ accountName, container, authType, accountKey, connectionString }: BlobStorageOptions) {
  const client = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : authType === 'OIDC'
      ? new BlobServiceClient(
          `https://${accountName}.blob.core.windows.net`,
          new DefaultAzureCredential(),
        )
      : new BlobServiceClient(
          `https://${accountName}.blob.core.windows.net`,
          new StorageSharedKeyCredential(accountName, requireAccountKey(accountKey)),
        );
  return client.getContainerClient(container);
}

/** Azure Blob uploader — see {@link buildContainerClient} for the auth mode. */
export function createBlobUploader(options: BlobStorageOptions): BlobUploader {
  const containerClient = buildContainerClient(options);
  return async ({ path, content, contentType }) => {
    await containerClient.createIfNotExists();
    const blockBlobClient = containerClient.getBlockBlobClient(path);
    await blockBlobClient.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return { url: blockBlobClient.url };
  };
}

/** Azure Blob downloader — see {@link buildContainerClient} for the auth mode. */
export function createBlobDownloader(options: BlobStorageOptions): BlobDownloader {
  const containerClient = buildContainerClient(options);
  return async (path) => {
    const blockBlobClient = containerClient.getBlockBlobClient(path);
    const download = await blockBlobClient.downloadToBuffer();
    return download.toString('utf8');
  };
}

function requireAccountKey(accountKey: string | undefined): string {
  if (!accountKey) throw new Error('ACCESS_KEY auth requires accountKey or connectionString');
  return accountKey;
}

const envSchema = z.object({
  AZURE_STORAGE_ACCOUNT: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().min(1),
  AZURE_STORAGE_AUTH_TYPE: z.enum(['ACCESS_KEY', 'OIDC']).default('OIDC'),
  AZURE_STORAGE_KEY: z.string().optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
});

function optionsFromEnv(env: NodeJS.ProcessEnv): BlobStorageOptions {
  const parsed = envSchema.parse(env);
  return {
    accountName: parsed.AZURE_STORAGE_ACCOUNT,
    container: parsed.AZURE_STORAGE_CONTAINER,
    authType: parsed.AZURE_STORAGE_AUTH_TYPE,
    accountKey: parsed.AZURE_STORAGE_KEY,
    connectionString: parsed.AZURE_STORAGE_CONNECTION_STRING,
  };
}

export function blobUploaderFromEnv(env: NodeJS.ProcessEnv = process.env): BlobUploader {
  return createBlobUploader(optionsFromEnv(env));
}

export function blobDownloaderFromEnv(env: NodeJS.ProcessEnv = process.env): BlobDownloader {
  return createBlobDownloader(optionsFromEnv(env));
}
