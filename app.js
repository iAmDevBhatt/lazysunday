'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const audio         = document.getElementById('audio');
const btnPlay       = document.getElementById('btn-play');
const btnPrev       = document.getElementById('btn-prev');
const btnNext       = document.getElementById('btn-next');
const iconPlay      = btnPlay.querySelector('.icon-play');
const iconPause     = btnPlay.querySelector('.icon-pause');
const progressBar   = document.getElementById('progress-bar');
const progressFill  = document.getElementById('progress-fill');
const progressThumb = document.getElementById('progress-thumb');
const timeCurrent   = document.getElementById('time-current');
const timeTotal     = document.getElementById('time-total');
const trackTitle    = document.getElementById('track-title');
const trackArtist   = document.getElementById('track-artist');
const albumArt      = document.getElementById('album-art');
const artWrap       = albumArt.parentElement;
const clockEl       = document.getElementById('clock');
const heroTitle     = document.querySelector('.hero__title');
// Two background layers for crossfade
const bgA           = document.getElementById('bg-a');
const bgB           = document.getElementById('bg-b');

const FALLBACK_COVER = '/covers/default.jpg';

// ── State ─────────────────────────────────────────────────────
let PLAYLIST     = [];
let currentIndex = 0;
let isPlaying    = false;
let isScrubbing  = false;

