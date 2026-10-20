const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let SendInput, INPUT_SIZE, GetAsyncKeyState, SetForegroundWindow, IsWindow, GetClassNameW;
let GetForegroundWindow, GetWindowThreadProcessId, OpenProcess, QueryFullProcessImageNameW, CloseHandle;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // SendInput + KEYEVENTF_UNICODE types any character regardless of the
    // keyboard layout (keybd_event + VkKeyScanA broke on AZERTY, AltGr, etc.).
    koffi.struct('MOUSEINPUT', {
      dx: 'long', dy: 'long', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
    });
    koffi.struct('KEYBDINPUT', {
      wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
    });
    koffi.struct('HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
    const INPUT = koffi.struct('INPUT', {
      type: 'uint32_t',
      u: koffi.union({ mi: 'MOUSEINPUT', ki: 'KEYBDINPUT', hi: 'HARDWAREINPUT' }),
    });
    INPUT_SIZE = koffi.sizeof(INPUT);
    SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)');
    GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
    SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hWnd)');
    IsWindow = user32.func('int __stdcall IsWindow(void *hWnd)');
    GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)');
    GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
    GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)');
    const kernel32 = koffi.load('kernel32.dll');
    OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
    QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)');
    CloseHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = null; // { refocus } when a spawn is waiting for the overlay to load

const SPAWN_SHORTCUT = 'Control+Alt+W';

// ── Persistent state (whip count + settings) ────────────────────────────────
const STATE_DEFAULTS = {
  whipCount: 0,
  daily: {},              // { 'YYYY-MM-DD': count }
  sendKeys: true,
  sound: true,
  interruptKey: 'escape', // 'escape' | 'ctrl-c' (Ctrl-C twice can quit Claude Code)
  terminalsOnly: true,    // only send keystrokes when a terminal is the front app
};
let state = { ...STATE_DEFAULTS };
let saveTimer = null;

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    state = { ...STATE_DEFAULTS, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('openwhip: could not read state:', e.message);
  }
}

function writeState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('openwhip: could not save state:', e.message);
  }
}

// Debounced so a flurry of cracks doesn't hammer the disk.
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeState, 500);
}

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── User config (hand-editable: messages + which apps count as terminals) ───
const CONFIG_DEFAULTS = {
  // Picked at random on each crack; repeat a line to make it more likely.
  messages: [
    'FASTER. Pick up exactly where you left off.',
    'Faster CLANKER. Resume the task and skip the explanations.',
    'GO FASTER. Keep going, less talking, more doing.',
    'Speed it up clanker. Batch the remaining edits and keep going.',
    'Work FASTER. Finish the current step before polishing anything.',
    'Stop overthinking. Pick the simplest approach and continue.',
    'Stop exploring, you have enough context. Make the change now.',
    'Keep going. Run independent commands in parallel.',
    "Continue, and don't re-read files you've already read.",
    "Resume. Keep updates to one line, no summaries until it's done.",
    "Continue. Don't ask me questions, use sensible defaults.",
    'Keep going. Skip the plan, just do the next step.',
    'Resume. Only run the tests that cover what you changed.',
    "Continue where you stopped. No refactors I didn't ask for.",
    'Back to work clanker. Same task, half the words.',
    'Pick up where you left off and stop second-guessing yourself.',
  ],
  // Case-insensitive substrings of the front app name (macOS), window class
  // (Linux) or .exe name (Windows). Add e.g. "code" or "cursor" to whip
  // Claude Code inside an editor's terminal.
  terminalApps: [
    'terminal', 'iterm', 'warp', 'ghostty', 'kitty', 'alacritty', 'wezterm',
    'hyper', 'tabby', 'konsole', 'tilix', 'terminator', 'xterm', 'urxvt',
    'cmd.exe', 'powershell', 'pwsh', 'conhost', 'openconsole', 'mintty', 'wsl',
    // Not a terminal, but its chat box takes typed prompts just the same.
    'lm studio',
  ],
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function ensureConfigFile() {
  if (fs.existsSync(configPath())) return;
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(CONFIG_DEFAULTS, null, 2));
}

