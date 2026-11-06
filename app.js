'use strict';
/* Chazara: audio is played by one native <audio> element. That is the only route on
   iPhone that keeps playing with the screen locked and gives pitch-preserving speed.
   Web Audio is deliberately not used in the playback path. */
const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5, 3];
const CHIPS = [1, 1.25, 1.5, 2, 2.5, 3];
const SLEEP = [10, 15, 20, 30, 45, 60];
const MIN_LOOP = 0.5;
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const $ = id => document.getElementById(id);
const audio = $('audio');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const S = {
  tracks: [], playlists: [], settings: { speed: 1, sort: 'played', theme: 'auto', repeat: false, lastTrackId: null, lastQueue: null, volume: 1 },
  cur: null, queue: null, view: 'all', playlistId: null, query: '',
  wantPlay: false, userPaused: true, interrupted: false, sleepAt: 0, url: null, pendingSeek: null,
  scrub: null, playerOpen: false, loadErr: null, sysOverride: null, rateCheck: null, rateWarned: false,
};

/* ---------- Storage ---------- */
let dbp;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('chazara', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('tracks', { keyPath: 'id' });
      d.createObjectStore('blobs', { keyPath: 'id' });
      d.createObjectStore('playlists', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    r.onsuccess = () => {
      r.result.onclose = () => { dbp = null; };
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Database blocked'));
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const q = fn(t.objectStore(store));
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Save was interrupted'));
  });
}
const put = (s, v, k) => tx(s, 'readwrite', o => o.put(v, k));
const get = (s, k) => tx(s, 'readonly', o => o.get(k));
const all = s => tx(s, 'readonly', o => o.getAll());
const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));
const saveTrack = t => put('tracks', t).catch(() => {});
const saveSettings = () => { lsSet('chz.settings', JSON.stringify(S.settings)); return put('kv', S.settings, 'settings').catch(() => {}); };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } };

/* Positions go to localStorage on every save because IndexedDB writes may not finish
   when iOS suspends the page. Boot merges whichever is newer. */
function savePosition(force) {
  const t = S.cur;
  if (!t || S.pendingSeek != null || S.scrub) return;
  const p = audio.currentTime;
  if (!isFinite(p)) return;
  t.position = p;
  t.updatedAt = Date.now();
  lsSet('chz.pos.' + t.id, JSON.stringify({ p, at: t.updatedAt }));
  const now = Date.now();
  if (force || now - (savePosition.last || 0) > 5000) { savePosition.last = now; saveTrack(t); }
}

/* ---------- Formatting ---------- */
function fmt(sec, tenth) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, sec);
  const whole = tenth ? Math.floor(sec) : Math.floor(sec + 1e-6);
  const h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = whole % 60;
  let out = (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  if (tenth) out += '.' + Math.floor((sec - whole) * 10 + 1e-6);
  return out;
}
function mins(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return 'Under 1 min';
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' hr' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}
const speedText = v => (Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)) + '×';
const speedIdx = v => { let b = 0; SPEEDS.forEach((s, i) => { if (Math.abs(s - v) < Math.abs(SPEEDS[b] - v)) b = i; }); return b; };
function cleanTitle(name) {
  let n = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const w = n.match(/^(?:\d+-)?WhatsApp (?:Audio|Ptt|Voice)\s*(\d{4})-(\d\d)-(\d\d)\s*at\s*(\d\d)[.:](\d\d)/i);
  if (w) {
    const d = new Date(+w[1], w[2] - 1, +w[3], +w[4], +w[5]);
    n = 'WhatsApp audio, ' + d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return n || 'Untitled shiur';
}

/* ---------- Import ---------- */
const EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', mov: 'audio/mp4', '3gp': 'audio/3gpp', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', caf: 'audio/x-caf', aif: 'audio/aiff', aiff: 'audio/aiff', webm: 'audio/webm', weba: 'audio/webm', amr: 'audio/amr' };
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const str = (a, n) => String.fromCharCode(...b.slice(a, a + n));
  if (str(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return 'audio/aac';
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio/mpeg';
  if (str(4, 4) === 'ftyp') return 'audio/mp4';
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') return 'audio/wav';
  if (str(0, 4) === 'OggS') return 'audio/ogg';
  if (str(0, 4) === 'fLaC') return 'audio/flac';
  if (str(0, 4) === 'caff') return 'audio/x-caf';
  if (str(0, 4) === 'FORM' && (str(8, 4) === 'AIFF' || str(8, 4) === 'AIFC')) return 'audio/aiff';
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'audio/webm';
  if (str(0, 5) === '#!AMR') return 'audio/amr';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (EXT[ext]) return EXT[ext];
  if ((file.type || '').startsWith('audio/')) return file.type;
  return null;
}
/* WhatsApp voice notes are Opus inside Ogg, which iPhones have not reliably played.
   iPhones do play Opus inside Apple's CAF container, and moving the audio packets
   from one container to the other loses no quality and takes a moment. */
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
async function prepareForDevice(file, type) {
  if (type === 'audio/ogg' && (IS_IOS || window.__forceCaf)) {
    try {
      const caf = oggOpusToCaf(await file.arrayBuffer());
      if (caf) return new Blob([caf], { type: 'audio/x-caf' });
    } catch (e) { /* fall through and try the original file */ }
  }
  return new Blob([file], { type });
}
function oggOpusToCaf(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let pos = 0, serial = null, partial = [];
  const packets = [];
  while (pos + 27 <= u8.length) {
    if (dv.getUint32(pos) !== 0x4F676753) return null;
    const pageSerial = dv.getUint32(pos + 14, true);
    const nseg = u8[pos + 26];
    let body = pos + 27 + nseg;
    if (serial === null) serial = pageSerial;
    const mine = pageSerial === serial;
    for (let i = 0; i < nseg; i++) {
      const len = u8[pos + 27 + i];
      if (mine) partial.push(u8.subarray(body, body + len));
      body += len;
      if (len < 255 && mine) {
        const size = partial.reduce((s, p) => s + p.length, 0);
        const pk = new Uint8Array(size);
        let o = 0;
        for (const p of partial) { pk.set(p, o); o += p.length; }
        packets.push(pk);
        partial = [];
      }
    }
    pos = body;
  }
  if (packets.length < 3) return null;
  const head = packets[0];
  if (String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') return null;
  const channels = head[9];
  if (channels < 1 || channels > 2) return null;
  const audioPk = packets.slice(2).filter(p => p.length);
  const frames = audioPk.map(opusPacketSamples);
  const constant = frames.every(f => f === frames[0]) ? frames[0] : 0;
  const totalFrames = frames.reduce((s, f) => s + f, 0);
  const dataLen = audioPk.reduce((s, p) => s + p.length, 0);
  const varint = [];
  const pushVar = n => {
    const bytes = [n & 0x7F];
    n = Math.floor(n / 128);
    while (n > 0) { bytes.unshift((n & 0x7F) | 0x80); n = Math.floor(n / 128); }
    varint.push(...bytes);
  };
  audioPk.forEach((p, i) => { pushVar(p.length); if (!constant) pushVar(frames[i]); });
  const paktLen = 24 + varint.length;
  const out = new Uint8Array(8 + 44 + 24 + 12 + 4 + dataLen + 12 + paktLen);
  const w = new DataView(out.buffer);
  let o = 0;
  const tag = s => { for (let i = 0; i < 4; i++) out[o++] = s.charCodeAt(i); };
  const u32 = v => { w.setUint32(o, v); o += 4; };
  const i64 = v => { w.setUint32(o, Math.floor(v / 4294967296)); w.setUint32(o + 4, v % 4294967296); o += 8; };
  tag('caff'); w.setUint16(o, 1); w.setUint16(o + 2, 0); o += 4;
  tag('desc'); i64(32); w.setFloat64(o, 48000); o += 8; tag('opus'); u32(0); u32(0); u32(constant); u32(channels); u32(0);
  tag('chan'); i64(12); u32(channels === 1 ? (100 << 16) | 1 : (101 << 16) | 2); u32(0); u32(0);
  tag('data'); i64(4 + dataLen); u32(0);
  for (const p of audioPk) { out.set(p, o); o += p.length; }
  tag('pakt'); i64(paktLen); i64(audioPk.length); i64(totalFrames); u32(0); u32(0);
  out.set(varint, o);
  return out.buffer;
}
function opusPacketSamples(p) {
  const toc = p[0], cfg = toc >> 3, code = toc & 3;
  let size;
  if (cfg < 12) size = [480, 960, 1920, 2880][cfg % 4];
  else if (cfg < 16) size = [480, 960][cfg % 2];
  else size = [120, 240, 480, 960][(cfg - 16) % 4];
  const count = code === 0 ? 1 : code === 3 ? (p[1] & 0x3F) : 2;
  return size * count;
}
function probeDuration(blob) {
  return new Promise(res => {
    const a = new Audio(), url = URL.createObjectURL(blob);
    const done = v => { clearTimeout(timer); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(url); res(v); };
    const timer = setTimeout(() => done(null), 6000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    a.src = url;
  });
}
async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  requestPersistence();
  let firstId = null, added = 0, skipped = 0;
  const failures = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(files.length > 1 ? `Saving ${i + 1} of ${files.length}` : 'Saving shiur', 60000);
    try {
      const type = await sniff(f);
      if (!type) { failures.push(`${f.name} is not an audio file`); continue; }
      const dup = S.tracks.find(t => t.fileName === f.name && t.size === f.size);
      if (dup) { skipped++; firstId = firstId || dup.id; continue; }
      const blob = await prepareForDevice(f, type);
      const id = uid();
      const duration = await probeDuration(blob);
      const track = { id, title: cleanTitle(f.name), fileName: f.name, size: f.size, type: blob.type, duration, addedAt: Date.now(), lastPlayedAt: 0, position: 0, finished: false, a: null, b: null, loopOn: false, updatedAt: Date.now() };
      await saveAudio(id, blob);
      await put('tracks', track);
      S.tracks.push(track);
      firstId = firstId || id;
      added++;
    } catch (e) {
      const full = isQuota(e);
      failures.push(full ? `${f.name} does not fit: free up iPhone storage and try again` : `${f.name} could not be saved`);
    }
  }
  renderList();
  if (failures.length) toast(failures[0] + (failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''), 6000);
  else if (skipped && !added) toast('Already in your library. Opening it.');
  else hideToast();
  if (firstId) { await loadTrack(firstId, { autoplay: true }); openPlayer(); }
}
/* Some iPhone in-app browsers refuse to store audio files in the database but accept
   raw bytes, so a failed save is retried as bytes. A full phone is reported, not retried. */
const isQuota = e => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
async function saveAudio(id, blob) {
  try {
    await put('blobs', { id, blob });
  } catch (e) {
    if (isQuota(e)) throw e;
    await put('blobs', { id, buf: await blob.arrayBuffer(), type: blob.type });
  }
}
function storedBlob(rec) {
  if (!rec) return null;
  if (rec.blob) return rec.blob;
  if (rec.buf) return new Blob([rec.buf], { type: rec.type || 'audio/mpeg' });
  return null;
}
function requestPersistence() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* optional */ }
}

