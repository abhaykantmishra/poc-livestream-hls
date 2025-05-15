const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const Redis = require('ioredis');
require('dotenv').config();

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// AWS S3 Config
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
  region: process.env.AWS_REGION,
});

// Redis (Docker container on localhost)
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

const HLS_DIR = path.join(__dirname, 'hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR);

app.use('/hls', express.static(HLS_DIR));

app.use(express.static('public'));

// 👇 Add this in your server.js
app.get('/api/stream/:streamId', async (req, res) => {
    const { streamId } = req.params;
  
    try {
      const metadata = await redis.hgetall(`stream:${streamId}`);
  
      if (!metadata || !metadata.url) {
        return res.status(404).json({ error: 'Stream not live' });
      }
  
      res.json({
        url: metadata.url,
        viewers: metadata.viewers || 0,
        updatedAt: metadata.updatedAt || null,
      });
    } catch (err) {
      console.error('Redis error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
});
  

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const streamId = url.pathname.split('/').pop();
  wss.handleUpgrade(req, socket, head, ws => handleStream(ws, streamId));
});

// async function handleStream(ws, streamId) {
//   const outputDir = path.join(HLS_DIR, streamId);
//   if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

//   const ffmpeg = spawn('ffmpeg', [
//     '-i', 'pipe:0',
//     '-c:v', 'libx264',
//     '-preset', 'ultrafast',
//     '-tune', 'zerolatency',
//     '-c:a', 'aac',
//     '-f', 'hls',
//     '-hls_time', '1',
//     '-hls_list_size', '5',
//     '-hls_flags', 'independent_segments',
//     `${outputDir}/stream.m3u8`,
//   ]);

//   ffmpeg.stderr.on('data', d => console.log(`FFmpeg: ${d}`));

//   ws.on('message', msg => {
//     ffmpeg.stdin.write(msg);
//     // Optionally increment viewer count here if needed
//     redis.hincrby(`stream:${streamId}`, 'viewers', 1);
//   });

//   ws.on('close', async () => {
//     ffmpeg.stdin.end();
//     console.log(`Stream ${streamId} closed. Uploading to S3...`);
//     await uploadToS3(streamId, outputDir);
//   });
// }

async function handleStream(ws, streamId) {
    const outputDir = path.join(HLS_DIR, streamId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', `${outputDir}/segment_%03d.ts`,
      `${outputDir}/stream.m3u8`,
    ]);
  
    ffmpeg.stderr.on('data', d => console.log(`FFmpeg: ${d}`));
  
    // 🆕 Immediately expose S3 playlist URL
    const playlistUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/hls/${streamId}/stream.m3u8`;
    await redis.hset(`stream:${streamId}`, {
      url: playlistUrl,
      viewers: 1,
      updatedAt: new Date().toISOString(),
    });
  
    // 🆕 Watch the output directory for changes and upload new files in real-time
    const watcher = fs.watch(outputDir, async (eventType, filename) => {
      if (!filename || (!filename.endsWith('.ts') && !filename.endsWith('.m3u8'))) return;
  
      try {
        const filePath = path.join(outputDir, filename);
        const fileStream = fs.createReadStream(filePath);
  
        await s3.upload({
          Bucket: process.env.S3_BUCKET,
          Key: `hls/${streamId}/${filename}`,
          Body: fileStream,
          ContentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T',
        }).promise();
  
        console.log(`✅ Uploaded live chunk: ${filename}`);
      } catch (err) {
        console.error(`❌ Upload error for ${filename}:`, err.message);
      }
    });
  
    ws.on('message', msg => {
      ffmpeg.stdin.write(msg);
      redis.hincrby(`stream:${streamId}`, 'viewers', 1);
    });
  
    ws.on('close', async () => {
      ffmpeg.stdin.end();
      watcher.close();
      console.log(`🔒 Stream ${streamId} closed.`);
    });
}
  

async function uploadToS3(streamId, dirPath) {
    try {
      const files = fs.readdirSync(dirPath);
  
      if (!files.length) {
        console.warn(`⚠️ No files found in ${dirPath} to upload`);
        return;
      }
  
      console.log(`Uploading ${files.length} files to S3 for stream ${streamId}...`);
  
      const uploadPromises = files.map(file => {
        const filePath = path.join(dirPath, file);
        const fileStream = fs.createReadStream(filePath);
  
        return s3.upload({
          Bucket: process.env.S3_BUCKET,
          Key: `hls/${streamId}/${file}`,
          Body: fileStream,
          ContentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T',
          ACL: 'public-read',
        }).promise().then(data => {
          console.log(`✅ Uploaded: ${file}`);
          return data;
        }).catch(err => {
          console.error(`❌ Failed to upload ${file}:`, err.message);
          throw err;
        });
      });
  
      await Promise.all(uploadPromises);
  
      const playlistUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/hls/${streamId}/stream.m3u8`;
  
      await redis.hset(`stream:${streamId}`, {
        url: playlistUrl,
        updatedAt: new Date().toISOString(),
        viewers: 0, // optional: initialize viewers count
      });
  
      console.log(`🚀 Uploaded stream ${streamId} to S3 and updated Redis with URL: ${playlistUrl}`);
    } catch (err) {
      console.error(`🔥 Upload failed for stream ${streamId}:`, err.message);
    }
}


server.listen(8000, () => console.log('Server running at http://localhost:8000'));
