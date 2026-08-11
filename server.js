'use strict';

const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const http        = require('http');
const { spawn }   = require('child_process');
const compression = require('compression');

// ── Load config ───────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read config.json:', err.message);
    process.exit(1);
  }
}

let cfg = loadConfig();

// Watch config for changes so a restart isn't needed
fs.watch(CONFIG_PATH, () => {
  try {
    cfg = loadConfig();
    console.log('[config] Reloaded config.json');
  } catch (_) { /* parse error — keep old config */ }
});

function audioDir()  { return cfg.music.local.path; }
function sourceType(){ return cfg.music.type; }

// ── Directories ───────────────────────────────────────────────
const PORT        = process.env.PORT || cfg.server?.port || 3000;
const PUBLIC_DIR  = path.join(__dirname, 'public');
const COVERS_DIR  = path.join(__dirname, 'covers');
const BG_DIR      = path.join(__dirname, 'backgrounds');

const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.flac', '.wav', '.m4a', '.opus']);

const MIME_TYPES = {
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.opus': 'audio/ogg; codecs=opus',
};

// ── App ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/audio/')) return false;
    return compression.filter(req, res);
  },
  level: 6,
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Static: frontend bundle
app.use(express.static(PUBLIC_DIR, { maxAge: '7d', etag: true, lastModified: true, index: false }));

// Static: cover art
app.use('/covers', express.static(COVERS_DIR, { maxAge: '30d', immutable: true }));

// Static: background images (served from /backgrounds/ folder next to server.js)
app.use('/backgrounds', express.static(BG_DIR, { maxAge: '1d' }));

// ── Online user tracking via Server-Sent Events ───────────────
const sseClients = new Set();