/* ---------- Engine ---------- */
function applyPitch() {
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
  audio.mozPreservesPitch = true;
}
function applyRate() {
  applyPitch();
  audio.defaultPlaybackRate = S.settings.speed;
  audio.playbackRate = S.settings.speed;
  S.rateCheck = null;
  updatePositionState();
}
function setSpeed(v) {
  S.settings.speed = v;
  applyRate();
  saveSettings();
  renderSpeed();
  renderTimes();
}
async function loadTrack(id, { autoplay = false, fromStart = false, queue } = {}) {
  const t = S.tracks.find(x => x.id === id);
  if (!t) return;
  if (S.cur && S.cur.id !== id) savePosition(true);
  if (queue !== undefined) S.queue = queue;
  S.wantPlay = autoplay;
  let rec;
  try { rec = await get('blobs', id); } catch (e) { rec = null; }
  const audioBlob = storedBlob(rec);
  if (!audioBlob) {
    showTrackError(t, 'This audio is no longer saved on this device. Delete it and add the file again.');
    return;
  }
  stopPriming();
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(audioBlob);
  S.cur = t;
  S.loadErr = null;
  const atEnd = t.finished || (t.duration && t.position >= t.duration - 2);
  S.pendingSeek = (fromStart || atEnd) ? 0 : (t.position || 0);
  if (t.loopOn && t.a != null && t.b != null && (S.pendingSeek < t.a || S.pendingSeek > t.b)) S.pendingSeek = t.a;
  if (fromStart || atEnd) { t.finished = false; t.position = 0; }
  S.settings.lastTrackId = id;
  S.settings.lastQueue = S.queue;
  saveSettings();
  audio.src = S.url;
  applyPitch();
  audio.load();
  renderPlayer();
  renderList();
  updateMetadata();
  if (autoplay) await play();
}
function showTrackError(t, msg) {
  S.cur = t; S.loadErr = msg; S.wantPlay = false;
  renderPlayer();
  openPlayer();
}
function applyPendingSeek() {
  if (S.pendingSeek == null || audio.readyState < 1) return;
  const want = S.pendingSeek;
  S.pendingSeek = null;
  const d = audio.duration;
  try { audio.currentTime = isFinite(d) ? clamp(want, 0, d) : want; } catch (e) { S.pendingSeek = want; }
  renderTimes();
}
async function play() {
  if (!S.cur) { pickFiles(); return; }
  if (S.loadErr) return;
  S.wantPlay = true; S.userPaused = false; S.interrupted = false;
  stopPriming();
  try {
    if (audio.ended) audio.currentTime = S.cur.a != null && S.cur.loopOn ? S.cur.a : 0;
    await audio.play();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      S.wantPlay = false;
      toast('Tap play to start');
      renderPlayState();
    } else if (e && e.name !== 'AbortError') {
      S.wantPlay = false;
      renderPlayState();
    }
  }
}
function pause() {
  S.wantPlay = false; S.userPaused = true; S.interrupted = false;
  audio.pause();
  savePosition(true);
}
const toggle = () => (audio.paused ? play() : pause());

function seekTo(t, { user = true } = {}) {
  if (!S.cur) return;
  const d = dur();
  t = d ? clamp(t, 0, d) : Math.max(0, t);
  const c = S.cur;
  if (user && c.loopOn && c.a != null && c.b != null && (t < c.a - 0.25 || t > c.b + 0.25)) {
    c.loopOn = false; saveTrack(c);
    toast('Section repeat is off. Your A and B points are kept.');
    renderLoop();
  }
  if (c.finished && t < (d || Infinity) - 1) c.finished = false;
  if (S.pendingSeek != null || audio.readyState < 1) { S.pendingSeek = t; } else {
    try { audio.currentTime = t; } catch (e) { S.pendingSeek = t; }
  }
  S.rateCheck = null;
  renderTimes(t);
  updatePositionState();
  savePosition();
}
const dur = () => {
  if (isFinite(audio.duration) && audio.duration > 0 && S.cur && audio.src) return audio.duration;
  return (S.cur && S.cur.duration) || 0;
};
const now = () => (S.pendingSeek != null ? S.pendingSeek : audio.currentTime || 0);

