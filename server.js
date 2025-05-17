const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.static('public'));
app.use('/hls', express.static(path.join(__dirname, 'hls')));

if (!fs.existsSync('./hls')) fs.mkdirSync('./hls');

// Handle WebSocket Upgrade
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const streamId = url.pathname.split('/').pop();

  wss.handleUpgrade(req, socket, head, ws => {
    handleStream(ws, streamId);
  });
});

function handleStream(ws, streamId) {
  const outputDir = `./hls/${streamId}`;
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
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', `${outputDir}/segment_%03d.ts`,
    `${outputDir}/stream.m3u8`,
  ]);

  ffmpeg.stderr.on('data', d => console.log(`FFmpeg: ${d}`));

  ws.on('message', msg => ffmpeg.stdin.write(msg));
  ws.on('close', () => ffmpeg.stdin.end());
}

server.listen(8000, () => {
  console.log('Server running at http://localhost:8000');
});