// Re-read on every use so edits apply without a restart.
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const strings = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
    const messages = strings(c.messages);
    return {
      messages: messages.length ? messages : CONFIG_DEFAULTS.messages,
      terminalApps: Array.isArray(c.terminalApps) ? strings(c.terminalApps) : CONFIG_DEFAULTS.terminalApps,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('openwhip: bad config.json, using defaults:', e.message);
    return CONFIG_DEFAULTS;
  }
}

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const VK_ESCAPE  = 0x1B;
const VK_SHIFT   = 0x10;
const VK_LWIN    = 0x5B;
const VK_RWIN    = 0x5C;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const KEYUP      = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const INPUT_KEYBOARD = 1;

// ── Win32 input helpers ─────────────────────────────────────────────────────
const keyInput = (vk, up = false) => ({
  type: INPUT_KEYBOARD,
  u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYUP : 0, time: 0, dwExtraInfo: 0 } },
});
const tapInputs = vk => [keyInput(vk), keyInput(vk, true)];

// One down/up pair per UTF-16 code unit, so emoji (surrogate pairs) work too.
function unicodeInputs(text) {
  const inputs = [];
  for (let i = 0; i < text.length; i++) {
    const scan = text.charCodeAt(i);
    for (const up of [false, true]) {
      inputs.push({
        type: INPUT_KEYBOARD,
        u: { ki: { wVk: 0, wScan: scan, dwFlags: KEYEVENTF_UNICODE | (up ? KEYUP : 0), time: 0, dwExtraInfo: 0 } },
      });
    }
  }
  return inputs;
}

/** Returns false if Windows dropped the input (UIPI: the target runs as admin). */
function sendInputs(inputs) {
  if (!inputs.length) return true;
  return SendInput(inputs.length, inputs, INPUT_SIZE) === inputs.length;
}

// Ctrl+Alt+W (or a Ctrl-click) can leave modifiers held, which would turn the
// typed message into a string of shortcuts. Release them first.
function releaseHeldModifiers() {
  return [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
    .filter(vk => GetAsyncKeyState(vk) & 0x8000)
    .map(vk => keyInput(vk, true));
}

function windowClass(hwnd) {
  const buf = new Uint16Array(256);
  const len = GetClassNameW(hwnd, buf, buf.length);
  return len > 0 ? String.fromCharCode(...buf.subarray(0, len)) : '';
}

// The taskbar / tray flyouts take focus when the tray icon is clicked; they
// are never the window we want to go back to.
const SHELL_CLASSES = new Set([
  'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland', 'Windows.UI.Core.CoreWindow',
]);
let lastExternalWindow = null;

// Remember the last foreground window that isn't ours or the shell's, so a
// tray click can hand focus straight back to it instead of guessing via Alt+Tab.
function trackForegroundWindow() {
  if (!GetForegroundWindow) return;
  setInterval(() => {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return;
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      if (pid[0] === process.pid || SHELL_CLASSES.has(windowClass(hwnd))) return;
      lastExternalWindow = hwnd;
    } catch (e) {
      // Polling is best-effort; refocus falls back to Alt+Tab.
    }
  }, 250);
}

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!SendInput) return;
      if (lastExternalWindow && IsWindow(lastExternalWindow) && SetForegroundWindow(lastExternalWindow)) return;
      sendInputs([keyInput(VK_MENU), ...tapInputs(VK_TAB), keyInput(VK_MENU, true)]);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('openwhip: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

// macOS: a monochrome template image (alpha only) that the menu bar tints for
// light/dark mode. createFromPath picks up trayTemplate@2x.png on Retina.
function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(iconDir, 'trayTemplate.png'));
    if (!img.isEmpty()) {
      img.setTemplateImage(true);
      return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Terminals often live in full-screen spaces on macOS; follow them there.
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    sendSettings();
    if (spawnQueued && overlay && overlay.isVisible()) {
      const { refocus } = spawnQueued;
      spawnQueued = null;
      spawnWhip(refocus);
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = null;
  });
}

