import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Private R2 buckets through the S3 API (spec → Document storage; Cloudflare's presigned-URL guide). Files never pass
 * through the API on the way in: the client PUTs to a 10-minute presigned URL in `staging`, then the confirm step
 * checks the bytes and writes exactly those bytes into `evidence`, which a bucket lock keeps for the retention period.
 * Downloads are 5-minute presigned GETs. Unset R2_* variables: null, and the document routes answer 503.
 */
export type Storage = {
  stagingKey(tenantId: string, documentId: string): string;
  /** Stable per document (its creation month), so every retry of a confirm lands on the same key. */
  evidenceKey(tenantId: string, documentId: string, mime: string, createdMonth: string): string;
  presignUpload(key: string, mime: string, sizeBytes: number): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  presignDownload(key: string, documentId: string, mime: string): Promise<{ url: string; expiresAt: string }>;
  /** The staged file's bytes, or null if nothing was uploaded; reads at most maxBytes + 1 so an oversized file is detectable. */
  readStaged(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Writes the bytes that were verified, never a copy of the staged object (which the uploader could still replace). */
  putEvidence(evidenceKey: string, bytes: Buffer, mime: string, sha256: string): Promise<void>;
};

const UPLOAD_SECONDS = 600;
const DOWNLOAD_SECONDS = 300;
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' };
const expires = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export function storageFromEnv(): Storage | null {
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_STAGING_BUCKET, R2_EVIDENCE_BUCKET } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_STAGING_BUCKET || !R2_EVIDENCE_BUCKET) return null;
  const s3 = new S3Client({
    region: 'auto', // required by the SDK, unused by R2
    endpoint: R2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    // No SDK-added CRC checksums: a browser PUT to a presigned URL can't send them. The SHA-256 is checked on confirm.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    stagingKey: (tenantId, documentId) => `staging/${tenantId}/${documentId}`,
    evidenceKey: (tenantId, documentId, mime, createdMonth) => `evidence/${tenantId}/${createdMonth}/${documentId}.${EXT[mime] ?? 'bin'}`, // never a name (spec)
    async presignUpload(key, mime, sizeBytes) {
      // Content-Type and Content-Length are signed: the upload must be exactly the file the client declared.
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_STAGING_BUCKET, Key: key, ContentType: mime, ContentLength: sizeBytes }),
        { expiresIn: UPLOAD_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) });
      return { url, headers: { 'content-type': mime }, expiresAt: expires(UPLOAD_SECONDS) };
    },
    async presignDownload(key, documentId, mime) {
      // Always a download, typed as stored, named by id (never the user's filename): nothing renders inline on the R2 origin.
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_EVIDENCE_BUCKET, Key: key, ResponseContentType: mime,
        ResponseContentDisposition: `attachment; filename="${documentId}.${EXT[mime] ?? 'bin'}"` }), { expiresIn: DOWNLOAD_SECONDS });
      return { url, expiresAt: expires(DOWNLOAD_SECONDS) };
    },
    async readStaged(key, maxBytes) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: R2_STAGING_BUCKET, Key: key, Range: `bytes=0-${String(maxBytes)}` }));
        const arr = await out.Body?.transformToByteArray() ?? new Uint8Array();
        return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); // a view, not a second 20 MB copy
      } catch (err) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null;
        throw err;
      }
    },
    async putEvidence(evidenceKey, bytes, mime, sha256) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: R2_EVIDENCE_BUCKET, Key: evidenceKey, Body: bytes, ContentType: mime, ContentLength: bytes.length, Metadata: { sha256 } }));
      } catch (err) {
        // The bucket lock refuses to overwrite: an earlier confirm (or a racing one) already stored this document.
        // Only the very same file counts as done; anything else stays an error.
        const head = await s3.send(new HeadObjectCommand({ Bucket: R2_EVIDENCE_BUCKET, Key: evidenceKey })).catch(() => null);
        if (head?.Metadata?.sha256 !== sha256 || head.ContentLength !== bytes.length) throw err;
      }
    },
  };
}

/** The real type from the file's first bytes, never its name or declared type. HEIC: an ISO-BMFF ftyp box with a HEIF brand. */
export function sniffMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'hevc', 'heim', 'heis'].includes(bytes.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}
