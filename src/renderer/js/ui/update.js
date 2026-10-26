// Update status: a title-bar button when an update is ready (or, for the portable build, available),
// plus a one-time toast. Settings → About has the full controls.
import { mf, emit } from '../state.js';
import { icon } from '../util.js';
import { toast } from './components.js';

export const update = { status: null };
const pill = document.getElementById('update-pill');
let toasted = null;

function paint(s) {
  update.status = s;
  emit('update', s);
  const ready = s.state === 'ready';
  const available = s.state === 'available';
  pill.hidden = !(ready || available);
  if (ready) {
    pill.replaceChildren(icon('refresh', 14), `Restart to update to ${s.version}`);
    pill.title = 'Installs the update and reopens MusicForge';
  } else if (available) {
    pill.replaceChildren(icon('import', 14), `Update ${s.version} available`);
    pill.title = 'Opens the download page';
  }
  if ((ready || available) && toasted !== s.version) {
    toasted = s.version;
    toast(ready ? `MusicForge ${s.version} is ready. Restart from the button at the top whenever you like.` : `MusicForge ${s.version} is out. Use the button at the top to download it.`);
  }
}

pill.addEventListener('click', () => mf.invoke('update:install'));
mf.on('update:status', paint);
mf.invoke('update:status').then(paint).catch(() => {});

export const checkForUpdates = () => mf.invoke('update:check');
