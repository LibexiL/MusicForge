// Small, dependency-free persistence: debounced atomic JSON writes + encrypted secrets.
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Boot options are read before the app is ready (GPU, window frame), so they live in their own tiny file.
export function readBoot(dir) {
  return readJson(path.join(dir, 'boot.json'), {});
}
export function writeBoot(dir, patch) {
  const next = { ...readBoot(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, 'boot.json'), JSON.stringify(next, null, 2));
  return next;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, {});
    this.timer = null;
  }
  all() { return this.data; }
  get(key) { return this.data[key]; }
  set(key, value) {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.data));
    } catch (err) {
      console.error('[store] write failed', err);
    }
  }
}

// Tokens, client IDs and API keys. Encrypted with the OS keychain (DPAPI on Windows,
// kwallet/libsecret on Linux) when available.
export class Secrets {
  constructor(dir) {
    this.file = path.join(dir, 'secrets.json');
    this.raw = readJson(this.file, {});
    this.cache = new Map();
  }
  get encrypted() {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  }
  get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const entry = this.raw[key];
    if (!entry) return undefined;
    let value;
    try {
      const text = entry.e
        ? safeStorage.decryptString(Buffer.from(entry.v, 'base64'))
        : Buffer.from(entry.v, 'base64').toString('utf8');
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    this.cache.set(key, value);
    return value;
  }
  set(key, value) {
    if (value === undefined || value === null) {
      delete this.raw[key];
      this.cache.delete(key);
    } else {
      const text = JSON.stringify(value);
      const enc = this.encrypted;
      const buf = enc ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
      this.raw[key] = { e: enc, v: buf.toString('base64') };
      this.cache.set(key, value);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.raw));
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      console.error('[secrets] write failed', err);
    }
  }
}
