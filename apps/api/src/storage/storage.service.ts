import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import { config } from '../config';

/**
 * S3-compatible object storage (MinIO in dev, any S3 in prod) — docs/04-media-reports.md.
 * Objects are private; browsers get short-lived presigned URLs.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket = config.s3.bucket;

  private readonly client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
  });

  /** Separate client only for presigning, so URLs point at the host reachable by browsers. */
  private readonly presigner = new S3Client({
    endpoint: config.s3.publicEndpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
  });

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`created bucket ${this.bucket}`);
      } catch (err) {
        // Don't block API start-up; uploads will fail loudly instead.
        this.logger.error(`bucket ${this.bucket} unavailable: ${(err as Error).message}`);
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string, metadata?: Record<string, string>): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }),
    );
  }

  async getBuffer(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return out.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  presignGet(key: string, downloadName?: string): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
      }),
      { expiresIn: config.s3.presignTtlSeconds },
    );
  }
}
