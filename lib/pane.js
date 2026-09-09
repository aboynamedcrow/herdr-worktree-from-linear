import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// herdr only splits `right` or `down`. Left/top are a right/down split followed by a
// `herdr pane swap --direction left|up`. `overlay` is a full-screen zoomed pane.
// `popup` is a centered floating window sized by --width/--height (needs herdr >= 0.7.4).
//
// `targeted` says whether herdr accepts an explicit `--target-pane` for the
// placement. Verified against installed herdr 0.9.0: an overlay or popup plugin
// pane covers whichever pane is active, and naming one is refused outright —
// `invalid_params: overlay and popup plugin panes target the active pane`, with
// no pane created. The protocol-22 schema carries target_pane_id as a top-level
// field, which reads as placement-independent; the server disagrees, and the
// server decides. Splits accept it, so that is where it is sent.
const PLACEMENTS = {
  overlay: { placement: 'overlay' },
  popup: { placement: 'popup', sized: true },
  right: { placement: 'split', direction: 'right', targeted: true },
  left: { placement: 'split', direction: 'right', swap: 'left', targeted: true },
  down: { placement: 'split', direction: 'down', targeted: true },
  top: { placement: 'split', direction: 'down', swap: 'up', targeted: true },
};
const DEFAULT_PLACEMENT = 'right';
const DEFAULT_POPUP = { width: '80%', height: '70%' };

export function normalizePlacement(placement) {
  return Object.prototype.hasOwnProperty.call(PLACEMENTS, placement) ? placement : DEFAULT_PLACEMENT;
}

export function openPickerArgs(pluginId = 'tdi.worktree-from-linear', cwd, placement = DEFAULT_PLACEMENT, { width = DEFAULT_POPUP.width, height = DEFAULT_POPUP.height, targetPane } = {}) {
  const spec = PLACEMENTS[normalizePlacement(placement)];
  const args = ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', 'picker', '--placement', spec.placement];
  if (spec.direction) args.push('--direction', spec.direction);
  if (spec.sized) args.push('--width', width, '--height', height);
  // Only where the placement honors it: asking for a target pane an overlay or
  // popup cannot take fails the whole open, which is worse than letting native
  // place it. The invoking pane is still proved in lib/open.js either way.
  if (targetPane && spec.targeted) args.push('--target-pane', targetPane);
  args.push('--focus');
  // Pass the invoking repo as HERDR_WFP_CWD (resolveRepo prefers it over the pane's
  // own context JSON). Do NOT set --cwd: the pane command `node bin/picker.js` is
  // relative to the plugin root, so --cwd would break command resolution.
  if (typeof cwd === 'string' && cwd) args.push('--env', `HERDR_WFP_CWD=${cwd}`);
  return args;
}

// The `herdr pane swap` direction to apply after opening, or null when none is needed.
export function swapDirectionFor(placement) {
  return PLACEMENTS[normalizePlacement(placement)].swap || null;
}

// Extract the opened pane id from `herdr plugin pane open --json` stdout.
export function parsePaneId(stdout) {
  try {
    const d = JSON.parse(stdout);
    return d?.result?.plugin_pane?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

// Read the `placement` option from the plugin config, tolerant of a missing/invalid
// file (open.js must not require linearApiKey just to position the pane).
export function readPlacement(configDir) {
  if (!configDir) return DEFAULT_PLACEMENT;
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    return normalizePlacement(cfg.placement);
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

// A herdr PopupSize is an integer cell count (1-65535) or a "N%" string (1-100%).
// Returns the value as a string herdr accepts, or null when invalid.
function validSize(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535) return String(v);
  if (typeof v === 'string') {
    if (/^(100|[1-9][0-9]?)%$/.test(v)) return v;
    if (/^[1-9][0-9]{0,4}$/.test(v) && Number(v) <= 65535) return v;
  }
  return null;
}

// Popup width/height from config.json (popupWidth/popupHeight), each falling back
// to the default when absent or invalid. Only consulted for placement = "popup".
export function readPopupSize(configDir) {
  if (!configDir) return { ...DEFAULT_POPUP };
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    return {
      width: validSize(cfg.popupWidth) || DEFAULT_POPUP.width,
      height: validSize(cfg.popupHeight) || DEFAULT_POPUP.height,
    };
  } catch {
    return { ...DEFAULT_POPUP };
  }
}