function broadcastOnlineCount() {
  const payload = `data: ${sseClients.size}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

app.get('/api/online/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tell Nginx not to buffer SSE
  res.flushHeaders();

  sseClients.add(res);
  broadcastOnlineCount();

  // Heartbeat every 25s keeps the connection alive through proxies
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    broadcastOnlineCount();
  });
});

// ── API: config snapshot for the frontend ─────────────────────
const BG_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

function resolveBackgroundImages() {
  const cfgImages = cfg.backgrounds?.images;

  // If config lists explicit images (non-empty array), use those
  if (Array.isArray(cfgImages) && cfgImages.length > 0) {
    console.log('[backgrounds] using config list:', cfgImages);
    return cfgImages.map(img =>
      /^https?:\/\//i.test(img) ? img : `/backgrounds/${img}`
    );
  }

  // Otherwise auto-scan the backgrounds/ folder
  try {
    const all   = fs.readdirSync(BG_DIR);
    const imgs  = all.filter(f => BG_IMAGE_EXTS.has(path.extname(f).toLowerCase())).sort();
    console.log(`[backgrounds] scanned ${BG_DIR} — found:`, imgs.length ? imgs : '(none)');
    return imgs.map(f => `/backgrounds/${f}`);
  } catch (err) {
    console.error('[backgrounds] cannot read folder:', BG_DIR, '—', err.message);
    return [];
  }
}

// Debug endpoint — remove once backgrounds are working
app.get('/api/debug/backgrounds', (req, res) => {
  let dirExists = false;
  let files     = [];
  let error     = null;

  try {
    files     = fs.readdirSync(BG_DIR);
    dirExists = true;
  } catch (err) {
    error = err.message;
  }

  res.json({
    bgDir:      BG_DIR,
    dirExists,
    allFiles:   files,
    imageFiles: files.filter(f => BG_IMAGE_EXTS.has(path.extname(f).toLowerCase())),
    resolved:   resolveBackgroundImages(),
    error,
  });
});

// Exposes only what the client needs — never the full config.
app.get('/api/config', (req, res) => {
  res.json({
    siteTitle: cfg.siteTitle || 'LazySunday',
    backgrounds: {
      intervalSeconds: cfg.backgrounds?.intervalSeconds ?? 15,
      images: resolveBackgroundImages(),
    },
  });
});

// ── API: playlist ──────────────────────────────────────────────
app.get('/api/playlist', async (req, res) => {
  try {
    if (sourceType() === 'youtube') {
      const tracks = await fetchYouTubePlaylist(cfg.music.youtube.playlistUrl);
      return res.json({ source: 'youtube', tracks });
    }

    // Local directory scan
    const dir = audioDir();
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      // Log the real path server-side only — never send it to the client
      console.error(`Cannot read music directory: ${dir} — ${err.message}`);
      return res.status(500).json({ error: 'Music directory unavailable' });
    }

    const tracks = files
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => {
        const name = path.parse(f).name;
        // Try to split "Artist - Title" convention
        const [rawArtist, ...titleParts] = name.split(' - ');
        const title  = titleParts.length ? titleParts.join(' - ') : name;
        const artist = titleParts.length ? rawArtist : 'Unknown';
        return {
          title:  title.replace(/[-_]/g, ' ').trim(),
          artist: artist.replace(/[-_]/g, ' ').trim(),
          src:    `/audio/local/${encodeURIComponent(f)}`,
          cover:  `/covers/${encodeURIComponent(name + '.jpg')}`,
        };
      });

    res.json({ source: 'local', tracks });
  } catch (err) {
    console.error('/api/playlist error:', err.message);
    res.status(500).json({ error: 'Failed to build playlist' });
  }
});

// ── Audio: local file streaming with Range support ─────────────
app.get('/audio/local/:filename', (req, res) => {
  const filename = path.basename(decodeURIComponent(req.params.filename));
  const ext      = path.extname(filename).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) return res.status(415).json({ error: 'Unsupported format' });

  // Resolve against the configured directory — safe because basename() already strips traversal
  const filePath = path.join(audioDir(), filename);

  fs.stat(filePath, (err, stat) => {
    if (err) {
      return err.code === 'ENOENT'
        ? res.status(404).json({ error: 'Track not found' })
        : res.status(500).json({ error: 'Server error' });
    }

    const fileSize = stat.size;
    const range    = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   mimeType,
        'Cache-Control':  'no-cache',
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', e => { console.error('stream error:', e); res.end(); });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   mimeType,
        'Accept-Ranges':  'bytes',
        'Cache-Control':  'no-cache',
      });

      const stream = fs.createReadStream(filePath);
      stream.on('error', e => { console.error('stream error:', e); res.end(); });
      stream.pipe(res);
    }
  });
});

// ── Audio: YouTube streaming via yt-dlp ───────────────────────
// Each request spawns yt-dlp for that video only.
// yt-dlp must be installed and on PATH.
app.get('/audio/yt/:videoId', (req, res) => {
  const videoId = req.params.videoId.replace(/[^a-zA-Z0-9_-]/g, ''); // sanitise
  if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=mp3]/bestaudio',
    '--no-playlist',
    '-o', '-',   // pipe to stdout
    url,
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[yt-dlp]', line);
  });

  ytdlp.on('error', err => {
    console.error('yt-dlp spawn error:', err.message, '— is yt-dlp installed?');
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp not available' });
    else res.end();
  });

  ytdlp.on('close', code => {
    if (code !== 0) console.warn(`[yt-dlp] exited ${code} for ${videoId}`);
    res.end();
  });

  // Kill yt-dlp if client disconnects mid-stream
  req.on('close', () => ytdlp.kill('SIGKILL'));
});

// ── YouTube playlist metadata via yt-dlp ──────────────────────
function fetchYouTubePlaylist(playlistUrl) {
  return new Promise((resolve, reject) => {
    if (!playlistUrl) return reject(new Error('No YouTube playlist URL set in config.json'));

    const ytdlp = spawn('yt-dlp', ['--flat-playlist', '-J', '--no-warnings', playlistUrl]);
    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => { stderr += d; });

    ytdlp.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
      try {
        const data = JSON.parse(stdout);
        const entries = Array.isArray(data.entries) ? data.entries : [];
        resolve(entries.map(e => ({
          title:  e.title  || e.id,
          artist: e.uploader || e.channel || 'YouTube',
          src:    `/audio/yt/${e.id}`,
          cover:  e.thumbnail || '/covers/default.jpg',
        })));
      } catch (err) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });

    ytdlp.on('error', err => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
  });
}

// ── SPA fallback ──────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, _next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 70_000;
server.setMaxListeners(200);

server.listen(PORT, () => {
  const src = sourceType() === 'youtube'
    ? `YouTube playlist: ${cfg.music.youtube.playlistUrl || '(not set)'}`
    : `Local path: ${audioDir()}`;
  console.log(`\n  लेज़ी संडे → http://localhost:${PORT}`);
  console.log(`  Music source : ${src}`);
  console.log(`  Backgrounds  : ${BG_DIR}`);
  console.log(`  Config       : ${CONFIG_PATH}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
