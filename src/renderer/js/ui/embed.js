// The YouTube / SoundCloud players live in one fixed layer that is moved over a "slot"
// element in the current view (Now Playing, Video) or docked bottom-right. Moving an
// iframe in the DOM would reload it, so we only ever move this layer.
const host = document.getElementById('embed-host');
let kind = null; // 'youtube' | 'soundcloud' | null
let slot = null;
let ro = null;
let onExpand = null;

export function setEmbed(next, label = '') {
  kind = next;
  host.dataset.kind = next || '';
  document.getElementById('embed-label').textContent = label;
  layout();
}

export function embedKind() { return kind; }
export function onEmbedExpand(fn) { onExpand = fn; }
document.getElementById('embed-expand').addEventListener('click', () => onExpand?.());

// Called by a view that has a place for the player; pass null when the view goes away.
export function attachSlot(el) {
  slot = el;
  ro?.disconnect();
  if (el) {
    ro = new ResizeObserver(layout);
    ro.observe(el);
  }
  layout();
}

export function layout() {
  if (!kind) { host.dataset.mode = 'off'; return; }
  const stageable = slot && slot.isConnected && (kind === 'youtube' || slot.dataset.embedAny !== undefined);
  if (stageable) {
    const r = slot.getBoundingClientRect();
    host.dataset.mode = 'stage';
    Object.assign(host.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    slot.classList.add('has-embed');
  } else {
    host.dataset.mode = 'dock';
    host.style.left = host.style.top = host.style.width = host.style.height = '';
  }
}

window.addEventListener('resize', layout);
document.getElementById('main').addEventListener('scroll', layout, { passive: true });