/* Loop and sleep checks run from several clocks because iOS throttles timers when locked. */
function enforce() {
  const c = S.cur;
  if (c && c.loopOn && c.a != null && c.b != null && !audio.paused && !audio.seeking) {
    if (audio.currentTime >= c.b - 0.02 * audio.playbackRate) {
      audio.currentTime = c.a;
      scheduleLoop();
      updatePositionState();
    }
  }
  if (S.sleepAt && Date.now() >= S.sleepAt) {
    S.sleepAt = 0;
    if (!audio.paused) { pause(); toast('Sleep timer stopped playback'); }
    renderSleep();
  }
}
let loopTimer = 0;
function scheduleLoop() {
  clearTimeout(loopTimer);
  const c = S.cur;
  if (!c || !c.loopOn || c.b == null || audio.paused) return;
  const wait = (c.b - audio.currentTime) / (audio.playbackRate || 1) * 1000;
  if (wait > 0) loopTimer = setTimeout(() => { enforce(); scheduleLoop(); }, Math.max(10, wait - 15));
}
function frame() {
  enforce();
  if (!audio.paused && S.playerOpen && !document.hidden) { renderTimes(); requestAnimationFrame(frame); }
}
setInterval(() => {
  enforce();
  if (S.sleepAt) renderSleep();
}, 250);

/* iPhone may cap very high speeds. Measure real progress so the app never claims a speed it isn't delivering. */
function checkEffectiveRate() {
  if (audio.paused || audio.seeking || audio.playbackRate <= 2 || S.rateWarned) { S.rateCheck = null; return; }
  const n = performance.now();
  if (!S.rateCheck) { S.rateCheck = { w: n, p: audio.currentTime }; return; }
  const wall = (n - S.rateCheck.w) / 1000;
  if (wall < 4) return;
  const real = (audio.currentTime - S.rateCheck.p) / wall;
  S.rateCheck = null;
  if (real > 0.2 && real < audio.playbackRate * 0.82) {
    S.rateWarned = true;
    toast(`This device is delivering about ${real.toFixed(1)}×, below the ${speedText(audio.playbackRate)} you chose.`, 6000);
  }
}

function afterEnd() {
  const c = S.cur;
  if (!c) return;
  if (c.loopOn && c.a != null) { audio.currentTime = c.a; audio.play().catch(() => {}); return; }
  if (S.settings.repeat) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  c.finished = true;
  c.position = dur();
  lsDel('chz.pos.' + c.id);
  saveTrack(c);
  renderList();
  const n = nextInQueue();
  if (n) { loadTrack(n.id, { autoplay: true, fromStart: true }); return; }
  S.wantPlay = false;
  renderPlayState();
}
function nextInQueue() {
  if (!S.queue || !S.cur) return null;
  const pl = S.playlists.find(p => p.id === S.queue);
  if (!pl) return null;
  const i = pl.trackIds.indexOf(S.cur.id);
  const nid = pl.trackIds[i + 1];
  return nid ? S.tracks.find(t => t.id === nid) : null;
}
function fileError() {
  const c = S.cur;
  const name = (c && c.fileName) || '';
  if (audio.src === SILENT) return;
  if (/\.(opus|ogg|oga)$/i.test(name) || (c && c.type === 'audio/ogg')) {
    return 'This device cannot play this voice-note format. Ask the sender for an MP3 or M4A copy.';
  }
  const code = audio.error && audio.error.code;
  if (code === 2) return 'The file could not be read. Try adding it again.';
  return 'This device cannot play this file. Try an MP3 or M4A copy.';
}

let priming = false, primeSeq = 0;
function stopPriming() {
  if (priming) { priming = false; primeSeq++; audio.muted = false; }
}
/* iOS only allows audio.play() from a tap. Playing silently once during the first tap
   unlocks the element, so a later play after importing or loading from storage succeeds. */
function primeAudio() {
  if (primeAudio.done || !audio.paused) return;
  primeAudio.done = true;
  const seq = ++primeSeq;
  priming = true;
  audio.muted = true;
  if (!audio.src) audio.src = SILENT;
  const p = audio.play();
  const finish = () => {
    if (seq !== primeSeq) return;
    priming = false;
    if (!S.wantPlay) audio.pause();
    audio.muted = false;
    if (audio.src === SILENT) audio.removeAttribute('src');
  };
  if (p) p.then(finish, finish); else finish();
}

audio.addEventListener('loadedmetadata', () => {
  if (audio.src === SILENT || !S.cur) return;
  applyRate();
  if (isFinite(audio.duration) && audio.duration > 0 && S.cur.duration !== audio.duration) {
    S.cur.duration = audio.duration;
    saveTrack(S.cur);
    renderList();
  }
  applyPendingSeek();
  renderPlayer();
  updatePositionState();
});
audio.addEventListener('canplay', () => { applyPendingSeek(); });
audio.addEventListener('playing', () => {
  if (priming || audio.src === SILENT) return;
  applyRate();
  applyPendingSeek();
  if (S.cur) { S.cur.lastPlayedAt = Date.now(); saveTrack(S.cur); }
  setMediaState('playing');
  updateMetadata();
  updatePositionState();
  renderPlayState();
  scheduleLoop();
  requestAnimationFrame(frame);
});
audio.addEventListener('play', () => { if (!priming) { setMediaState('playing'); renderPlayState(); } });
audio.addEventListener('pause', () => {
  clearTimeout(loopTimer);
  if (priming || audio.src === SILENT || audio.ended) return;
  /* A pause we did not ask for: a phone call, Siri, another app, or headphones removed. */
  if (S.wantPlay && !S.userPaused) { S.interrupted = true; S.wantPlay = false; }
  setMediaState('paused');
  savePosition(true);
  updatePositionState();
  renderPlayState();
});
audio.addEventListener('timeupdate', () => {
  if (priming || audio.src === SILENT) return;
  enforce();
  checkEffectiveRate();
  savePosition();
  if (!S.playerOpen || document.hidden || audio.paused) renderTimes();
});
audio.addEventListener('seeked', () => { renderTimes(); scheduleLoop(); updatePositionState(); });
audio.addEventListener('ratechange', () => {
  if (Math.abs(audio.playbackRate - S.settings.speed) > 0.001 && !priming && S.cur && audio.src !== SILENT) {
    audio.playbackRate = S.settings.speed;
  }
});
audio.addEventListener('ended', afterEnd);
audio.addEventListener('error', () => {
  if (audio.src === SILENT || !audio.getAttribute('src') || !S.cur) return;
  S.loadErr = fileError();
  S.wantPlay = false;
  renderPlayer();
});
audio.addEventListener('volumechange', () => { const v = $('volRange'); if (v) v.value = audio.volume; });

/* Interruptions */
if (navigator.audioSession) {
  try {
    navigator.audioSession.type = 'playback';
    navigator.audioSession.addEventListener('statechange', () => {
      const st = navigator.audioSession.state;
      if (st === 'interrupted' && !audio.paused) S.interrupted = true;
      if (st === 'active' && S.interrupted && !S.userPaused) {
        resumeAfterInterruption();
      }
    });
  } catch (e) { /* older iOS */ }
}
function resumeAfterInterruption() {
  S.interrupted = false;
  try { audio.currentTime = Math.max(S.cur && S.cur.loopOn && S.cur.a != null ? S.cur.a : 0, audio.currentTime - 2); } catch (e) { /* ignore */ }
  S.wantPlay = true;
  audio.play().catch(() => { S.wantPlay = false; renderPlayState(); });
}

