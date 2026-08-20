/*
 * ChatClient
 * Multi-provider Electron shell for ChatGPT and Grok.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, shell, screen } = require('electron');
const {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync
} = require('node:fs');
const { join } = require('node:path');

const PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com'
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    url: 'https://grok.com/'
  }
};

const MODES = new Set(['chatgpt', 'grok', 'compare']);
const DEFAULT_LAYOUT = {
  x: 0,
  y: 0,
  width: 1280,
  height: 820,
  dividerWidth: 10,
  splitRatio: 0.5
};

const CHROME_REVEAL = {
  railWidth: 48,
  toolbarWidth: 184,
  toolbarHeight: 44,
  toolbarInset: 8,
  hotCornerSize: 28,
  holdMargin: 18,
  hideDelayMs: 650,
  pollIntervalMs: 75
};

const QUIMERA_AUTO_APPROVE_SCRIPT = readFileSync(
  join(__dirname, 'injections', 'quimera-auto-approve.js'),
  'utf8'
);

let mainWindow = null;
let providerViews = new Map();
let chromeViews = new Map();
let mode = 'chatgpt';
let layout = { ...DEFAULT_LAYOUT };
let quimeraAutoApproveEnabled = true;
let shellOverlayVisible = false;
let railVisible = false;
let toolbarVisible = false;
let chromeHoverInterval = null;
let railLastIntentAt = 0;
let toolbarLastIntentAt = 0;
let sessionStatePath = null;
let sessionSaveTimer = null;
let restoredWindowState = null;
let restoreWorkspaceEnabled = true;
let providerUrls = Object.fromEntries(
  Object.values(PROVIDERS).map((provider) => [provider.id, provider.url])
);

function loadSessionState() {
  sessionStatePath = join(app.getPath('userData'), 'session-state.json');

  try {
    const saved = JSON.parse(readFileSync(sessionStatePath, 'utf8'));

    if (typeof saved.restoreWorkspaceEnabled === 'boolean') {
      restoreWorkspaceEnabled = saved.restoreWorkspaceEnabled;
    }

    if (typeof saved.quimeraAutoApproveEnabled === 'boolean') {
      quimeraAutoApproveEnabled = saved.quimeraAutoApproveEnabled;
    }

    if (!restoreWorkspaceEnabled) {
      return;
    }

    if (MODES.has(saved.mode)) {
      mode = saved.mode;
    }

    if (Number.isFinite(saved.splitRatio)) {
      layout.splitRatio = Math.min(0.8, Math.max(0.2, saved.splitRatio));
    }

    if (saved.providers && typeof saved.providers === 'object') {
      for (const provider of Object.values(PROVIDERS)) {
        const savedUrl = saved.providers[provider.id];
        if (typeof savedUrl === 'string' && isTrustedProviderUrl(provider.id, savedUrl)) {
          providerUrls[provider.id] = savedUrl;
        }
      }
    }

    if (saved.window && typeof saved.window === 'object') {
      restoredWindowState = saved.window;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[chatclient] Não foi possível restaurar a sessão:', error.message);
    }
  }
}

function getPersistedWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return restoredWindowState;
  }

  const normalBounds = mainWindow.getNormalBounds();
  return {
    ...normalBounds,
    maximized: mainWindow.isMaximized()
  };
}

function buildSessionState() {
  return {
    version: 1,
    restoreWorkspaceEnabled,
    mode,
    splitRatio: layout.splitRatio,
    quimeraAutoApproveEnabled,
    providers: { ...providerUrls },
    window: getPersistedWindowState()
  };
}

function saveSessionStateNow() {
  if (!sessionStatePath) {
    return;
  }

  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const tempPath = `${sessionStatePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(buildSessionState(), null, 2)}\n`, 'utf8');
    renameSync(tempPath, sessionStatePath);
  } catch (error) {
    console.warn('[chatclient] Não foi possível salvar a sessão:', error.message);
  }
}

function scheduleSessionSave(delayMs = 250) {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    saveSessionStateNow();
  }, delayMs);
}

function getRestoredWindowOptions() {
  const fallback = { width: 1280, height: 820 };
  const saved = restoredWindowState;

  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return fallback;
  }

  const width = Math.max(980, Math.round(saved.width));
  const height = Math.max(640, Math.round(saved.height));

  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return { width, height };
  }

  const candidate = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width,
    height
  };
  const display = screen.getDisplayMatching(candidate);
  const workArea = display.workArea;

  const visible =
    candidate.x < workArea.x + workArea.width &&
    candidate.y < workArea.y + workArea.height &&
    candidate.x + candidate.width > workArea.x &&
    candidate.y + candidate.height > workArea.y;

  return visible ? candidate : { width, height };
}

function safeRectangle(value) {
  return {
    x: Math.max(0, Math.round(Number(value.x) || 0)),
    y: Math.max(0, Math.round(Number(value.y) || 0)),
    width: Math.max(0, Math.round(Number(value.width) || 0)),
    height: Math.max(0, Math.round(Number(value.height) || 0)),
    dividerWidth: Math.max(4, Math.round(Number(value.dividerWidth) || 10)),
    splitRatio: Math.min(0.8, Math.max(0.2, Number(value.splitRatio) || 0.5))
  };
}

function emitState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('chatclient:state', {
    mode,
    quimeraAutoApproveEnabled,
    restoreWorkspaceEnabled
  });

  for (const view of chromeViews.values()) {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send('chatclient:state', {
        mode,
        quimeraAutoApproveEnabled,
        restoreWorkspaceEnabled
      });
    }
  }
}

function emitChromeState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('chatclient:chrome-state', {
    railVisible,
    toolbarVisible
  });
}

function setChromeVisibility(nextRailVisible, nextToolbarVisible) {
  const nextRail = Boolean(nextRailVisible);
  const nextToolbar = Boolean(nextToolbarVisible);

  if (railVisible === nextRail && toolbarVisible === nextToolbar) {
    return;
  }

  railVisible = nextRail;
  toolbarVisible = nextToolbar;
  applyChromeOverlayLayout();
  emitChromeState();
}

function applyChromeOverlayLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const rail = chromeViews.get('rail');
  const toolbar = chromeViews.get('toolbar');
  if (!rail || !toolbar) {
    return;
  }

  const [width, height] = mainWindow.getContentSize();
  const overlaysAllowed = !shellOverlayVisible;

  rail.setBounds({
    x: 0,
    y: 0,
    width: CHROME_REVEAL.railWidth,
    height
  });
  rail.setVisible(overlaysAllowed && railVisible);

  toolbar.setBounds({
    x: Math.max(
      0,
      width - CHROME_REVEAL.toolbarWidth - CHROME_REVEAL.toolbarInset
    ),
    y: CHROME_REVEAL.toolbarInset,
    width: CHROME_REVEAL.toolbarWidth,
    height: CHROME_REVEAL.toolbarHeight
  });
  toolbar.setVisible(overlaysAllowed && toolbarVisible);
}

function pollChromeHover() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) {
    setChromeVisibility(false, false);
    return;
  }

  const bounds = mainWindow.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  const insideWindow =
    cursor.x >= bounds.x &&
    cursor.y >= bounds.y &&
    cursor.x < bounds.x + bounds.width &&
    cursor.y < bounds.y + bounds.height;

  if (!insideWindow) {
    const now = Date.now();
    setChromeVisibility(
      now - railLastIntentAt < CHROME_REVEAL.hideDelayMs,
      now - toolbarLastIntentAt < CHROME_REVEAL.hideDelayMs
    );
    return;
  }

  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  const now = Date.now();

  const inRailHotCorner =
    localX <= CHROME_REVEAL.hotCornerSize &&
    localY <= CHROME_REVEAL.hotCornerSize;
  const inToolbarHotCorner =
    localX >= bounds.width - CHROME_REVEAL.hotCornerSize &&
    localY <= CHROME_REVEAL.hotCornerSize;

  const insideVisibleRail =
    railVisible &&
    localX <= CHROME_REVEAL.railWidth + CHROME_REVEAL.holdMargin;
  const insideVisibleToolbar =
    toolbarVisible &&
    localX >=
      bounds.width -
        CHROME_REVEAL.toolbarWidth -
        CHROME_REVEAL.toolbarInset -
        CHROME_REVEAL.holdMargin &&
    localY <=
      CHROME_REVEAL.toolbarHeight +
        CHROME_REVEAL.toolbarInset +
        CHROME_REVEAL.holdMargin;

  if (inRailHotCorner || insideVisibleRail) {
    railLastIntentAt = now;
  }

  if (inToolbarHotCorner || insideVisibleToolbar) {
    toolbarLastIntentAt = now;
  }

  setChromeVisibility(
    now - railLastIntentAt < CHROME_REVEAL.hideDelayMs,
    now - toolbarLastIntentAt < CHROME_REVEAL.hideDelayMs
  );
}

function startChromeHoverTracking() {
  if (chromeHoverInterval) {
    clearInterval(chromeHoverInterval);
  }

  railLastIntentAt = 0;
  toolbarLastIntentAt = 0;
  chromeHoverInterval = setInterval(pollChromeHover, CHROME_REVEAL.pollIntervalMs);
}

function stopChromeHoverTracking() {
  if (chromeHoverInterval) {
    clearInterval(chromeHoverInterval);
    chromeHoverInterval = null;
  }
}

function emitProviderStatus(providerId, patch) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('chatclient:provider-status', {
    providerId,
    ...patch
  });
}

function isTrustedProviderUrl(providerId, url) {
  try {
    const hostname = new URL(url).hostname;

    if (providerId === 'chatgpt') {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') ||
        hostname === 'openai.com' || hostname.endsWith('.openai.com');
    }

    if (providerId === 'grok') {
      return hostname === 'grok.com' || hostname.endsWith('.grok.com') ||
        hostname === 'x.ai' || hostname.endsWith('.x.ai');
    }
  } catch {
    return false;
  }

  return false;
}

function isAuthenticationPopupUrl(providerId, url) {
  if (!url || url.startsWith('about:blank')) {
    return true;
  }

  if (isTrustedProviderUrl(providerId, url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname;
    const authenticationHosts = [
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com',
      'login.live.com',
      'github.com',
      'x.com',
      'twitter.com'
    ];

    return authenticationHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function isManagedPopupNavigationUrl(url) {
  if (!url || url.startsWith('about:blank')) {
    return true;
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol === 'https:') {
      return true;
    }

    if (parsed.protocol !== 'http:') {
      return false;
    }

    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function managedPopupOptions(provider) {
  return {
    parent: mainWindow,
    modal: false,
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#11151a',
    title: `Entrar em ${provider.label} - ChatClient`
  };
}

function configureManagedPopup(childWindow, provider) {
  childWindow.setMenuBarVisibility(false);
  childWindow.setTitle(`Entrar em ${provider.label} - ChatClient`);
  childWindow.center();
  childWindow.focus();

  childWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isManagedPopupNavigationUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: managedPopupOptions(provider)
      };
    }

    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  childWindow.webContents.on('did-create-window', (nestedWindow) => {
    configureManagedPopup(nestedWindow, provider);
  });

  childWindow.webContents.on('will-navigate', (event, url) => {
    if (isManagedPopupNavigationUrl(url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });
}

function configureProviderView(provider) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  view.setBackgroundColor('#0f1115');

  const contents = view.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    if (isManagedPopupNavigationUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: managedPopupOptions(provider)
      };
    }

    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => {
    configureManagedPopup(childWindow, provider);
  });

  contents.on('will-navigate', (event, url) => {
    if (isAuthenticationPopupUrl(provider.id, url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  contents.on('did-start-loading', () => {
    emitProviderStatus(provider.id, { loading: true });
  });

  contents.on('did-stop-loading', () => {
    const currentUrl = contents.getURL();
    if (isTrustedProviderUrl(provider.id, currentUrl)) {
      providerUrls[provider.id] = currentUrl;
      scheduleSessionSave();
    }

    emitProviderStatus(provider.id, {
      loading: false,
      url: currentUrl
    });
  });

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isTrustedProviderUrl(provider.id, url)) {
      providerUrls[provider.id] = url;
      scheduleSessionSave();
    }
  });

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    emitProviderStatus(provider.id, {
      loading: false,
      error: errorDescription,
      url: validatedURL
    });
  });

  contents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) {
      event.preventDefault();
    }
  });

  if (provider.id === 'chatgpt') {
    contents.on('dom-ready', () => {
      injectQuimeraAutoApprove();
    });
  }

  contents.loadURL(providerUrls[provider.id] || provider.url);
  return view;
}

function configureChromeView(name, fileName) {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  view.setBackgroundColor('#00000000');
  view.setVisible(false);

  view.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) {
      event.preventDefault();
    }
  });

  view.webContents.once('did-finish-load', () => {
    view.webContents.send('chatclient:state', {
      mode,
      quimeraAutoApproveEnabled,
      restoreWorkspaceEnabled
    });
  });

  view.webContents.loadFile(join(__dirname, 'renderer', fileName));
  chromeViews.set(name, view);
  return view;
}

function injectQuimeraAutoApprove() {
  const view = providerViews.get('chatgpt');
  if (!view || view.webContents.isDestroyed()) {
    return;
  }

  view.webContents.executeJavaScript(QUIMERA_AUTO_APPROVE_SCRIPT)
    .then(() => setQuimeraAutoApprove(quimeraAutoApproveEnabled, false))
    .catch(() => {
      // Navigation can briefly make the renderer unavailable; dom-ready retries it.
    });
}

function setQuimeraAutoApprove(enabled, notify = true) {
  quimeraAutoApproveEnabled = Boolean(enabled);
  scheduleSessionSave();

  const view = providerViews.get('chatgpt');
  if (view && !view.webContents.isDestroyed()) {
    const serialized = JSON.stringify(quimeraAutoApproveEnabled);
    view.webContents.executeJavaScript(
      `window.__chatClientQuimeraAutoApprove?.setEnabled(${serialized});`
    ).catch(() => {});
  }

  if (notify) {
    emitState();
  }
}

function setRestoreWorkspaceEnabled(enabled) {
  restoreWorkspaceEnabled = Boolean(enabled);
  scheduleSessionSave();
  emitState();
}

function applyViewLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const chatgpt = providerViews.get('chatgpt');
  const grok = providerViews.get('grok');
  if (!chatgpt || !grok) {
    return;
  }

  if (shellOverlayVisible) {
    chatgpt.setVisible(false);
    grok.setVisible(false);
    return;
  }

  const { x, y, width, height, dividerWidth, splitRatio } = layout;
  const usableWidth = Math.max(0, width - dividerWidth);
  const leftWidth = Math.max(0, Math.round(usableWidth * splitRatio));
  const rightWidth = Math.max(0, usableWidth - leftWidth);

  if (mode === 'compare') {
    chatgpt.setVisible(true);
    grok.setVisible(true);
    chatgpt.setBounds({ x, y, width: leftWidth, height });
    grok.setBounds({
      x: x + leftWidth + dividerWidth,
      y,
      width: rightWidth,
      height
    });
    return;
  }

  const active = mode === 'grok' ? grok : chatgpt;
  const inactive = mode === 'grok' ? chatgpt : grok;

  active.setVisible(true);
  inactive.setVisible(false);
  active.setBounds({ x, y, width, height });
}

function setMode(nextMode, notify = true) {
  if (!MODES.has(nextMode)) {
    return false;
  }

  mode = nextMode;
  scheduleSessionSave();
  applyViewLayout();

  if (notify) {
    emitState();
  }

  return true;
}

function refreshCurrentMode() {
  const ids = mode === 'compare' ? ['chatgpt', 'grok'] : [mode];

  for (const providerId of ids) {
    const view = providerViews.get(providerId);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.reload();
    }
  }
}

function handleShortcut(input) {
  if (input.type !== 'keyDown') {
    return false;
  }

  if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
    refreshCurrentMode();
    return true;
  }

  if (input.alt && input.key === '1') {
    setMode('chatgpt');
    return true;
  }

  if (input.alt && input.key === '2') {
    setMode('grok');
    return true;
  }

  if (input.alt && input.key === '3') {
    setMode('compare');
    return true;
  }

  return false;
}

function registerIpc() {
  ipcMain.handle('chatclient:get-state', () => ({
    mode,
    quimeraAutoApproveEnabled,
    restoreWorkspaceEnabled,
    railVisible,
    toolbarVisible,
    providers: Object.values(PROVIDERS)
  }));

  ipcMain.handle('chatclient:set-mode', (_event, nextMode) => {
    setMode(nextMode);
    return { mode };
  });

  ipcMain.handle('chatclient:update-layout', (_event, nextLayout) => {
    layout = safeRectangle(nextLayout);
    scheduleSessionSave();
    applyViewLayout();
    return layout;
  });

  ipcMain.handle('chatclient:refresh', () => {
    refreshCurrentMode();
  });

  ipcMain.handle('chatclient:set-quimera-auto-approve', (_event, enabled) => {
    setQuimeraAutoApprove(enabled);
    return { enabled: quimeraAutoApproveEnabled };
  });

  ipcMain.handle('chatclient:set-restore-workspace', (_event, enabled) => {
    setRestoreWorkspaceEnabled(enabled);
    return { enabled: restoreWorkspaceEnabled };
  });

  ipcMain.handle('chatclient:set-shell-overlay', (_event, visible) => {
    shellOverlayVisible = Boolean(visible);
    applyViewLayout();
    applyChromeOverlayLayout();
  });

  ipcMain.handle('chatclient:open-settings', () => {
    setChromeVisibility(false, false);
    mainWindow?.webContents.send('chatclient:open-settings');
  });
}

function createWindow() {
  const restoredWindowOptions = getRestoredWindowOptions();

  mainWindow = new BrowserWindow({
    ...restoredWindowOptions,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#11151a',
    title: 'ChatClient',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  layout.width = contentWidth;
  layout.height = contentHeight;

  for (const provider of Object.values(PROVIDERS)) {
    const view = configureProviderView(provider);
    providerViews.set(provider.id, view);
    mainWindow.contentView.addChildView(view);
  }

  const railView = configureChromeView('rail', 'chrome-rail.html');
  const toolbarView = configureChromeView('toolbar', 'chrome-toolbar.html');
  mainWindow.contentView.addChildView(railView);
  mainWindow.contentView.addChildView(toolbarView);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) {
      event.preventDefault();
    }
  });

  mainWindow.on('resize', () => {
    applyViewLayout();
    applyChromeOverlayLayout();
    scheduleSessionSave(500);
  });
  mainWindow.on('move', () => scheduleSessionSave(500));
  mainWindow.on('maximize', () => {
    applyViewLayout();
    applyChromeOverlayLayout();
    scheduleSessionSave();
  });
  mainWindow.on('unmaximize', () => {
    applyViewLayout();
    applyChromeOverlayLayout();
    scheduleSessionSave();
  });
  mainWindow.on('blur', () => setChromeVisibility(false, false));

  mainWindow.on('close', () => {
    restoredWindowState = getPersistedWindowState();
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
    saveSessionStateNow();
  });

  mainWindow.on('closed', () => {
    for (const view of providerViews.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }

    providerViews = new Map();

    for (const view of chromeViews.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
    chromeViews = new Map();

    stopChromeHoverTracking();
    mainWindow = null;
  });

  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    emitState();
    emitChromeState();
  });

  applyViewLayout();
  applyChromeOverlayLayout();
  startChromeHoverTracking();

  if (restoredWindowState?.maximized) {
    mainWindow.maximize();
  }
}

registerIpc();

app.whenReady().then(() => {
  loadSessionState();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
