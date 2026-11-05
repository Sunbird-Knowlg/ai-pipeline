import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  type ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

export interface UploadRequest {
  path: string;
  content: string;
  contentType: string;
}

export interface UploadResult {
  url: string;
}

export type BlobUploader = (request: UploadRequest) => Promise<UploadResult>;
export type BlobDownloader = (path: string) => Promise<string>;

export type AuthType = 'ACCESS_KEY' | 'OIDC';

export interface BlobStorageOptions {
  accountName: string;
  container: string;
  authType: AuthType;
  accountKey?: string;
  connectionString?: string;
}

// The SDK's own retry loop (default maxTries: 4, its own backoff) would otherwise run inside
// every single ctx.run attempt, invisibly multiplying the retry count Restate thinks it owns --
// same reasoning as generate.ts's maxRetries: 0. Restate's own retry profile is the sole authority.
const pipelineOptions = { retryOptions: { maxTries: 1 } };

/**
 * Which credential backs the container client: a connection string (Azurite, local testing) wins
 * if present, then OIDC (`DefaultAzureCredential` — Workload Identity, only works from inside a
 * real AKS pod), then a plain shared key.
 */
function buildContainerClient(options: BlobStorageOptions): ContainerClient {
  if (options.connectionString) {
    return BlobServiceClient.fromConnectionString(
      options.connectionString,
      pipelineOptions,
    ).getContainerClient(options.container);
  }
  const url = `https://${options.accountName}.blob.core.windows.net`;
  if (options.authType === 'OIDC') {
    return new BlobServiceClient(
      url,
      new DefaultAzureCredential(),
      pipelineOptions,
    ).getContainerClient(options.container);
  }
  if (!options.accountKey) throw new Error('accountKey is required for ACCESS_KEY auth');
  const credential = new StorageSharedKeyCredential(options.accountName, options.accountKey);
  return new BlobServiceClient(url, credential, pipelineOptions).getContainerClient(
    options.container,
  );
}

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

export function createBlobDownloader(options: BlobStorageOptions): BlobDownloader {
  const containerClient = buildContainerClient(options);
  return async (path) => {
    const blockBlobClient = containerClient.getBlockBlobClient(path);
    const buffer = await blockBlobClient.downloadToBuffer();
    return buffer.toString('utf8');
  };
}

function optionsFromEnv(env: NodeJS.ProcessEnv): BlobStorageOptions {
  const authType = (env.AZURE_STORAGE_AUTH_TYPE as AuthType | undefined) ?? 'OIDC';
  const accountName = env.AZURE_STORAGE_ACCOUNT;
  const container = env.AZURE_STORAGE_CONTAINER;
  if (!accountName) throw new Error('AZURE_STORAGE_ACCOUNT is required');
  if (!container) throw new Error('AZURE_STORAGE_CONTAINER is required');
  return {
    accountName,
    container,
    authType,
    accountKey: env.AZURE_STORAGE_KEY,
    connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
  };
}

export function blobUploaderFromEnv(env: NodeJS.ProcessEnv = process.env): BlobUploader {
  return createBlobUploader(optionsFromEnv(env));
}

export function blobDownloaderFromEnv(env: NodeJS.ProcessEnv = process.env): BlobDownloader {
  return createBlobDownloader(optionsFromEnv(env));
}