// ── Helpers ───────────────────────────────────────────────────
function formatTime(s) {
  if (!isFinite(s) || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ── Startup: fetch config + playlist from server ──────────────
async function init() {
  try {
    const [cfgRes, plRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/playlist'),
    ]);
    const cfgData = await cfgRes.json();
    const plData  = await plRes.json();

    PLAYLIST = plData.tracks ?? [];

    if (PLAYLIST.length === 0) {
      trackTitle.textContent  = 'No tracks found';
      trackArtist.textContent = 'Check config.json';
      return;
    }

    const title = cfgData.siteTitle || 'LazySunday';
    if (heroTitle) heroTitle.textContent = title;
    document.title = title;

    initBackgrounds(cfgData.backgrounds);
    loadTrack(0, false);
  } catch (err) {
    console.error('Init failed:', err);
    trackTitle.textContent  = 'Failed to load';
    trackArtist.textContent = 'Server error';
  }
}

// ── Background rotation ───────────────────────────────────────
function initBackgrounds({ images = [], intervalSeconds = 15 } = {}) {
  if (images.length === 0) return;

  let activeBg  = bgA;    // the layer currently visible
  let standbyBg = bgB;    // the layer being prepared
  let imgIndex  = 0;

  function preload(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(src);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function crossfadeTo(src) {
    if (!src) return;
    standbyBg.style.backgroundImage = `url('${src}')`;
    // Force a repaint so the transition starts from opacity:0
    standbyBg.getBoundingClientRect();
    standbyBg.classList.add('bg--visible');
    activeBg.classList.remove('bg--visible');
    // Swap roles
    [activeBg, standbyBg] = [standbyBg, activeBg];
  }

  async function cycle() {
    imgIndex = (imgIndex + 1) % images.length;
    const src = await preload(images[imgIndex]);
    await crossfadeTo(src);
  }

  // Show first image immediately
  preload(images[0]).then(src => {
    if (src) {
      bgA.style.backgroundImage = `url('${src}')`;
      bgA.classList.add('bg--visible');
    }
  });

  if (images.length > 1) {
    setInterval(cycle, intervalSeconds * 1000);
  }
}

// ── Track loading ─────────────────────────────────────────────
function loadTrack(index, autoPlay = false) {
  currentIndex = ((index % PLAYLIST.length) + PLAYLIST.length) % PLAYLIST.length;
  const track  = PLAYLIST[currentIndex];

  audio.src = track.src;
  trackTitle.textContent  = track.title;
  trackArtist.textContent = track.artist;

  const img = new Image();
  img.onload  = () => { albumArt.src = track.cover; };
  img.onerror = () => { albumArt.src = FALLBACK_COVER; };
  img.src = track.cover;

  setProgress(0, 0);
  timeCurrent.textContent = '0:00';
  timeTotal.textContent   = '0:00';
  document.title = `${track.title} — ${(heroTitle && heroTitle.textContent) || 'LazySunday'}`;

  audio.load();
  autoPlay ? playAudio() : setPaused();
}

// ── Playback ──────────────────────────────────────────────────
function playAudio() {
  audio.play().then(setPlaying).catch(err => {
    if (err.name !== 'AbortError') console.warn('Playback failed:', err);
    setPaused();
  });
}

function setPlaying() {
  isPlaying = true;
  iconPlay.classList.add('hidden');
  iconPause.classList.remove('hidden');
  artWrap.classList.add('is-playing');
  btnPlay.setAttribute('aria-label', 'Pause');
}

function setPaused() {
  isPlaying = false;
  iconPlay.classList.remove('hidden');
  iconPause.classList.add('hidden');
  artWrap.classList.remove('is-playing');
  btnPlay.setAttribute('aria-label', 'Play');
}

// ── Progress ──────────────────────────────────────────────────
function setProgress(pct, currentSecs) {
  const p = clamp(pct, 0, 100);
  progressFill.style.width = `${p}%`;
  progressThumb.style.left = `${p}%`;
  progressBar.setAttribute('aria-valuenow', Math.round(p));
  timeCurrent.textContent  = formatTime(currentSecs);
}

function pctFromEvent(e) {
  const rect   = progressBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return clamp((clientX - rect.left) / rect.width, 0, 1);
}

function seekTo(pct) {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = pct * audio.duration;
  setProgress(pct * 100, audio.currentTime);
}

// ── Clock ─────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  clockEl.textContent =
    `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
}

// ── Controls ──────────────────────────────────────────────────
btnPlay.addEventListener('click', () => isPlaying ? (audio.pause(), setPaused()) : playAudio());

btnNext.addEventListener('click', () => loadTrack(currentIndex + 1, true));

btnPrev.addEventListener('click', () => {
  audio.currentTime > 3 ? (audio.currentTime = 0) : loadTrack(currentIndex - 1, true);
});

// ── Progress bar events ───────────────────────────────────────
progressBar.addEventListener('mousedown',  e => { isScrubbing = true; seekTo(pctFromEvent(e)); });
progressBar.addEventListener('touchstart', e => { isScrubbing = true; seekTo(pctFromEvent(e)); }, { passive: true });

progressBar.addEventListener('keydown', e => {
  if (!isFinite(audio.duration)) return;
  const step = audio.duration * 0.02;
  if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration, audio.currentTime + step);
  if (e.key === 'ArrowLeft')  audio.currentTime = Math.max(0, audio.currentTime - step);
});

document.addEventListener('mousemove',  e => { if (isScrubbing) seekTo(pctFromEvent(e)); });
document.addEventListener('touchmove',  e => { if (isScrubbing) seekTo(pctFromEvent(e)); }, { passive: true });
document.addEventListener('mouseup',   () => { isScrubbing = false; });
document.addEventListener('touchend',  () => { isScrubbing = false; });

// ── Audio element events ──────────────────────────────────────
audio.addEventListener('timeupdate', () => {
  if (isScrubbing || !isFinite(audio.duration)) return;
  setProgress((audio.currentTime / audio.duration) * 100, audio.currentTime);
});

audio.addEventListener('loadedmetadata', () => { timeTotal.textContent = formatTime(audio.duration); });
audio.addEventListener('durationchange', () => { timeTotal.textContent = formatTime(audio.duration); });
audio.addEventListener('ended',  () => loadTrack(currentIndex + 1, true));
audio.addEventListener('play',   setPlaying);
audio.addEventListener('pause',  setPaused);
audio.addEventListener('error',  () => {
  console.error('Audio error:', PLAYLIST[currentIndex]?.src);
  setTimeout(() => loadTrack(currentIndex + 1, isPlaying), 1500);
});

// ── Global keyboard shortcuts ─────────────────────────────────
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); btnPlay.click(); break;
    case 'ArrowRight': case 'l':
      if (document.activeElement !== progressBar) {
        e.preventDefault();
        if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      }
      break;
    case 'ArrowLeft': case 'j':
      if (document.activeElement !== progressBar) {
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
      break;
    case 'n': btnNext.click(); break;
    case 'p': btnPrev.click(); break;
  }
});

// ── Online counter via SSE ────────────────────────────────────
function initOnlineCounter() {
  const el = document.getElementById('online-count');
  if (!el) return;

  const es = new EventSource('/api/online/stream');

  es.onmessage = (e) => {
    const n = parseInt(e.data, 10);
    el.textContent = `${n} online`;
  };

  es.onerror = () => {
    // Connection dropped — EventSource auto-reconnects; nothing to show
  };
}

// ── Boot ──────────────────────────────────────────────────────
updateClock();
setInterval(updateClock, 10_000);
initOnlineCounter();
init();