/* Lock screen, Control Center, AirPods */
function setMediaState(v) { if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = v; } catch (e) { /* optional */ } } }
function updateMetadata() {
  if (!('mediaSession' in navigator) || !S.cur || !window.MediaMetadata) return;
  const pl = S.queue && S.playlists.find(p => p.id === S.queue);
  try {
    const base = new URL('icons/', document.baseURI).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.cur.title, artist: 'Chazara', album: pl ? pl.name : 'Shiurim',
      artwork: [{ src: base + 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: base + 'icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
  } catch (e) { /* optional */ }
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, d) }); } catch (e) { /* optional */ }
}
if ('mediaSession' in navigator) {
  const on = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch (e) { /* unsupported action */ } };
  on('play', () => play());
  on('pause', () => pause());
  on('stop', () => pause());
  on('seekbackward', d => seekTo(now() - ((d && d.seekOffset) || 15)));
  on('seekforward', d => seekTo(now() + ((d && d.seekOffset) || 15)));
  on('seekto', d => { if (d && d.seekTime != null) seekTo(d.seekTime); });
}

/* ---------- A-B ---------- */
function setPoint(which) {
  const c = S.cur;
  if (!c) return;
  if (audio.readyState < 1) { toast('Wait for the audio to load'); return; }
  const t = Math.round(now() * 10) / 10;
  c[which] = t;
  if (c.a != null && c.b != null) {
    if (c.a > c.b) { const x = c.a; c.a = c.b; c.b = x; }
    if (c.b - c.a < MIN_LOOP) {
      c[which] = null;
      c.loopOn = false;
      toast('Choose points at least half a second apart');
    } else {
      c.loopOn = true;
      seekTo(c.a, { user: false });
      if (S.wantPlay || !audio.paused) scheduleLoop();
    }
  }
  saveTrack(c);
  renderLoop();
}
function nudge(which, delta) {
  const c = S.cur;
  if (!c || c[which] == null) return;
  const d = dur() || Infinity;
  let v = Math.round((c[which] + delta) * 10) / 10;
  v = which === 'a' ? clamp(v, 0, c.b != null ? c.b - MIN_LOOP : d) : clamp(v, c.a != null ? c.a + MIN_LOOP : 0, d);
  c[which] = v;
  saveTrack(c);
  renderLoop();
  /* Jump so the change can be heard straight away. */
  if (c.loopOn) {
    seekTo(which === 'a' ? v : Math.max(c.a, v - 2), { user: false });
    scheduleLoop();
  }
}
function clearLoop() {
  const c = S.cur;
  if (!c) return;
  c.a = c.b = null; c.loopOn = false;
  saveTrack(c);
  clearTimeout(loopTimer);
  renderLoop();
}

/* ---------- Render: player ---------- */
function setUse(el, id) { if (el) el.setAttribute('href', '#' + id); }
function renderPlayState() {
  const playing = !audio.paused && !priming;
  setUse($('playIcon'), playing ? 'i-pause' : 'i-play');
  setUse($('miniIcon'), playing ? 'i-pause' : 'i-play');
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  renderSub();
}
function renderSub() {
  const c = S.cur;
  if (!c) return;
  const pl = S.queue && S.playlists.find(p => p.id === S.queue);
  const n = nextInQueue();
  let txt = '';
  if (S.interrupted && audio.paused) txt = 'Paused by the phone. Tap play to continue.';
  else if (pl) {
    const i = pl.trackIds.indexOf(c.id);
    txt = `${esc(pl.name)}, ${i + 1} of ${pl.trackIds.length}${n ? '. Next: ' + esc(n.title) : ''}`;
  } else {
    const d = dur(), left = d - now(), sp = S.settings.speed;
    if (d) txt = sp === 1 ? mins(left) + ' left' : `${mins(left / sp)} left at ${speedText(sp)}`;
  }
  $('pSub').innerHTML = txt;
}
function renderTimes(forced) {
  const c = S.cur;
  if (!c) return;
  const d = dur();
  const t = forced != null ? forced : S.scrub ? S.scrub.value : now();
  $('elapsed').textContent = fmt(t);
  $('remain').textContent = d ? '-' + fmt(Math.max(0, d - t)) : '--:--';
  const pct = d ? clamp(t / d * 100, 0, 100) : 0;
  $('tlFill').style.width = pct + '%';
  $('tlThumb').style.left = pct + '%';
  const tl = $('tl');
  tl.setAttribute('aria-valuemax', Math.round(d));
  tl.setAttribute('aria-valuenow', Math.round(t));
  tl.setAttribute('aria-valuetext', fmt(t));
  $('miniFill').style.width = pct + '%';
  $('miniTime').textContent = d ? `${fmt(t)} of ${fmt(d)}` : fmt(t);
  const tick = Math.floor(Date.now() / 2000);
  if (tick !== renderTimes.tick) { renderTimes.tick = tick; renderSub(); }
}
function renderSpeed() {
  const v = S.settings.speed;
  $('speedVal').textContent = speedText(v);
  $('speedRange').value = speedIdx(v);
  $('speedRange').setAttribute('aria-valuetext', speedText(v));
  $('miniSpeed').textContent = speedText(v);
  [...$('chips').children].forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.speed === v)));
}
function renderTicks() {
  const d = dur(), host = $('tlTicks');
  if (!d) { host.innerHTML = ''; return; }
  const step = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find(s => d / s <= 14) || 14400;
  const major = step * (step >= 1800 ? 2 : step === 900 ? 4 : step === 120 ? 5 : step === 60 ? 5 : step === 30 ? 2 : step === 10 ? 3 : 2);
  let out = '';
  for (let t = step; t < d; t += step) out += `<i class="${t % major === 0 ? 'major' : ''}" style="left:${(t / d * 100).toFixed(3)}%"></i>`;
  host.innerHTML = out;
}
function renderLoop() {
  const c = S.cur, d = dur();
  const a = c && c.a, b = c && c.b;
  $('timeA').textContent = a != null ? fmt(a, true) : 'Set start';
  $('timeB').textContent = b != null ? fmt(b, true) : 'Set end';
  $('cellA').classList.toggle('set', a != null);
  $('cellB').classList.toggle('set', b != null);
  document.querySelectorAll('[data-nudge^="a"]').forEach(x => { x.disabled = a == null; });
  document.querySelectorAll('[data-nudge^="b"]').forEach(x => { x.disabled = b == null; });
  const both = a != null && b != null;
  const anySet = a != null || b != null;
  $('loopState').hidden = !anySet;
  if (anySet) {
    $('loopLabel').textContent = both ? (c.loopOn ? `Repeating ${fmt(b - a)}` : `Section ${fmt(b - a)}, repeat off`) : (a != null ? 'Now tap B at the end point' : 'Now tap A at the start point');
    const sw = $('loopToggle');
    sw.disabled = !both;
    sw.checked = !!(both && c.loopOn);
    sw.parentElement.style.visibility = both ? 'visible' : 'hidden';
  }
  const fa = $('flagA'), fb = $('flagB'), band = $('tlLoop');
  fa.hidden = !(a != null && d);
  fb.hidden = !(b != null && d);
  if (d && a != null) fa.style.left = a / d * 100 + '%';
  if (d && b != null) fb.style.left = b / d * 100 + '%';
  band.hidden = !(both && d);
  if (both && d) {
    band.style.left = a / d * 100 + '%';
    band.style.width = (b - a) / d * 100 + '%';
    band.style.opacity = c.loopOn ? 1 : 0.45;
  }
}
function renderSleep() {
  const on = S.sleepAt > 0;
  $('sleepBtn').classList.toggle('on', on);
  if (on) {
    const left = Math.max(0, S.sleepAt - Date.now()) / 1000;
    $('sleepLabel').textContent = fmt(left) + ' left';
  } else $('sleepLabel').textContent = 'Sleep timer';
}
function renderPlayer() {
  const c = S.cur;
  $('mini').hidden = !c;
  if (!c) return;
  $('pTitle').textContent = c.title;
  $('miniTitle').textContent = c.title;
  const e = $('pError');
  e.hidden = !S.loadErr;
  e.textContent = S.loadErr || '';
  $('repeatBtn').setAttribute('aria-pressed', String(!!S.settings.repeat));
  renderSpeed(); renderTicks(); renderLoop(); renderSleep(); renderPlayState(); renderTimes();
}
function openPlayer() {
  S.playerOpen = true;
  const p = $('player');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(frame);
  renderPlayer();
}
function closePlayer() {
  S.playerOpen = false;
  const p = $('player');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  renderList();
}

