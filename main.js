/*
 * ChatGPT Desktop Wrapper
 * Developer: Stephan Coertzen <coertzen.jfs@gmail.com>
 * License: MIT
 */
const { app, BrowserWindow, shell } = require('electron');

const REFRESH_BUTTON_SCRIPT = `
(() => {
  const hostId = 'chatgpt-desktop-refresh-host';

  if (document.getElementById(hostId)) {
    return;
  }

  const host = document.createElement('div');
  host.id = hostId;
  host.style.position = 'fixed';
  host.style.top = '12px';
  host.style.right = '14px';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    'button {',
    '  align-items: center;',
    '  background: rgba(255, 255, 255, 0.92);',
    '  border: 1px solid rgba(0, 0, 0, 0.16);',
    '  border-radius: 8px;',
    '  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);',
    '  color: #111827;',
    '  cursor: pointer;',
    '  display: inline-flex;',
    '  height: 36px;',
    '  justify-content: center;',
    '  padding: 0;',
    '  width: 36px;',
    '}',
    'button:hover { background: #ffffff; }',
    'button:active { transform: translateY(1px); }',
    'button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }',
    'svg { height: 18px; width: 18px; }',
    '@media (prefers-color-scheme: dark) {',
    '  button {',
    '    background: rgba(31, 41, 55, 0.92);',
    '    border-color: rgba(255, 255, 255, 0.2);',
    '    color: #f9fafb;',
    '  }',
    '  button:hover { background: #374151; }',
    '}'
  ].join('\\n');

  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Refresh';
  button.setAttribute('aria-label', 'Refresh ChatGPT');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const d of ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  button.appendChild(svg);
  button.addEventListener('click', () => {
    window.location.reload();
  });

  shadow.append(style, button);
  document.documentElement.appendChild(host);
})();
`;

const QUIMERA_AUTO_APPROVE_SCRIPT = `
(() => {
  const hostId = 'chatgpt-desktop-quimera-autoapprove-host';

  if (document.getElementById(hostId)) {
    return;
  }

  const TOOL_NAME = 'quimera';
  const ALLOW_LABEL = 'permitir';
  const PROMPT_PHRASE = 'permitir que';
  const MAX_CONTAINER_TEXT_LENGTH = 6000;
  const MAX_ANCESTOR_DEPTH = 14;
  const CLICK_DELAY_MIN_MS = 400;
  const CLICK_DELAY_MAX_MS = 900;
  const LOG_PREFIX = '[quimera-autoapprove]';

  let autoApproveEnabled = true;
  const processedButtons = new WeakSet();
  const loggedMismatches = new WeakSet();

  const host = document.createElement('div');
  host.id = hostId;
  host.style.position = 'fixed';
  host.style.top = '12px';
  host.style.right = '58px';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    'button {',
    '  align-items: center;',
    '  background: rgba(255, 255, 255, 0.92);',
    '  border: 1px solid rgba(0, 0, 0, 0.16);',
    '  border-radius: 8px;',
    '  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);',
    '  color: #111827;',
    '  cursor: pointer;',
    '  display: inline-flex;',
    '  height: 36px;',
    '  justify-content: center;',
    '  padding: 0;',
    '  width: 36px;',
    '}',
    'button:hover { background: #ffffff; }',
    'button:active { transform: translateY(1px); }',
    'button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }',
    'svg { height: 18px; width: 18px; }',
    '@media (prefers-color-scheme: dark) {',
    '  button {',
    '    background: rgba(31, 41, 55, 0.92);',
    '    border-color: rgba(255, 255, 255, 0.2);',
    '    color: #f9fafb;',
    '  }',
    '  button:hover { background: #374151; }',
    '}',
    'button.active { color: #16a34a; }',
    'button.inactive { opacity: 0.5; }'
  ].join('\\n');

  const button = document.createElement('button');
  button.type = 'button';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const d of [
    'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    'M9 12l2 2 4-4'
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  button.appendChild(svg);

  function render() {
    const label = autoApproveEnabled
      ? 'Auto-aprovar Quimera: ativado (clique para desativar)'
      : 'Auto-aprovar Quimera: desativado (clique para ativar)';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(autoApproveEnabled));
    button.classList.toggle('active', autoApproveEnabled);
    button.classList.toggle('inactive', !autoApproveEnabled);
  }

  button.addEventListener('click', () => {
    autoApproveEnabled = !autoApproveEnabled;
    render();
  });

  render();
  shadow.append(style, button);
  document.documentElement.appendChild(host);

  function normalizedText(el) {
    return (el.textContent || '').trim().toLowerCase();
  }

  function isDisabledCandidate(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  // Only clicks "Permitir" on prompts whose card text also names the Quimera
  // tool, so unrelated connector/tool approval prompts still require a human.
  function findQuimeraContainer(el) {
    let container = el;
    const chain = [];
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && container; depth += 1) {
      const text = normalizedText(container);
      chain.push(text.length);
      if (text.length <= MAX_CONTAINER_TEXT_LENGTH && text.includes(TOOL_NAME) && text.includes(PROMPT_PHRASE)) {
        return { container, depth, chain };
      }
      container = container.parentElement;
    }
    return null;
  }

  function scanAndApprove() {
    if (!autoApproveEnabled) {
      return;
    }

    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const candidate of candidates) {
      if (processedButtons.has(candidate)) {
        continue;
      }
      if (normalizedText(candidate) !== ALLOW_LABEL) {
        continue;
      }

      const match = findQuimeraContainer(candidate);
      if (!match) {
        if (!loggedMismatches.has(candidate)) {
          loggedMismatches.add(candidate);
          console.info(LOG_PREFIX, 'botao "Permitir" encontrado, mas nenhum ancestral ate profundidade',
            MAX_ANCESTOR_DEPTH, 'contem "quimera" + "permitir que". Elemento:', candidate);
        }
        continue;
      }

      if (isDisabledCandidate(candidate)) {
        console.info(LOG_PREFIX, 'botao "Permitir" da Quimera encontrado mas esta desabilitado, aguardando proxima varredura.', candidate);
        continue;
      }

      processedButtons.add(candidate);
      const delayMs = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);
      console.info(LOG_PREFIX, 'botao "Permitir" da Quimera encontrado (profundidade', match.depth,
        '), clicando em', Math.round(delayMs), 'ms.', candidate);

      setTimeout(() => {
        if (!autoApproveEnabled || !candidate.isConnected || isDisabledCandidate(candidate)) {
          console.info(LOG_PREFIX, 'clique cancelado (desativado, removido do DOM ou desabilitado novamente).', candidate);
          return;
        }
        console.info(LOG_PREFIX, 'clicando em "Permitir" da Quimera.', candidate);
        candidate.click();
      }, delayMs);
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanAndApprove();
    });
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleScan();

  console.info(LOG_PREFIX, 'script injetado e observando o DOM.');
})();
`;

function injectRefreshButton(win) {
  win.webContents.executeJavaScript(REFRESH_BUTTON_SCRIPT).catch(() => {
    // The page can briefly reject injection while navigating; the next load retries it.
  });
}

function injectQuimeraAutoApprove(win) {
  win.webContents.executeJavaScript(QUIMERA_AUTO_APPROVE_SCRIPT).catch(() => {
    // The page can briefly reject injection while navigating; the next load retries it.
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault();
      win.webContents.reload();
    }
  });

  win.webContents.on('dom-ready', () => {
    injectRefreshButton(win);
    injectQuimeraAutoApprove(win);
  });

  win.loadURL('https://chatgpt.com');
}

app.whenReady().then(() => {
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
