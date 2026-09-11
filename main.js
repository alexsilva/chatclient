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
  railHandleWidth: 14,
  railHandleHeight: 110,
  toolbarHandleWidth: 72,
  toolbarHandleHeight: 16,
  holdMargin: 18,
  hideDelayMs: 650,
  pollIntervalMs: 75,
  idlePollIntervalMs: 250
};
const DEFAULT_QUIMERA_APPROVAL_DELAY_MS = 3000;
const MAX_QUIMERA_APPROVAL_DELAY_MS = 30000;
const CHATGPT_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'extra-high']);
const DEFAULT_CHATGPT_REASONING_LEVEL = 'high';

const QUIMERA_AUTO_APPROVE_SCRIPT = readFileSync(
  join(__dirname, 'injections', 'quimera-auto-approve.js'),
  'utf8'
);
const CHATGPT_REASONING_SCRIPT = readFileSync(
  join(__dirname, 'injections', 'chatgpt-reasoning.js'),
  'utf8'
);

let mainWindow = null;
let providerViews = new Map();
let chromeViews = new Map();
let mode = 'chatgpt';
let layout = { ...DEFAULT_LAYOUT };
let quimeraAutoApproveEnabled = true;
let quimeraApprovalDelayMs = DEFAULT_QUIMERA_APPROVAL_DELAY_MS;
let shellOverlayVisible = false;
let railVisible = false;
let toolbarVisible = false;
let chromeHoverTimer = null;
let chromeHoverActive = false;
let railLastIntentAt = 0;
let toolbarLastIntentAt = 0;
let sessionStatePath = null;
let sessionSaveTimer = null;
let restoredWindowState = null;
let restoreWorkspaceEnabled = true;
let chatgptReasoningLevel = DEFAULT_CHATGPT_REASONING_LEVEL;
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

    if (Number.isFinite(saved.quimeraApprovalDelayMs)) {
      quimeraApprovalDelayMs = normalizeQuimeraApprovalDelayMs(saved.quimeraApprovalDelayMs);
    }

    if (CHATGPT_REASONING_LEVELS.has(saved.chatgptReasoningLevel)) {
      chatgptReasoningLevel = saved.chatgptReasoningLevel;
    }

    // Geometria da janela é estado da aplicação, não do workspace.
    // Mesmo com a restauração do workspace desativada, o cliente deve abrir
    // exatamente onde o usuário o deixou em vez de voltar ao posicionamento
    // padrão do sistema (normalmente centralizado).
    if (saved.window && typeof saved.window === 'object') {
      restoredWindowState = saved.window;
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
    quimeraApprovalDelayMs,
    chatgptReasoningLevel,
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

function normalizeQuimeraApprovalDelayMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_QUIMERA_APPROVAL_DELAY_MS;
  }
  return Math.min(MAX_QUIMERA_APPROVAL_DELAY_MS, Math.max(0, Math.round(numeric)));
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
    quimeraApprovalDelayMs,
    chatgptReasoningLevel,
    restoreWorkspaceEnabled
  });

  for (const view of chromeViews.values()) {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send('chatclient:state', {
        mode,
        quimeraAutoApproveEnabled,
        quimeraApprovalDelayMs,
        chatgptReasoningLevel,
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

  for (const view of chromeViews.values()) {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send('chatclient:chrome-state', {
        railVisible,
        toolbarVisible
      });
    }
  }
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

const appliedViewBounds = new WeakMap();

// setBounds numa WebContentsView força relayout do Chromium mesmo com o
// mesmo retângulo; como updateLayout chega via IPC em cada mudança de
// estado do chrome, vale pular quando nada mudou.
function setViewBounds(view, bounds) {
  const previous = appliedViewBounds.get(view);
  if (
    previous &&
    previous.x === bounds.x &&
    previous.y === bounds.y &&
    previous.width === bounds.width &&
    previous.height === bounds.height
  ) {
    return;
  }

  appliedViewBounds.set(view, bounds);
  view.setBounds(bounds);
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

  if (railVisible) {
    setViewBounds(rail, {
      x: 0,
      y: 0,
      width: CHROME_REVEAL.railWidth,
      height
    });
  } else {
    // Recolhido, o rail vira uma alça fina na borda esquerda (estilo Android).
    setViewBounds(rail, {
      x: 0,
      y: Math.max(0, Math.round((height - CHROME_REVEAL.railHandleHeight) / 2)),
      width: CHROME_REVEAL.railHandleWidth,
      height: CHROME_REVEAL.railHandleHeight
    });
  }
  rail.setVisible(overlaysAllowed);

  if (toolbarVisible) {
    setViewBounds(toolbar, {
      x: Math.max(
        0,
        width - CHROME_REVEAL.toolbarWidth - CHROME_REVEAL.toolbarInset
      ),
      y: CHROME_REVEAL.toolbarInset,
      width: CHROME_REVEAL.toolbarWidth,
      height: CHROME_REVEAL.toolbarHeight
    });
  } else {
    setViewBounds(toolbar, {
      x: Math.max(
        0,
        width - CHROME_REVEAL.toolbarHandleWidth - CHROME_REVEAL.toolbarInset
      ),
      y: 0,
      width: CHROME_REVEAL.toolbarHandleWidth,
      height: CHROME_REVEAL.toolbarHandleHeight
    });
  }
  toolbar.setVisible(overlaysAllowed);
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

  const railHandleTop = Math.max(
    0,
    (bounds.height - CHROME_REVEAL.railHandleHeight) / 2
  );
  const inRailHandle =
    !railVisible &&
    localX <= CHROME_REVEAL.railHandleWidth &&
    localY >= railHandleTop &&
    localY <= railHandleTop + CHROME_REVEAL.railHandleHeight;
  const inToolbarHandle =
    !toolbarVisible &&
    localX >=
      bounds.width -
        CHROME_REVEAL.toolbarHandleWidth -
        CHROME_REVEAL.toolbarInset &&
    localY <= CHROME_REVEAL.toolbarHandleHeight;

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

  if (inRailHandle || insideVisibleRail) {
    railLastIntentAt = now;
  }

  if (inToolbarHandle || insideVisibleToolbar) {
    toolbarLastIntentAt = now;
  }

  setChromeVisibility(
    now - railLastIntentAt < CHROME_REVEAL.hideDelayMs,
    now - toolbarLastIntentAt < CHROME_REVEAL.hideDelayMs
  );
}

function scheduleChromeHoverPoll() {
  if (!chromeHoverActive) {
    return;
  }

  // Poll rápido só quando algum overlay está visível; ocioso, poupa o main process.
  const intervalMs = railVisible || toolbarVisible
    ? CHROME_REVEAL.pollIntervalMs
    : CHROME_REVEAL.idlePollIntervalMs;

  chromeHoverTimer = setTimeout(() => {
    pollChromeHover();
    scheduleChromeHoverPoll();
  }, intervalMs);
}

function startChromeHoverTracking() {
  if (chromeHoverActive) {
    return;
  }

  chromeHoverActive = true;
  railLastIntentAt = 0;
  toolbarLastIntentAt = 0;
  scheduleChromeHoverPoll();
}

function stopChromeHoverTracking() {
  chromeHoverActive = false;
  clearTimeout(chromeHoverTimer);
  chromeHoverTimer = null;
}

const providerLoading = new Map();

function setProviderLoading(providerId, patch) {
  const previous = providerLoading.get(providerId) || { loading: false, error: null };
  providerLoading.set(providerId, { ...previous, ...patch });
  updateLoadingOverlay();
}

// Mostra o overlay somente durante carregamento real da janela/documento
// principal do provider. Carregamentos internos do ChatGPT/Grok não devem
// bloquear nem cobrir o conteúdo já aberto.
function updateLoadingOverlay() {
  const overlay = chromeViews.get('loading');
  if (!overlay || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const visibleIds = mode === 'compare' ? ['chatgpt', 'grok'] : [mode];
  const items = visibleIds
    .map((id) => {
      const status = providerLoading.get(id);
      if (!status || (!status.loading && !status.error)) {
        return null;
      }
      return {
        id,
        label: PROVIDERS[id]?.label || id,
        loading: Boolean(status.loading),
        error: status.error || null
      };
    })
    .filter(Boolean);

  if (!items.length || shellOverlayVisible) {
    overlay.setVisible(false);
    return;
  }

  const { x, y, width, height, dividerWidth, splitRatio } = layout;
  let bounds = { x, y, width, height };

  if (mode === 'compare' && items.length === 1) {
    const usableWidth = Math.max(0, width - dividerWidth);
    const leftWidth = Math.max(0, Math.round(usableWidth * splitRatio));
    bounds = items[0].id === 'chatgpt'
      ? { x, y, width: leftWidth, height }
      : {
          x: x + leftWidth + dividerWidth,
          y,
          width: Math.max(0, usableWidth - leftWidth),
          height
        };
  }

  setViewBounds(overlay, bounds);
  overlay.setVisible(true);

  if (!overlay.webContents.isLoading()) {
    overlay.webContents.send('chatclient:loading-state', { items });
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

  contents.on('did-start-navigation', (_event, details) => {
    if (!details?.isMainFrame || details.isInPlace) {
      return;
    }

    setProviderLoading(provider.id, { loading: true, error: null });
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

    setProviderLoading(provider.id, { loading: false });
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

    setProviderLoading(provider.id, { loading: false, error: errorDescription });
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
      injectChatgptReasoningControl();
    });
  }

  setProviderLoading(provider.id, { loading: true, error: null });
  contents.loadURL(providerUrls[provider.id] || provider.url);
  return view;
}

function ensureProviderView(providerId) {
  const existing = providerViews.get(providerId);
  if (existing && !existing.webContents.isDestroyed()) {
    return existing;
  }

  const provider = PROVIDERS[providerId];
  if (!provider || !mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const view = configureProviderView(provider);
  providerViews.set(providerId, view);
  // Índice 0 mantém provider views abaixo das chrome views (rail/toolbar).
  mainWindow.contentView.addChildView(view, 0);
  return view;
}

function ensureModeViews(targetMode) {
  const ids = targetMode === 'compare' ? ['chatgpt', 'grok'] : [targetMode];
  for (const providerId of ids) {
    ensureProviderView(providerId);
  }
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
      quimeraApprovalDelayMs,
      chatgptReasoningLevel,
      restoreWorkspaceEnabled
    });
    view.webContents.send('chatclient:chrome-state', {
      railVisible,
      toolbarVisible
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
    .then(() => syncQuimeraAutoApproveConfig())
    .catch(() => {
      // Navigation can briefly make the renderer unavailable; dom-ready retries it.
    });
}

function syncQuimeraAutoApproveConfig() {
  const view = providerViews.get('chatgpt');
  if (!view || view.webContents.isDestroyed()) {
    return;
  }

  const enabled = JSON.stringify(quimeraAutoApproveEnabled);
  const delayMs = JSON.stringify(quimeraApprovalDelayMs);
  view.webContents.executeJavaScript(
    `window.__chatClientQuimeraAutoApprove?.setEnabled(${enabled});` +
    `window.__chatClientQuimeraAutoApprove?.setDelayMs(${delayMs});`
  ).catch(() => {});
}

function setQuimeraAutoApprove(enabled, notify = true) {
  quimeraAutoApproveEnabled = Boolean(enabled);
  scheduleSessionSave();
  syncQuimeraAutoApproveConfig();

  if (notify) {
    emitState();
  }
}

function setQuimeraApprovalDelayMs(delayMs) {
  quimeraApprovalDelayMs = normalizeQuimeraApprovalDelayMs(delayMs);
  scheduleSessionSave();
  syncQuimeraAutoApproveConfig();
  emitState();
}

function injectChatgptReasoningControl() {
  const view = providerViews.get('chatgpt');
  if (!view || view.webContents.isDestroyed()) {
    return;
  }

  view.webContents.executeJavaScript(CHATGPT_REASONING_SCRIPT)
    .then(() => syncChatgptReasoningConfig())
    .catch(() => {
      // Navigation can briefly make the renderer unavailable; dom-ready retries it.
    });
}

function syncChatgptReasoningConfig() {
  const view = providerViews.get('chatgpt');
  if (!view || view.webContents.isDestroyed()) {
    return;
  }

  const level = JSON.stringify(chatgptReasoningLevel);
  view.webContents.executeJavaScript(
    `window.__chatClientReasoningControl?.setLevel(${level})`
  ).then((applied) => {
    if (applied === false) {
      console.warn(`[chatgpt-reasoning] não foi possível aplicar o nível ${chatgptReasoningLevel} no seletor nativo`);
    }
  }).catch(() => {});
}

function setChatgptReasoningLevel(level) {
  if (!CHATGPT_REASONING_LEVELS.has(level)) {
    return false;
  }

  chatgptReasoningLevel = level;
  scheduleSessionSave();
  syncChatgptReasoningConfig();
  emitState();
  return true;
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

  updateLoadingOverlay();

  const chatgpt = providerViews.get('chatgpt');
  const grok = providerViews.get('grok');

  if (shellOverlayVisible) {
    chatgpt?.setVisible(false);
    grok?.setVisible(false);
    return;
  }

  const { x, y, width, height, dividerWidth, splitRatio } = layout;
  const usableWidth = Math.max(0, width - dividerWidth);
  const leftWidth = Math.max(0, Math.round(usableWidth * splitRatio));
  const rightWidth = Math.max(0, usableWidth - leftWidth);

  if (mode === 'compare') {
    if (!chatgpt || !grok) {
      return;
    }

    chatgpt.setVisible(true);
    grok.setVisible(true);
    chatgpt.webContents.setAudioMuted(false);
    grok.webContents.setAudioMuted(false);
    setViewBounds(chatgpt, { x, y, width: leftWidth, height });
    setViewBounds(grok, {
      x: x + leftWidth + dividerWidth,
      y,
      width: rightWidth,
      height
    });
    return;
  }

  const active = mode === 'grok' ? grok : chatgpt;
  const inactive = mode === 'grok' ? chatgpt : grok;

  if (!active) {
    return;
  }

  active.setVisible(true);
  active.webContents.setAudioMuted(false);
  if (inactive) {
    inactive.setVisible(false);
    inactive.webContents.setAudioMuted(true);
  }
  setViewBounds(active, { x, y, width, height });
}

function syncLayoutToWindowContent() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  const headerHeight = mode === 'compare' ? 34 : 0;

  layout.x = 0;
  layout.y = headerHeight;
  layout.width = contentWidth;
  layout.height = Math.max(0, contentHeight - headerHeight);
}

function setMode(nextMode, notify = true) {
  if (!MODES.has(nextMode)) {
    return false;
  }

  mode = nextMode;
  scheduleSessionSave();
  ensureModeViews(mode);
  syncLayoutToWindowContent();
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
    quimeraApprovalDelayMs,
    chatgptReasoningLevel,
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
    const requested = safeRectangle(nextLayout);
    layout.dividerWidth = requested.dividerWidth;
    layout.splitRatio = requested.splitRatio;
    syncLayoutToWindowContent();
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

  ipcMain.handle('chatclient:set-quimera-approval-delay', (_event, delayMs) => {
    setQuimeraApprovalDelayMs(delayMs);
    return { delayMs: quimeraApprovalDelayMs };
  });

  ipcMain.handle('chatclient:set-chatgpt-reasoning-level', (_event, level) => {
    if (!setChatgptReasoningLevel(level)) {
      throw new Error(`Unsupported ChatGPT reasoning level: ${String(level)}`);
    }
    return { level: chatgptReasoningLevel };
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

  ipcMain.handle('chatclient:chrome-reveal', (_event, target) => {
    const now = Date.now();
    if (target === 'rail') {
      railLastIntentAt = now;
    } else if (target === 'toolbar') {
      toolbarLastIntentAt = now;
    }
    setChromeVisibility(
      now - railLastIntentAt < CHROME_REVEAL.hideDelayMs,
      now - toolbarLastIntentAt < CHROME_REVEAL.hideDelayMs
    );
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

  syncLayoutToWindowContent();

  // Só carrega os providers do modo atual; os demais são criados sob demanda.
  ensureModeViews(mode);

  const loadingView = configureChromeView('loading', 'chrome-loading.html');
  const railView = configureChromeView('rail', 'chrome-rail.html');
  const toolbarView = configureChromeView('toolbar', 'chrome-toolbar.html');
  // Loading fica acima dos providers e abaixo do rail/toolbar.
  mainWindow.contentView.addChildView(loadingView);
  mainWindow.contentView.addChildView(railView);
  mainWindow.contentView.addChildView(toolbarView);

  loadingView.webContents.once('did-finish-load', () => {
    updateLoadingOverlay();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) {
      event.preventDefault();
    }
  });

  mainWindow.on('resize', () => {
    syncLayoutToWindowContent();
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
  mainWindow.on('blur', () => {
    setChromeVisibility(false, false);
    stopChromeHoverTracking();
  });
  mainWindow.on('focus', () => startChromeHoverTracking());

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