/* ---------- Render: library ---------- */
function rowMeta(t) {
  const parts = [];
  const d = t.duration;
  if (t.finished) parts.push('Finished');
  else if (t.position > 3 && d) parts.push(mins(d - t.position) + ' left');
  else if (!t.lastPlayedAt) parts.push('New');
  if (d) parts.push(fmt(d));
  return parts.join(', ');
}
function trackRow(t, extra = '') {
  const pct = t.finished ? 100 : t.duration ? clamp((t.position || 0) / t.duration * 100, 0, 100) : 0;
  return `<div class="row ${S.cur && S.cur.id === t.id ? 'current' : ''}" data-id="${t.id}">
    <button class="row-main" data-act="row-play" data-id="${t.id}">
      <span class="row-title" dir="auto">${esc(t.title)}</span>
      <span class="row-meta">${esc(rowMeta(t))}</span>
      ${pct > 0 ? `<span class="row-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}
    </button>
    <span class="row-acts">${extra}<button class="icon-btn" data-act="track-menu" data-id="${t.id}" aria-label="Options for ${esc(t.title)}"><svg class="i"><use href="#i-more"/></svg></button></span>
  </div>`;
}
function sortedTracks() {
  const q = S.query.trim().toLowerCase();
  const list = S.tracks.filter(t => !q || t.title.toLowerCase().includes(q) || (t.fileName || '').toLowerCase().includes(q));
  const by = {
    played: (a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || b.addedAt - a.addedAt,
    added: (a, b) => b.addedAt - a.addedAt,
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  }[S.settings.sort];
  return list.sort(by);
}
function emptyHTML() {
  return `<div class="empty"><h2>Add your first shiur</h2>
    <p>Audio stays on this phone. Nothing is uploaded anywhere.</p>
    <ol class="steps">
      <li><span>In WhatsApp, press and hold the audio message, tap <b>Forward</b>, then the <b>Share</b> icon at the bottom right.</span></li>
      <li><span>Choose <b>Save to Files</b> and tap <b>Save</b>.</span></li>
      <li><span>Come back here, tap <b>Add shiur</b>, then <b>Choose Files</b>. It starts playing right away.</span></li>
    </ol>
    <button class="wide-btn" data-act="add">Add shiur</button></div>`;
}
function renderList() {
  const list = $('list');
  const isPl = S.view === 'playlists', pl = S.playlistId && S.playlists.find(p => p.id === S.playlistId);
  $('segAll').setAttribute('aria-selected', String(!isPl));
  $('segPl').setAttribute('aria-selected', String(isPl));
  $('filters').hidden = isPl;
  document.querySelector('.seg').hidden = !!pl;
  $('libTitle').textContent = pl ? pl.name : isPl ? 'Playlists' : 'Shiurim';
  $('libTitle').dir = 'auto';
  if (pl) {
    const items = pl.trackIds.map(id => S.tracks.find(t => t.id === id)).filter(Boolean);
    list.innerHTML = `<button class="back-row" data-act="pl-back"><svg class="i"><use href="#i-left"/></svg>Playlists</button>
      <div class="pl-actions"><button class="wide-btn" data-act="pl-play" ${items.length ? '' : 'disabled'}>Play all</button><button class="wide-btn sec" data-act="pl-add">Add shiurim</button></div>
      ${items.map((t, i) => trackRow(t, `<button class="icon-btn" data-act="pl-up" data-id="${t.id}" aria-label="Move up" ${i ? '' : 'disabled'}><svg class="i"><use href="#i-up"/></svg></button>`)).join('') || '<div class="empty"><p>This playlist is empty. Tap Add shiurim to fill it.</p></div>'}
      <div class="pl-actions" style="margin-top:16px"><button class="wide-btn sec" data-act="pl-rename">Rename</button><button class="wide-btn danger" data-act="pl-delete">Delete playlist</button></div>`;
    return;
  }
  if (isPl) {
    list.innerHTML = `<div style="margin:6px 0 8px"><button class="wide-btn sec" data-act="pl-new">New playlist</button></div>` +
      (S.playlists.map(p => {
        const ts = p.trackIds.map(id => S.tracks.find(t => t.id === id)).filter(Boolean);
        const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
        return `<div class="row"><button class="row-main" data-act="pl-open" data-id="${p.id}"><span class="row-title" dir="auto">${esc(p.name)}</span><span class="row-meta">${ts.length} ${ts.length === 1 ? 'shiur' : 'shiurim'}${total ? ', ' + mins(total) : ''}</span></button></div>`;
      }).join('') || '<div class="empty"><p>Use playlists to keep a series together. When one shiur ends, the next starts.</p></div>');
    return;
  }
  if (!S.tracks.length) { list.innerHTML = emptyHTML(); $('filters').hidden = true; return; }
  const items = sortedTracks();
  list.innerHTML = items.map(t => trackRow(t)).join('') || `<div class="empty"><p>No shiur matches “${esc(S.query)}”.</p></div>`;
}

/* ---------- Sheets ---------- */
let sheetClose = null;
function openSheet(html, { top = false, onClose } = {}) {
  const sh = $('sheet');
  sh.innerHTML = html;
  sh.className = 'sheet' + (top ? ' top' : '');
  sh.hidden = false;
  $('scrim').hidden = false;
  sheetClose = onClose || null;
  return sh;
}
function closeSheet() {
  $('sheet').hidden = true;
  $('scrim').hidden = true;
  $('sheet').innerHTML = '';
  const f = sheetClose;
  sheetClose = null;
  if (f) f();
}
function askText(title, value, placeholder, action) {
  return new Promise(res => {
    const sh = openSheet(`<form id="askForm"><h2>${esc(title)}</h2>
      <input id="askInput" class="sheet-input" dir="auto" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="stack"><button class="wide-btn" type="submit">${esc(action)}</button><button class="wide-btn sec" type="button" data-act="sheet-close">Cancel</button></div></form>`, { top: true, onClose: () => res(null) });
    const inp = $('askInput');
    sh.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const v = inp.value.trim();
      sheetClose = null;
      closeSheet();
      res(v || null);
    });
    inp.focus();
    inp.select();
  });
}
function askConfirm(title, body, action) {
  return new Promise(res => {
    const sh = openSheet(`<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="stack"><button class="wide-btn danger" id="askYes">${esc(action)}</button><button class="wide-btn sec" data-act="sheet-close">Cancel</button></div>`, { onClose: () => res(false) });
    sh.querySelector('#askYes').addEventListener('click', () => { sheetClose = null; closeSheet(); res(true); });
  });
}
function trackMenu(id) {
  const t = S.tracks.find(x => x.id === id);
  if (!t) return;
  const sizeMb = t.size ? (t.size / 1048576).toFixed(t.size > 1048576 * 100 ? 0 : 1) + ' MB' : '';
  const sh = openSheet(`<h2 dir="auto">${esc(t.title)}</h2><p>${esc([t.duration ? fmt(t.duration) : '', sizeMb].filter(Boolean).join(', '))}</p>
    <div class="stack">
      <button class="wide-btn sec" id="mStart">Play from the beginning</button>
      <button class="wide-btn sec" id="mRename">Rename</button>
      <button class="wide-btn sec" id="mPl">Add to playlist</button>
      ${S.playlistId ? '<button class="wide-btn sec" id="mRemove">Remove from this playlist</button>' : ''}
      <button class="wide-btn danger" id="mDel">Delete from this phone</button>
      <button class="wide-btn sec" data-act="sheet-close">Cancel</button>
    </div>`);
  sh.querySelector('#mStart').onclick = () => { closeSheet(); primeAudio.done = false; primeAudio(); loadTrack(id, { autoplay: true, fromStart: true }); openPlayer(); };
  sh.querySelector('#mRename').onclick = async () => {
    closeSheet();
    const v = await askText('Rename shiur', t.title, 'Title', 'Save');
    if (v) { t.title = v; await saveTrack(t); renderList(); renderPlayer(); updateMetadata(); }
  };
  sh.querySelector('#mPl').onclick = () => { closeSheet(); playlistPicker(t); };
  const rm = sh.querySelector('#mRemove');
  if (rm) rm.onclick = async () => {
    closeSheet();
    const pl = S.playlists.find(p => p.id === S.playlistId);
    pl.trackIds = pl.trackIds.filter(x => x !== id);
    await put('playlists', pl);
    renderList();
  };
  sh.querySelector('#mDel').onclick = async () => {
    closeSheet();
    if (await askConfirm('Delete this shiur?', `“${t.title}” and your place in it will be removed from this phone.`, 'Delete')) deleteTrack(id);
  };
}
async function deleteTrack(id) {
  if (S.cur && S.cur.id === id) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
    S.cur = null; S.wantPlay = false; S.pendingSeek = null; S.loadErr = null;
    S.settings.lastTrackId = null;
    saveSettings();
    closePlayer();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    $('mini').hidden = true;
  }
  S.tracks = S.tracks.filter(t => t.id !== id);
  for (const p of S.playlists) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); await put('playlists', p); }
  }
  await del('tracks', id);
  await del('blobs', id);
  lsDel('chz.pos.' + id);
  renderList();
  toast('Deleted');
}
function playlistPicker(t) {
  const sh = openSheet(`<h2>Add to playlist</h2>
    <ul class="plain">${S.playlists.map(p => `<li><label class="pick"><input type="checkbox" data-pl="${p.id}" ${p.trackIds.includes(t.id) ? 'checked' : ''}><span dir="auto">${esc(p.name)}</span></label></li>`).join('')}</ul>
    ${S.playlists.length ? '' : '<p>You have no playlists yet.</p>'}
    <div class="stack"><button class="wide-btn sec" id="plNew">New playlist</button><button class="wide-btn" data-act="sheet-close">Done</button></div>`);
  sh.querySelectorAll('[data-pl]').forEach(c => c.addEventListener('change', async () => {
    const p = S.playlists.find(x => x.id === c.dataset.pl);
    if (c.checked) { if (!p.trackIds.includes(t.id)) p.trackIds.push(t.id); } else p.trackIds = p.trackIds.filter(x => x !== t.id);
    await put('playlists', p);
    renderList();
  }));
  sh.querySelector('#plNew').onclick = async () => {
    closeSheet();
    const p = await newPlaylist();
    if (p) { p.trackIds.push(t.id); await put('playlists', p); renderList(); toast(`Added to ${p.name}`); }
  };
}
async function newPlaylist() {
  const name = await askText('New playlist', '', 'For example, Daf Yomi', 'Create');
  if (!name) return null;
  const p = { id: uid(), name, trackIds: [], createdAt: Date.now() };
  await put('playlists', p);
  S.playlists.push(p);
  renderList();
  return p;
}
function playlistAddSheet(pl) {
  const sh = openSheet(`<h2>Add shiurim</h2>
    <ul class="plain">${[...S.tracks].sort((a, b) => b.addedAt - a.addedAt).map(t => `<li><label class="pick"><input type="checkbox" data-t="${t.id}" ${pl.trackIds.includes(t.id) ? 'checked' : ''}><span dir="auto">${esc(t.title)}</span></label></li>`).join('')}</ul>
    ${S.tracks.length ? '' : '<p>Your library is empty. Add a shiur first.</p>'}
    <button class="wide-btn" data-act="sheet-close">Done</button>`);
  sh.querySelectorAll('[data-t]').forEach(c => c.addEventListener('change', async () => {
    if (c.checked) { if (!pl.trackIds.includes(c.dataset.t)) pl.trackIds.push(c.dataset.t); } else pl.trackIds = pl.trackIds.filter(x => x !== c.dataset.t);
    await put('playlists', pl);
    renderList();
  }));
}
function sleepSheet() {
  const left = S.sleepAt ? Math.ceil((S.sleepAt - Date.now()) / 60000) : 0;
  const sh = openSheet(`<h2>Sleep timer</h2><p>${S.sleepAt ? `Playback stops in about ${left} min.` : 'Playback stops after the time you choose.'}</p>
    <div class="grid-opts">${SLEEP.map(m => `<button class="opt" data-min="${m}">${m} min</button>`).join('')}</div>
    <div class="stack">${S.sleepAt ? '<button class="wide-btn sec" id="slOff">Turn off timer</button>' : ''}<button class="wide-btn sec" data-act="sheet-close">Cancel</button></div>`);
  sh.querySelectorAll('[data-min]').forEach(b => { b.onclick = () => { S.sleepAt = Date.now() + b.dataset.min * 60000; closeSheet(); renderSleep(); toast(`Stopping in ${b.dataset.min} minutes`); }; });
  const off = sh.querySelector('#slOff');
  if (off) off.onclick = () => { S.sleepAt = 0; closeSheet(); renderSleep(); toast('Sleep timer off'); };
}
const volumeWorks = (() => { const t = document.createElement('audio'); t.volume = 0.5; return Math.abs(t.volume - 0.5) < 0.01; })();
function volumeSheet() {
  const picker = !!audio.webkitShowPlaybackTargetPicker;
  const sh = openSheet(`<h2>Volume</h2>
    ${volumeWorks
      ? `<input id="volRange" class="vol-range" type="range" min="0" max="1" step="0.01" value="${audio.volume}" aria-label="Volume">`
      : `<p>iPhone only lets its side buttons change the volume of web apps, so there is no slider here. Use the side buttons, Control Center, or your AirPods.</p>`}
    <div class="stack">${picker ? '<button class="wide-btn sec" id="outBtn">Choose speaker or headphones</button>' : ''}<button class="wide-btn" data-act="sheet-close">Done</button></div>`);
  const r = sh.querySelector('#volRange');
  if (r) r.addEventListener('input', () => { audio.volume = +r.value; S.settings.volume = +r.value; saveSettings(); });
  const o = sh.querySelector('#outBtn');
  if (o) o.onclick = () => { try { audio.webkitShowPlaybackTargetPicker(); } catch (e) { toast('Choose the output in Control Center'); } };
}
function gotoSheet() {
  if (!S.cur) return;
  const sh = openSheet(`<form id="gotoForm"><h2>Go to time</h2><p>Type minutes and seconds, like 12:30 or 1:05:00.</p>
    <input id="gotoInput" class="sheet-input" inputmode="numbers-and-punctuation" value="${fmt(now())}" autocomplete="off" aria-label="Time">
    <div class="stack"><button class="wide-btn" type="submit">Go</button><button class="wide-btn sec" type="button" data-act="sheet-close">Cancel</button></div></form>`, { top: true });
  const i = sh.querySelector('#gotoInput');
  i.focus(); i.select();
  sh.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const parts = i.value.trim().split(/[:.]/).map(Number);
    if (!parts.length || parts.some(n => !isFinite(n) || n < 0) || parts.length > 3) { toast('Type a time like 12:30'); return; }
    const sec = parts.reduce((s, n) => s * 60 + n, 0);
    closeSheet();
    seekTo(sec);
  });
}
async function settingsSheet() {
  let used = '';
  try {
    const est = await navigator.storage.estimate();
    used = `${(est.usage / 1048576).toFixed(est.usage > 1048576 * 100 ? 0 : 1)} MB used on this device`;
  } catch (e) { /* optional */ }
  const th = S.settings.theme;
  const sh = openSheet(`<h2>Settings</h2>
    <div class="grid-opts">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="opt" data-theme-opt="${v}" aria-pressed="${th === v}">${l}</button>`).join('')}</div>
    <p>${S.tracks.length} ${S.tracks.length === 1 ? 'shiur' : 'shiurim'} saved${used ? '. ' + esc(used) : ''}.</p>
    <div class="help">
      <h3>Add audio from WhatsApp</h3>
      <ol><li>Press and hold the audio in WhatsApp, tap Forward, then the Share icon.</li><li>Choose Save to Files.</li><li>In Chazara, tap Add shiur, then Choose Files.</li></ol>
      <h3>What an iPhone web app cannot do</h3>
      <ul><li>Apple does not let web apps appear in the iPhone share sheet, so WhatsApp cannot send straight to Chazara.</li><li>The volume slider is replaced by the iPhone side buttons.</li><li>Deleting Chazara from your Home Screen deletes its saved audio.</li></ul>
    </div>
    <button class="wide-btn sec" data-act="sheet-close">Done</button>`);
  sh.querySelectorAll('[data-theme-opt]').forEach(b => {
    b.onclick = () => {
      S.settings.theme = b.dataset.themeOpt;
      saveSettings(); applyTheme();
      sh.querySelectorAll('[data-theme-opt]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
}
function installSheet() {
  openSheet(`<h2>Add to Home Screen</h2>
    <div class="help"><ol>
      <li>Open this page in Safari.</li>
      <li>Tap the Share icon at the bottom of the screen.</li>
      <li>Scroll down and tap Add to Home Screen, then Add.</li>
      <li>Open Chazara from your Home Screen and add your shiurim there.</li>
    </ol></div>
    <button class="wide-btn" data-act="sheet-close">Done</button>`);
}

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').hidden = true; }

/* ---------- Theme ---------- */
function applyTheme() {
  const v = S.settings.theme;
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('themeColor').setAttribute('content', bg || '#ffffff');
}
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch (e) { /* older browsers */ }

/* ---------- Timeline gestures ---------- */
function fineFactor(dy) {
  const a = Math.abs(dy);
  if (a < 56) return [1, ''];
  if (a < 116) return [0.5, 'Half-speed scrubbing'];
  if (a < 176) return [0.25, 'Quarter-speed scrubbing'];
  return [0.1, 'Fine scrubbing'];
}
const HINT = 'Drag down while scrubbing for finer control';
function bindTimeline() {
  const tl = $('tl');
  tl.addEventListener('pointerdown', e => {
    if (!S.cur || !dur()) return;
    e.preventDefault();
    const flagEl = e.target.closest && e.target.closest('.flag');
    const rect = tl.getBoundingClientRect();
    const d = dur();
    const flag = flagEl ? flagEl.dataset.flag : null;
    const start = flag ? S.cur[flag] : clamp((e.clientX - rect.left) / rect.width * d, 0, d);
    S.scrub = { flag, value: start, lastX: e.clientX, startY: e.clientY, moved: false, pid: e.pointerId };
    tl.setPointerCapture(e.pointerId);
    tl.classList.add('scrubbing');
    if (!flag) renderTimes(start);
  });
  tl.addEventListener('pointermove', e => {
    const sc = S.scrub;
    if (!sc || sc.pid !== e.pointerId) return;
    const rect = tl.getBoundingClientRect();
    const d = dur();
    const [f, label] = fineFactor(e.clientY - sc.startY);
    sc.value = clamp(sc.value + (e.clientX - sc.lastX) / rect.width * d * f, 0, d);
    sc.lastX = e.clientX;
    sc.moved = true;
    $('scrubHint').textContent = label || (sc.flag ? `Moving ${sc.flag.toUpperCase()}` : HINT);
    if (sc.flag) {
      const c = S.cur, v = Math.round(sc.value * 10) / 10;
      const other = sc.flag === 'a' ? c.b : c.a;
      if (other == null) c[sc.flag] = v;
      else c[sc.flag] = sc.flag === 'a' ? Math.min(v, other - MIN_LOOP) : Math.max(v, other + MIN_LOOP);
      c[sc.flag] = clamp(c[sc.flag], 0, d);
      renderLoop();
    } else renderTimes(sc.value);
  });
  const end = e => {
    const sc = S.scrub;
    if (!sc || sc.pid !== e.pointerId) return;
    S.scrub = null;
    tl.classList.remove('scrubbing');
    $('scrubHint').textContent = HINT;
    if (sc.flag) {
      saveTrack(S.cur);
      if (S.cur.loopOn) { seekTo(sc.flag === 'a' ? S.cur.a : Math.max(S.cur.a, S.cur.b - 2), { user: false }); scheduleLoop(); }
    } else if (e.type !== 'pointercancel') seekTo(sc.value);
    else renderTimes();
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);
  tl.addEventListener('keydown', e => {
    const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -15, ArrowUp: 15 }[e.key];
    if (step) { e.preventDefault(); seekTo(now() + step); }
  });
}

/* ---------- Events ---------- */
function pickFiles() { const p = $('filePicker'); p.value = ''; p.click(); }
const actions = {
  add: pickFiles,
  settings: settingsSheet,
  toggle,
  'open-player': openPlayer,
  'close-player': closePlayer,
  'sheet-close': closeSheet,
  'view-all': () => { S.view = 'all'; S.playlistId = null; renderList(); },
  'view-playlists': () => { S.view = 'playlists'; S.playlistId = null; renderList(); },
  'speed-down': () => setSpeed(SPEEDS[Math.max(0, speedIdx(S.settings.speed) - 1)]),
  'speed-up': () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, speedIdx(S.settings.speed) + 1)]),
  'set-a': () => setPoint('a'),
  'set-b': () => setPoint('b'),
  'clear-loop': clearLoop,
  repeat: () => { S.settings.repeat = !S.settings.repeat; saveSettings(); $('repeatBtn').setAttribute('aria-pressed', String(S.settings.repeat)); toast(S.settings.repeat ? 'This shiur will repeat' : 'Repeat is off'); },
  sleep: sleepSheet,
  volume: volumeSheet,
  goto: gotoSheet,
  'track-menu-current': () => S.cur && trackMenu(S.cur.id),
  'install-help': installSheet,
  'install-dismiss': () => { lsSet('chz.installTip', '1'); $('installTip').hidden = true; },
  'pl-new': newPlaylist,
  'pl-back': () => { S.playlistId = null; renderList(); },
};
const idActions = {
  'row-play': id => {
    if (S.cur && S.cur.id === id) { openPlayer(); if (audio.paused) play(); return; }
    loadTrack(id, { autoplay: true, queue: S.playlistId || null });
    openPlayer();
  },
  'track-menu': id => trackMenu(id),
  'pl-open': id => { S.playlistId = id; renderList(); window.scrollTo(0, 0); },
  'pl-up': async id => {
    const p = S.playlists.find(x => x.id === S.playlistId), i = p.trackIds.indexOf(id);
    if (i > 0) { [p.trackIds[i - 1], p.trackIds[i]] = [p.trackIds[i], p.trackIds[i - 1]]; await put('playlists', p); renderList(); }
  },
};
const plActions = {
  'pl-play': p => { const first = p.trackIds.find(id => S.tracks.some(t => t.id === id)); if (first) { loadTrack(first, { autoplay: true, queue: p.id }); openPlayer(); } },
  'pl-add': p => playlistAddSheet(p),
  'pl-rename': async p => { const v = await askText('Rename playlist', p.name, 'Name', 'Save'); if (v) { p.name = v; await put('playlists', p); renderList(); } },
  'pl-delete': async p => {
    if (await askConfirm('Delete this playlist?', 'The shiurim stay in your library.', 'Delete')) {
      S.playlists = S.playlists.filter(x => x.id !== p.id);
      await del('playlists', p.id);
      if (S.queue === p.id) S.queue = null;
      S.playlistId = null;
      renderList();
    }
  },
};
let holdFired = false;
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act],[data-skip],[data-nudge],[data-speed]');
  primeIfSafe(e);
  if (!el) return;
  if (el.dataset.skip) { seekTo(now() + +el.dataset.skip); return; }
  if (el.dataset.nudge) {
    if (holdFired) { holdFired = false; return; }
    const [w, v] = el.dataset.nudge.split(':');
    nudge(w, +v);
    return;
  }
  if (el.dataset.speed) { setSpeed(+el.dataset.speed); return; }
  const a = el.dataset.act;
  if (a === 'toggle') e.stopPropagation();
  if (actions[a]) return void actions[a]();
  if (idActions[a]) return void idActions[a](el.dataset.id);
  if (plActions[a]) {
    const p = S.playlists.find(x => x.id === S.playlistId);
    if (p) plActions[a](p);
  }
});
function primeIfSafe(e) {
  /* Skip priming when this tap itself is about to play. */
  const el = e.target.closest('[data-act]');
  const a = el && el.dataset.act;
  if (a === 'toggle') { primeAudio.done = true; return; }
  /* These tap handlers wait on storage before playing, so unlock during the tap itself. */
  if (a === 'row-play' || a === 'pl-play' || a === 'add') primeAudio.done = false;
  primeAudio();
}
/* Hold a nudge button to keep moving the point. */
let holdT = 0, holdI = 0;
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('[data-nudge]');
  if (!b || b.disabled) return;
  holdFired = false;
  const [w, v] = b.dataset.nudge.split(':');
  holdT = setTimeout(() => { holdFired = true; nudge(w, +v); holdI = setInterval(() => nudge(w, +v), 140); }, 420);
});
const stopHold = () => { clearTimeout(holdT); clearInterval(holdI); };
['pointerup', 'pointercancel', 'pointerleave'].forEach(n => document.addEventListener(n, stopHold));