/** Move the overlay onto whichever display the cursor is on. */
function fitOverlayToCursorDisplay() {
  const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlay.setBounds(bounds);
  // Windows: moving between monitors with different scaling applies the old
  // DPI to the new size on the first call; the second call lands correctly.
  if (process.platform === 'win32') overlay.setBounds(bounds);
}

function spawnWhip(refocus) {
  const cursor = screen.getCursorScreenPoint();
  const bounds = overlay.getBounds();
  overlay.webContents.send('spawn-whip', { x: cursor.x - bounds.x, y: cursor.y - bounds.y });
  if (refocus) refocusPreviousApp();
}

// refocus: tray clicks steal focus from the terminal; the global shortcut does not.
function toggleOverlay({ refocus = true } = {}) {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  if (!overlay) createOverlay();
  fitOverlayToCursorDisplay();
  overlay.show();
  if (overlayReady) {
    spawnWhip(refocus);
  } else {
    spawnQueued = { refocus };
  }
}

function sendSettings() {
  if (overlay && overlayReady) overlay.webContents.send('settings', { sound: state.sound });
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  state.whipCount++;
  state.daily[todayKey()] = (state.daily[todayKey()] || 0) + 1;
  saveState();
  updateTray();
  if (!state.sendKeys) return;
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Macro: interrupt, type a message, Enter ──────────────────────────────────
let macroBusy = false;

function sendMacro() {
  // A crack mid-macro would double-tap the interrupt, which Claude Code
  // treats as "rewind" (Esc Esc) or "exit" (Ctrl-C Ctrl-C).
  if (macroBusy) return;
  const send = { win32: sendMacroWindows, darwin: sendMacroMac, linux: sendMacroLinux }[process.platform];
  if (!send) return;

  const config = loadConfig();
  const text = config.messages[Math.floor(Math.random() * config.messages.length)];
  const interrupt = state.interruptKey === 'ctrl-c' ? 'ctrl-c' : 'escape';

  macroBusy = true;
  const done = () => { macroBusy = false; };

  if (!state.terminalsOnly) return send(text, interrupt, done);
  getFrontApp(name => {
    if (!name) {
      console.warn('openwhip: could not detect front app; not sending keys (turn off "Only whip terminals" to force)');
      return done();
    }
    const lower = name.toLowerCase();
    if (!config.terminalApps.some(t => lower.includes(t.toLowerCase()))) {
      console.log(`openwhip: front app "${name}" is not a terminal; holding the whip back`);
      return done();
    }
    send(text, interrupt, done);
  });
}

/** Calls back with the front app's name / window class / exe name, or null. */
function getFrontApp(cb) {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], (err, stdout) => cb(err ? null : stdout.trim() || null));
  } else if (process.platform === 'linux') {
    execFile('xdotool', ['getactivewindow', 'getwindowclassname'],
      (err, stdout) => cb(err ? null : stdout.trim() || null));
  } else if (process.platform === 'win32') {
    cb(getFrontExeWindows());
  } else {
    cb(null);
  }
}

function getFrontExeWindows() {
  if (!GetForegroundWindow) return null;
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return null;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
    if (!proc) return null;
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (!QueryFullProcessImageNameW(proc, 0, buf, size)) return null;
      return path.win32.basename(String.fromCharCode(...buf.subarray(0, size[0])));
    } finally {
      CloseHandle(proc);
    }
  } catch (e) {
    console.warn('openwhip: foreground window lookup failed:', e.message);
    return null;
  }
}

function sendMacroWindows(text, interrupt, done) {
  if (!SendInput) return done();
  const blocked = () => console.warn('openwhip: Windows blocked the keystrokes. Is the terminal running as administrator? Run openwhip as admin too.');
  try {
    const interruptInputs = interrupt === 'ctrl-c'
      ? [keyInput(VK_CONTROL), ...tapInputs(VK_C), keyInput(VK_CONTROL, true)]
      : tapInputs(VK_ESCAPE);
    if (!sendInputs([...releaseHeldModifiers(), ...interruptInputs])) {
      blocked();
      return done();
    }
  } catch (e) {
    console.warn('openwhip: SendInput failed:', e.message);
    return done();
  }
  // Same beat as macOS: let Claude Code finish interrupting before we type.
  setTimeout(() => {
    try {
      if (!sendInputs([...releaseHeldModifiers(), ...unicodeInputs(text), ...tapInputs(VK_RETURN)])) blocked();
    } catch (e) {
      console.warn('openwhip: SendInput failed:', e.message);
    }
    done();
  }, 300);
}

