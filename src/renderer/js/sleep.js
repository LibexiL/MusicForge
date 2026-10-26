// Sleep timer: pause after N minutes (with a short fade) or at the end of the current song.
import { engine } from './player/engine.js';
import { state, emit, on } from './state.js';

export const sleep = { mode: null, until: 0 };
let timer = null;
let fadeTimer = null;

function clearTimers() { clearTimeout(timer); clearInterval(fadeTimer); timer = null; fadeTimer = null; }

export function setSleep(m) {
  clearTimers();
  sleep.mode = null;
  engine.stopAfterTrack = false;
  if (m === 'track') {
    sleep.mode = 'track';
    engine.stopAfterTrack = true;
  } else if (typeof m === 'number' && m > 0) {
    sleep.mode = 'time';
    sleep.until = Date.now() + m * 60000;
    timer = setTimeout(fadeOut, Math.max(0, m * 60000 - 8000));
  }
  emit('sleep', sleep);
}

function fadeOut() {
  const base = state.settings.muted ? 0 : state.settings.volume;
  let step = 0;
  fadeTimer = setInterval(() => {
    step++;
    engine.cur?.setVolume(base * Math.max(0, 1 - step / 16));
    if (step >= 16) {
      clearInterval(fadeTimer);
      engine.pause();
      setTimeout(() => engine.cur?.setVolume(base), 600);
      sleep.mode = null;
      emit('sleep', sleep);
      emit('toast', { text: 'Sleep timer: paused. Good night.' });
    }
  }, 500);
}

on('stopped-after-track', () => {
  sleep.mode = null;
  emit('sleep', sleep);
  emit('toast', { text: 'Sleep timer: stopped after that song.' });
});