bindTimeline();
$('scrim').addEventListener('click', closeSheet);
$('filePicker').addEventListener('change', e => { const f = e.target.files; importFiles(f); });
$('search').addEventListener('input', e => { S.query = e.target.value; renderList(); });
$('sort').addEventListener('change', e => { S.settings.sort = e.target.value; saveSettings(); renderList(); });
$('speedRange').addEventListener('input', e => setSpeed(SPEEDS[+e.target.value]));
$('loopToggle').addEventListener('change', e => {
  const c = S.cur;
  if (!c) return;
  c.loopOn = e.target.checked;
  saveTrack(c);
  if (c.loopOn && (now() < c.a || now() > c.b)) seekTo(c.a, { user: false });
  scheduleLoop();
  renderLoop();
});
$('chips').innerHTML = CHIPS.map(v => `<button data-speed="${v}" aria-pressed="false" aria-label="${v} times speed">${v}</button>`).join('');

/* Swipe down on the player's top bar to close it. */
(() => {
  const top = $('pTop');
  let y0 = null;
  top.addEventListener('pointerdown', e => { y0 = e.clientY; });
  top.addEventListener('pointerup', e => { if (y0 != null && e.clientY - y0 > 40) closePlayer(); y0 = null; });
  top.addEventListener('touchend', e => { const t = e.changedTouches[0]; if (y0 != null && t && t.clientY - y0 > 40) { closePlayer(); y0 = null; } });
})();

