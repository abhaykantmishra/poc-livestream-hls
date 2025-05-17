const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
require('dotenv').config();

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const HLS_DIR = path.join(__dirname, 'hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR);

// AWS S3 Config
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
  region: process.env.AWS_REGION,
});

// Static hosting (optional if all files are uploaded and served via CloudFront)
app.use('/hls', express.static(HLS_DIR));
app.use(express.static('public'));

// Optional API to generate full CloudFront playlist URL
app.get('/api/stream/:streamId', (req, res) => {
  const { streamId } = req.params;

  // const playlistUrl = `${process.env.CLOUDFRONT_URL}/hls/${streamId}/stream.m3u8`;
  const playlistUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/hls/${streamId}/stream.m3u8`;

  res.json({
    url: playlistUrl,
  });
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const streamId = url.pathname.split('/').pop();
  wss.handleUpgrade(req, socket, head, ws => handleStream(ws, streamId));
});

async function handleStream(ws, streamId) {
  const outputDir = path.join(HLS_DIR, streamId);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-r', '25',                // Force 25 FPS
    '-g', '25',                // Keyframe every 25 frames = 1 second
    '-keyint_min', '25',       // Min interval for keyframes
    '-sc_threshold', '0',      // Disable scene detection for keyframes
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',          // Try to make 1-second segments
    '-hls_list_size', '5',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${outputDir}/segment_%03d.ts`,
    `${outputDir}/stream.m3u8`,
  ]);
  

  ffmpeg.stderr.on('data', d => console.log(`FFmpeg: ${d}`));

  const watcher = fs.watch(outputDir, async (eventType, filename) => {
    if (!filename || (!filename.endsWith('.ts') && !filename.endsWith('.m3u8'))) return;

    const filePath = path.join(outputDir, filename);
    try {
      const fileStream = fs.createReadStream(filePath);

      await s3.upload({
        Bucket: process.env.S3_BUCKET,
        Key: `hls/${streamId}/${filename}`,
        Body: fileStream,
        ContentType: filename.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/MP2T',
        ACL: 'public-read',
      }).promise();

      console.log(`✅ Uploaded: ${filename}`);

      // Delete after upload to reduce server load
      // fs.unlink(filePath, err => {
      //   if (err) console.error(`❌ Failed to delete ${filename}:`, err.message);
      // });
    } catch (err) {
      console.error(`❌ Upload error for ${filename}:`, err.message);
    }
  });

  ws.on('message', msg => {
    ffmpeg.stdin.write(msg);
  });

  ws.on('close', () => {
    ffmpeg.stdin.end();
    watcher.close();
    console.log(`🔒 Stream ${streamId} closed.`);

    fs.rm(outputDir, { recursive: true, force: true }, err => {
      if (err) console.error(`❌ Failed to delete ${outputDir}:`, err.message);
      else console.log(`🧹 Deleted local HLS dir: ${streamId}`);
    });
  });
}

server.listen(8000, () => console.log('🚀 Server running at http://localhost:8000'));