function sendMacroMac(text, interrupt, done) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // One osascript process: interrupt, give the app a beat to react, then type.
  const script = [
    'tell application "System Events"',
    interrupt === 'ctrl-c'
      ? '  key code 8 using {control down}' // Ctrl+C
      : '  key code 53',                    // Esc
    '  delay 0.3',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', script], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
    done();
  });
}

function sendMacroLinux(text, interrupt, done) {
  execFile(
    'xdotool',
    [
      'key', '--clearmodifiers', interrupt === 'ctrl-c' ? 'ctrl+c' : 'Escape',
      'type', '--delay', '1', '--clearmodifiers', '--', text,
      'key', 'Return',
    ],
    err => {
      if (err) {
        console.warn('linux macro failed. Install xdotool:', err.message);
      }
      done();
    }
  );
}

// ── App lifecycle ───────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const n = state.whipCount;
  const today = state.daily[todayKey()] || 0;
  const setInterrupt = key => { state.interruptKey = key; saveState(); };
  tray.setToolTip(`OpenWhip - ${today} today, ${n} all time`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Whips today: ${today}`, enabled: false },
      { label: `Whips all time: ${n}`, enabled: false },
      { type: 'separator' },
      { label: 'Spawn / drop whip', accelerator: SPAWN_SHORTCUT, click: () => toggleOverlay() },
      {
        label: 'Send keystrokes',
        type: 'checkbox',
        checked: state.sendKeys,
        click: item => { state.sendKeys = item.checked; saveState(); },
      },
      {
        label: 'Only whip terminals',
        type: 'checkbox',
        checked: state.terminalsOnly,
        click: item => { state.terminalsOnly = item.checked; saveState(); },
      },
      {
        label: 'Interrupt with',
        submenu: [
          { label: 'Esc (recommended for Claude Code)', type: 'radio', checked: state.interruptKey !== 'ctrl-c', click: () => setInterrupt('escape') },
          { label: 'Ctrl+C', type: 'radio', checked: state.interruptKey === 'ctrl-c', click: () => setInterrupt('ctrl-c') },
        ],
      },
      {
        label: 'Crack sound',
        type: 'checkbox',
        checked: state.sound,
        click: item => { state.sound = item.checked; saveState(); sendSettings(); },
      },
      {
        label: 'Edit messages & terminal list…',
        click: () => {
          try {
            ensureConfigFile();
            // Windows often has nothing associated with .json; fall back to Notepad.
            shell.openPath(configPath()).then(err => {
              if (err && process.platform === 'win32') execFile('notepad.exe', [configPath()]);
              else if (err) console.warn('openwhip: could not open config:', err);
            });
          } catch (e) {
            console.warn('openwhip: could not open config:', e.message);
          }
        },
      },
      { label: 'Reset whip count', click: () => { state.whipCount = 0; state.daily = {}; saveState(); updateTray(); } },
      ...(process.platform === 'win32' ? [{
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings(loginItem()).openAtLogin,
        click: item => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }),
      }] : []),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

// Installed via npm, the app runs as `electron.exe <app dir>`, so the login
// item has to pass the app dir along or Windows boots a bare Electron.
const loginItem = () => ({ path: process.execPath, args: [app.getAppPath()] });

// Running `openwhip` again shouldn't stack a second tray icon; spawn the whip instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggleOverlay({ refocus: false }));
}

app.whenReady().then(() => {
  loadState();
  trackForegroundWindow();
  tray = new Tray(getTrayIcon());
  updateTray();
  tray.on('click', () => toggleOverlay());

  if (!globalShortcut.register(SPAWN_SHORTCUT, () => toggleOverlay({ refocus: false }))) {
    console.warn(`openwhip: could not register ${SPAWN_SHORTCUT} (in use by another app?)`);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (saveTimer) writeState();
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
