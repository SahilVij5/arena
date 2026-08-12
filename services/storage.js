const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, PutBucketCorsCommand, PutObjectAclCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || '';
const SPACES_ACCESS_KEY = process.env.SPACES_ACCESS_KEY || '';
const SPACES_SECRET_KEY = process.env.SPACES_SECRET_KEY || '';
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'pixelplex';
const SPACES_REGION = process.env.SPACES_REGION || 'us-east-1';

let s3Client = null;

if (SPACES_ENDPOINT && SPACES_ACCESS_KEY && SPACES_SECRET_KEY) {
  // Use exact endpoint and region for Spaces
  s3Client = new S3Client({
    region: SPACES_REGION,
    endpoint: SPACES_ENDPOINT,
    credentials: {
      accessKeyId: SPACES_ACCESS_KEY,
      secretAccessKey: SPACES_SECRET_KEY,
    },
  });
  console.log('  DigitalOcean Spaces initialized');

  // Configure CORS on the bucket so browsers can PUT files directly
  // (required for presigned URL uploads — without this the browser's
  // preflight OPTIONS request is rejected and the XHR fails with a network error)
  s3Client.send(new PutBucketCorsCommand({
    Bucket: SPACES_BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedHeaders: ['*'],
        AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
        AllowedOrigins: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }],
    },
  })).then(() => {
    console.log('  Spaces CORS configured for direct browser uploads');
  }).catch((err) => {
    console.warn('  Could not set Spaces CORS (uploads may fail from browser):', err.message);
  });
}

function isStorageReady() {
  return s3Client !== null;
}

function generateUploadKey(folder, originalFilename) {
  const ext = path.extname(originalFilename).toLowerCase();
  const sanitized = path.basename(originalFilename, ext)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 50);
  return `${folder}/${crypto.randomUUID()}-${sanitized}${ext}`;
}

async function uploadFile(buffer, key, contentType) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read',
  });

  await s3Client.send(command);
  return getPublicUrl(key);
}

// Set an already-uploaded object to public-read. Used for files that arrive via
// a presigned browser PUT (which intentionally omits ACL to avoid signature
// mismatch), so the server flips them public after the upload is confirmed.
async function setObjectPublic(key) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new PutObjectAclCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    ACL: 'public-read',
  });

  await s3Client.send(command);
}

// Stream a file from disk to storage — memory usage stays flat (~10MB part buffer)
// regardless of file size, unlike passing a full buffer as the Body.
async function uploadFileStream(filePath, key, contentType) {
  if (!s3Client) throw new Error('Storage not configured');

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: SPACES_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024, // 10MB parts
  });

  await upload.done();
  return getPublicUrl(key);
}

async function downloadFile(key) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new GetObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
  });

  const response = await s3Client.send(command);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Download only the first N bytes of a file (for thumbnail generation)
async function downloadPartial(key, bytes = 5 * 1024 * 1024) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new GetObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    Range: `bytes=0-${bytes - 1}`,
  });

  const response = await s3Client.send(command);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Stream download to temp file
async function downloadToTempFile(key) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new GetObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
  });

  const response = await s3Client.send(command);
  const tmpPath = path.join(os.tmpdir(), `dl_${crypto.randomUUID()}${path.extname(key)}`);
  const writeStream = fs.createWriteStream(tmpPath);

  await new Promise((resolve, reject) => {
    response.Body.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    response.Body.on('error', reject);
  });

  return tmpPath;
}

async function deleteFile(key) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new DeleteObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
  });

  await s3Client.send(command);
}

function getPublicUrl(key) {
  try {
    const url = new URL(SPACES_ENDPOINT);
    return `https://${SPACES_BUCKET}.${url.host}/${key}`;
  } catch (err) {
    return `https://${SPACES_BUCKET}.digitaloceanspaces.com/${key}`;
  }
}

/**
 * Generate a presigned PUT URL that allows a browser to upload a file directly
 * to Spaces without routing through the Node.js server.
 *
 * @param {string} key         - Storage key (e.g. 'videos/uuid-name.mp4')
 * @param {string} contentType - MIME type the browser will send in Content-Type
 * @param {number} expiresIn   - Seconds until the URL expires (default 1 hour)
 */
async function generatePresignedUploadUrl(key, contentType, expiresIn = 3600) {
  if (!s3Client) throw new Error('Storage not configured');

  const command = new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });
  return url;
}

module.exports = {
  isStorageReady,
  generateUploadKey,
  generatePresignedUploadUrl,
  uploadFile,
  uploadFileStream,
  downloadFile,
  downloadPartial,
  downloadToTempFile,
  deleteFile,
  setObjectPublic,
  getPublicUrl,
};
