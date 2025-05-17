[View Preview![](https://app.eraser.io/workspace/s3sbJ4hxh41FgttuaxYe/preview?elements=a8MCTVk9_kwjCLoM7HXyYg&type=embed)](https://app.eraser.io/workspace/s3sbJ4hxh41FgttuaxYe/preview?elements=a8MCTVk9_kwjCLoM7HXyYg&type=embed)



```bash
+--------------------+      WebSocket       +---------------------+
|  Broadcaster       | ==================>  |   WebSocket Server  |
|  (MediaRecorder)   |                      |     (Node.js)       |
+--------------------+                      +---------------------+
                                                   |
                                                   | Pipe media chunks
                                                   v
                                           +---------------------+
                                           |     FFmpeg Process  |
                                           |  (Convert to HLS)   |
                                           +---------------------+
                                                   |
                                                   | Upload HLS (.m3u8/.ts)
                                                   v
                                              +-------------+
                                              |     S3      |
                                              | (Origin)    |
                                              +-------------+
                                                 /       \
                                                /         \
                          Push URL + Metadata  /           \  Serve HLS
                        +----------------+     v            v
                        |     Redis      | <--->         +------------+
                        |  (Stream Info) |               |    CDN     |
                        +----------------+               | (Edge Cache)|
                                                         +------------+
                                                              |
                                                              | HLS Playback
                                                              v
                                                      +------------------+
                                                      |   Viewer Client  |
                                                      | (HTML5 Player)   |
                                                      +------------------+
```