/* Desktop drag and drop */
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('drop').hidden = true; primeAudio.done = false; primeAudio(); importFiles(e.dataTransfer.files); });

/* Keyboard on a computer */
window.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.key === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) savePosition(true);
  else { renderPlayer(); if (S.playerOpen) requestAnimationFrame(frame); }
});
window.addEventListener('pagehide', () => savePosition(true));

/* ---------- Boot ---------- */
async function boot() {
  applyPitch();
  try {
    const [tracks, playlists, settings] = await Promise.all([all('tracks'), all('playlists'), get('kv', 'settings')]);
    S.tracks = tracks;
    S.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
    if (settings) Object.assign(S.settings, settings);
    try { Object.assign(S.settings, JSON.parse(lsGet('chz.settings') || '{}')); } catch (e) { /* ignore a bad record */ }
    for (const t of S.tracks) {
      const raw = lsGet('chz.pos.' + t.id);
      if (raw) {
        try {
          const v = JSON.parse(raw);
          if (v.at > (t.updatedAt || 0)) { t.position = v.p; t.updatedAt = v.at; saveTrack(t); }
        } catch (e) { /* ignore a bad record */ }
      }
    }
  } catch (e) {
    toast('This browser is blocking saved data. Audio will not be remembered. Private Browsing is a common cause.', 8000);
  }
  applyTheme();
  $('sort').value = S.settings.sort;
  if (volumeWorks) audio.volume = S.settings.volume;
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (IS_IOS && !standalone && !lsGet('chz.installTip')) $('installTip').hidden = false;
  renderList();
  renderSpeed();
  const last = S.settings.lastTrackId;
  if (last && S.tracks.some(t => t.id === last)) {
    S.queue = S.settings.lastQueue || null;
    await loadTrack(last, { autoplay: false });
    if (S.cur) openPlayer();
  }
  if (S.tracks.length) requestPersistence();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }
}
window.__chazara = { S, audio };
boot();
