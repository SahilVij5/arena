const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Use bundled, statically-linked ffmpeg/ffprobe binaries instead of whatever the OS
// happens to have installed. This avoids depending on the host's apt packages and
// their shared-library dependencies (e.g. libvpx, libx264) being fully present —
// a static binary has everything compiled in, so there's nothing for the dynamic
// linker to fail to find at runtime.
ffmpeg.setFfmpegPath(require('ffmpeg-static'));
ffmpeg.setFfprobePath(require('ffprobe-static').path);

/**
 * Probe a file on disk with ffprobe: confirms it actually contains a decodable
 * video stream (not just a spoofed Content-Type/extension) and returns its duration.
 * This is the authoritative content check — the multer fileFilter only looks at
 * the client-supplied mimetype, which is trivially forgeable.
 */
async function probeVideoFile(videoFilePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoFilePath, (err, metadata) => {
      if (err) {
        console.error('ffprobe validation error:', err.message);
        return resolve({ isValidVideo: false, durationSeconds: null });
      }
      const hasVideoStream = Array.isArray(metadata.streams) &&
        metadata.streams.some((s) => s.codec_type === 'video');
      resolve({
        isValidVideo: hasVideoStream,
        durationSeconds: Math.round(metadata.format?.duration || 0),
      });
    });
  });
}

/**
 * Generate a thumbnail from a video file path (no buffer needed).
 * Extracts frame at ~2s, returns JPEG buffer.
 */
async function generateThumbnailFromPath(videoFilePath) {
  const tmpDir = os.tmpdir();
  const thumbFilename = `pp_thumb_${crypto.randomUUID()}.jpg`;
  const thumbTmpPath = path.join(tmpDir, thumbFilename);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(videoFilePath)
        .on('end', resolve)
        .on('error', (err) => {
          console.error('ffmpeg thumbnail error:', err.message);
          reject(err);
        })
        .screenshots({
          timestamps: ['2'],
          filename: thumbFilename,
          folder: tmpDir,
          size: '1280x720',
        });
    });

    if (fs.existsSync(thumbTmpPath)) {
      const thumbBuffer = fs.readFileSync(thumbTmpPath);
      return thumbBuffer;
    }
    return null;
  } catch (err) {
    console.error('Thumbnail from path failed:', err.message);
    return null;
  } finally {
    try { if (fs.existsSync(thumbTmpPath)) fs.unlinkSync(thumbTmpPath); } catch (e) { /* ignore */ }
  }
}

module.exports = { generateThumbnailFromPath, probeVideoFile };
