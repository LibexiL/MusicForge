// Local music library: incremental folder scan (only new/changed files are parsed),
// index persisted to library.json, covers and embedded lyrics read on demand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';

const EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.mp4', '.ogg', '.oga', '.opus', '.wav', '.webm']);
const idFor = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

function lyricsText(common) {
  const l = common.lyrics;
  if (!l || !l.length) return null;
  const first = l[0];
  if (typeof first === 'string') return first;
  if (first.syncText?.length) {
    // Synchronised (SYLT) lyrics → LRC
    return first.syncText.map((s) => {
      const t = (s.timestamp || 0) / 1000;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      return `[${mm}:${ss}]${s.text}`;
    }).join('\n');
  }
  return first.text || null;
}

export class Library {
  constructor(dir, emit) {
    this.file = path.join(dir, 'library.json');
    this.emit = emit;
    this.scanning = false;
    this.covers = new Map();
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { folders: [], tracks: [] };
    }
    this.reindex();
  }

  reindex() { this.byId = new Map(this.data.tracks.map((t) => [t.id, t])); }
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  folders() { return this.data.folders; }
  tracks() { return this.data.tracks; }
  pathFor(id) { return this.byId.get(id)?.path || null; }

  addFolder(dir) {
    const norm = path.resolve(dir);
    if (!this.data.folders.includes(norm)) this.data.folders.push(norm);
    this.save();
    return this.data.folders;
  }

  removeFolder(dir) {
    this.data.folders = this.data.folders.filter((f) => f !== dir);
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    this.data.tracks = this.data.tracks.filter((t) => !t.path.startsWith(prefix));
    this.reindex();
    this.save();
    return this.data.folders;
  }

  async walk(root, out) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
      }
    }
  }

  async scan() {
    if (this.scanning) return { busy: true };
    this.scanning = true;
    const started = Date.now();
    try {
      const files = [];
      for (const f of this.data.folders) await this.walk(f, files);
      const old = new Map(this.data.tracks.map((t) => [t.path, t]));
      const next = new Array(files.length);
      let done = 0;
      let parsed = 0;
      let cursor = 0;
      const worker = async () => {
        while (cursor < files.length) {
          const i = cursor++;
          const file = files[i];
          let st;
          try { st = await fs.promises.stat(file); } catch { done++; continue; }
          const prev = old.get(file);
          if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
            next[i] = prev;
          } else {
            next[i] = await this.parse(file, st);
            parsed++;
          }
          done++;
          if (done % 100 === 0) this.emit('library:progress', { done, total: files.length });
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      this.data.tracks = next.filter(Boolean);
      this.reindex();
      this.save();
      this.covers.clear();
      const result = { total: this.data.tracks.length, parsed, ms: Date.now() - started };
      this.emit('library:progress', { done: files.length, total: files.length, finished: true, ...result });
      return result;
    } finally {
      this.scanning = false;
    }
  }

  async parse(file, st) {
    const base = path.basename(file, path.extname(file));
    const t = {
      id: idFor(file), path: file, title: base, artist: '', album: '', albumArtist: '',
      duration: 0, no: 0, disc: 0, year: 0, genre: '', mtime: st.mtimeMs, size: st.size, cover: false, lyrics: false,
    };
    try {
      const { common, format } = await parseFile(file, { duration: false, skipCovers: false });
      t.title = common.title || base;
      t.artist = common.artist || common.artists?.join(', ') || '';
      t.album = common.album || '';
      t.albumArtist = common.albumartist || '';
      t.duration = Math.round(format.duration || 0);
      t.no = common.track?.no || 0;
      t.disc = common.disk?.no || 0;
      t.year = common.year || 0;
      t.genre = common.genre?.[0] || '';
      t.cover = !!common.picture?.length;
      t.lyrics = !!lyricsText(common);
    } catch { /* unreadable tags: keep the filename */ }
    if (!t.artist) {
      // "Artist - Title.mp3" fallback
      const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
      if (m) { t.artist = m[1]; if (t.title === base) t.title = m[2]; }
    }
    return t;
  }

  async cover(id) {
    if (this.covers.has(id)) return this.covers.get(id);
    const file = this.pathFor(id);
    if (!file) return null;
    let out = null;
    try {
      const { common } = await parseFile(file, { duration: false });
      const pic = common.picture?.find((p) => /front/i.test(p.type || '')) || common.picture?.[0];
      if (pic) out = { data: Buffer.from(pic.data), format: pic.format };
    } catch { /* none */ }
    if (!out) {
      // folder.jpg / cover.png next to the file
      const dir = path.dirname(file);
      for (const name of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'Cover.jpg', 'Folder.jpg']) {
        try { out = { data: await fs.promises.readFile(path.join(dir, name)), format: name.endsWith('png') ? 'image/png' : 'image/jpeg' }; break; } catch { /* next */ }
      }
    }
    if (this.covers.size > 150) this.covers.delete(this.covers.keys().next().value);
    this.covers.set(id, out);
    return out;
  }

  async lyrics(id) {
    const file = this.pathFor(id);
    if (!file) return null;
    // Sidecar .lrc wins (usually synced), then embedded tags.
    try { return await fs.promises.readFile(file.replace(/\.[^.]+$/, '.lrc'), 'utf8'); } catch { /* none */ }
    try {
      const { common } = await parseFile(file, { duration: false, skipCovers: true });
      return lyricsText(common);
    } catch { return null; }
  }
}
