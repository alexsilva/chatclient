(() => {
  const bridge = window.chatClient;
  const isElectron = Boolean(bridge);

  const railButtons = [...document.querySelectorAll('[data-mode]')];
  const modeLabel = document.getElementById('modeLabel');
  const contentFrame = document.getElementById('contentFrame');
  const compareHeader = document.getElementById('compareHeader');
  const compareDivider = document.getElementById('compareDivider');
  const refreshButton = document.getElementById('refreshButton');
  const quimeraButton = document.getElementById('quimeraButton');
  const quimeraSwitch = document.getElementById('quimeraSwitch');
  const quimeraDelayInput = document.getElementById('quimeraDelayInput');
  const restoreWorkspaceSwitch = document.getElementById('restoreWorkspaceSwitch');
  const settingsButton = document.getElementById('settingsButton');
  const settingsPanel = document.getElementById('settingsPanel');
  const closeSettingsButton = document.getElementById('closeSettingsButton');
  const toast = document.getElementById('toast');

  const state = {
    mode: 'chatgpt',
    splitRatio: 0.5,
    quimeraAutoApproveEnabled: true,
    quimeraApprovalDelayMs: 3000,
    restoreWorkspaceEnabled: true,
    railVisible: false,
    toolbarVisible: false
  };

  let toastTimer = null;
  let dragging = false;
  let previewRailTimer = null;
  let previewToolbarTimer = null;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
  }

  function renderState() {
    document.documentElement.dataset.mode = state.mode;
    document.documentElement.dataset.railVisible = String(state.railVisible);
    document.documentElement.dataset.toolbarVisible = String(state.toolbarVisible);
    for (const button of railButtons) {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    const labels = {
      chatgpt: 'ChatGPT',
      grok: 'Grok',
      compare: 'Comparar'
    };
    modeLabel.textContent = labels[state.mode] || 'ChatGPT';

    const comparing = state.mode === 'compare';
    compareHeader.classList.toggle('visible', comparing);
    compareHeader.setAttribute('aria-hidden', String(!comparing));
    compareDivider.classList.toggle('visible', comparing);
    compareDivider.setAttribute('aria-hidden', String(!comparing));

    quimeraButton.classList.toggle('active', state.quimeraAutoApproveEnabled);
    quimeraButton.setAttribute('aria-pressed', String(state.quimeraAutoApproveEnabled));
    quimeraButton.title = state.quimeraAutoApproveEnabled
      ? 'Auto-aprovar Quimera: ativado'
      : 'Auto-aprovar Quimera: desativado';

    quimeraSwitch.classList.toggle('active', state.quimeraAutoApproveEnabled);
    quimeraSwitch.setAttribute('aria-checked', String(state.quimeraAutoApproveEnabled));

    if (document.activeElement !== quimeraDelayInput) {
      quimeraDelayInput.value = String(state.quimeraApprovalDelayMs / 1000);
    }

    restoreWorkspaceSwitch.classList.toggle('active', state.restoreWorkspaceEnabled);
    restoreWorkspaceSwitch.setAttribute('aria-checked', String(state.restoreWorkspaceEnabled));

    updateLayout();
  }

  function setPreviewChromeVisibility(kind, visible) {
    if (kind === 'rail') {
      state.railVisible = visible;
    } else {
      state.toolbarVisible = visible;
    }
    renderState();
  }

  function schedulePreviewHide(kind) {
    const key = kind === 'rail' ? 'previewRailTimer' : 'previewToolbarTimer';
    const currentTimer = kind === 'rail' ? previewRailTimer : previewToolbarTimer;
    clearTimeout(currentTimer);

    const timer = setTimeout(() => setPreviewChromeVisibility(kind, false), 650);
    if (key === 'previewRailTimer') {
      previewRailTimer = timer;
    } else {
      previewToolbarTimer = timer;
    }
  }

  function getLayout() {
    const rect = contentFrame.getBoundingClientRect();
    const headerHeight = state.mode === 'compare' ? 34 : 0;
    const dividerWidth = 10;

    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + headerHeight),
      width: Math.round(rect.width),
      height: Math.max(0, Math.round(rect.height - headerHeight)),
      dividerWidth,
      splitRatio: state.splitRatio
    };
  }

  function updateDividerPosition() {
    if (state.mode !== 'compare') {
      return;
    }

    const rect = contentFrame.getBoundingClientRect();
    const dividerWidth = 10;
    const usableWidth = rect.width - dividerWidth;
    const leftWidth = Math.round(usableWidth * state.splitRatio);
    compareDivider.style.left = `${leftWidth}px`;
  }

  let lastLayoutKey = '';

  function updateLayout(force = false) {
    updateDividerPosition();

    if (!isElectron) {
      return;
    }

    // renderState roda a cada evento de estado (inclusive show/hide do
    // rail/toolbar); só vale pagar o IPC quando o layout mudou de fato.
    const nextLayout = getLayout();
    const key = JSON.stringify(nextLayout);
    if (!force && key === lastLayoutKey) {
      return;
    }

    lastLayoutKey = key;
    bridge.updateLayout(nextLayout).catch(() => {});
  }

  async function setMode(nextMode) {
    if (!['chatgpt', 'grok', 'compare'].includes(nextMode)) {
      return;
    }

    state.mode = nextMode;
    renderState();

    if (isElectron) {
      try {
        const result = await bridge.setMode(nextMode);
        state.mode = result.mode;
        renderState();
      } catch {
        showToast('Não foi possível trocar o provedor.');
      }
    }
  }

  async function setQuimeraEnabled(enabled) {
    state.quimeraAutoApproveEnabled = Boolean(enabled);
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      const result = await bridge.setQuimeraAutoApprove(state.quimeraAutoApproveEnabled);
      state.quimeraAutoApproveEnabled = result.enabled;
      renderState();
    } catch {
      showToast('Não foi possível atualizar a automação da Quimera.');
    }
  }

  async function setQuimeraApprovalDelay(seconds) {
    const numeric = Number(seconds);
    const normalizedSeconds = Number.isFinite(numeric)
      ? Math.min(30, Math.max(0, numeric))
      : 3;
    state.quimeraApprovalDelayMs = Math.round(normalizedSeconds * 1000);
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      const result = await bridge.setQuimeraApprovalDelay(state.quimeraApprovalDelayMs);
      state.quimeraApprovalDelayMs = result.delayMs;
      renderState();
    } catch {
      showToast('Não foi possível atualizar o atraso de aprovação.');
    }
  }

  async function setRestoreWorkspaceEnabled(enabled) {
    state.restoreWorkspaceEnabled = Boolean(enabled);
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      const result = await bridge.setRestoreWorkspace(state.restoreWorkspaceEnabled);
      state.restoreWorkspaceEnabled = result.enabled;
      renderState();
    } catch {
      showToast('Não foi possível atualizar a restauração de trabalho.');
    }
  }

  function openSettings() {
    settingsPanel.classList.add('visible');
    settingsPanel.setAttribute('aria-hidden', 'false');
    if (isElectron) {
      bridge.setShellOverlay(true).catch(() => {});
    }
  }

  function closeSettings() {
    settingsPanel.classList.remove('visible');
    settingsPanel.setAttribute('aria-hidden', 'true');
    if (isElectron) {
      bridge.setShellOverlay(false).catch(() => {});
    }
  }

  function setSplitFromClientX(clientX) {
    const rect = contentFrame.getBoundingClientRect();
    const localX = clientX - rect.left;
    state.splitRatio = Math.min(0.8, Math.max(0.2, localX / Math.max(1, rect.width)));
    updateLayout();
  }

  for (const button of railButtons) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }

  refreshButton.addEventListener('click', async () => {
    refreshButton.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 360, easing: 'ease-out' }
    );

    if (isElectron) {
      await bridge.refresh().catch(() => showToast('Falha ao recarregar.'));
    } else {
      showToast('Recarregar modo atual');
    }
  });

  quimeraButton.addEventListener('click', () => {
    setQuimeraEnabled(!state.quimeraAutoApproveEnabled);
  });

  quimeraSwitch.addEventListener('click', () => {
    setQuimeraEnabled(!state.quimeraAutoApproveEnabled);
  });

  quimeraDelayInput.addEventListener('change', () => {
    setQuimeraApprovalDelay(quimeraDelayInput.value);
  });

  restoreWorkspaceSwitch.addEventListener('click', () => {
    setRestoreWorkspaceEnabled(!state.restoreWorkspaceEnabled);
  });

  settingsButton.addEventListener('click', openSettings);
  closeSettingsButton.addEventListener('click', closeSettings);
  settingsPanel.addEventListener('click', (event) => {
    if (event.target === settingsPanel) {
      closeSettings();
    }
  });

  compareDivider.addEventListener('pointerdown', (event) => {
    dragging = true;
    compareDivider.classList.add('dragging');
    compareDivider.setPointerCapture(event.pointerId);
    setSplitFromClientX(event.clientX);
  });

  compareDivider.addEventListener('pointermove', (event) => {
    if (dragging) {
      setSplitFromClientX(event.clientX);
    }
  });

  compareDivider.addEventListener('pointerup', (event) => {
    dragging = false;
    compareDivider.classList.remove('dragging');
    compareDivider.releasePointerCapture(event.pointerId);
  });

  compareDivider.addEventListener('dblclick', () => {
    state.splitRatio = 0.5;
    updateLayout();
  });

  compareDivider.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -0.05 : 0.05;
      state.splitRatio = Math.min(0.8, Math.max(0.2, state.splitRatio + delta));
      updateLayout();
    }
  });

  window.addEventListener('resize', () => updateLayout());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsPanel.classList.contains('visible')) {
      closeSettings();
      return;
    }

    if (event.altKey && ['1', '2', '3'].includes(event.key)) {
      const mapping = { '1': 'chatgpt', '2': 'grok', '3': 'compare' };
      setMode(mapping[event.key]);
    }
  });

  if (isElectron) {
    bridge.onOpenSettings(() => {
      openSettings();
    });

    bridge.onState((nextState) => {
      Object.assign(state, nextState);
      renderState();
    });

    bridge.onProviderStatus((status) => {
      if (status.error) {
        showToast(`${status.providerId === 'grok' ? 'Grok' : 'ChatGPT'}: ${status.error}`);
      }
    });

    bridge.onChromeState((chromeState) => {
      state.railVisible = Boolean(chromeState.railVisible);
      state.toolbarVisible = Boolean(chromeState.toolbarVisible);
      renderState();
    });

    bridge.getState()
      .then((initialState) => {
        Object.assign(state, initialState);
        renderState();
      })
      .catch(() => renderState());
  } else {
    document.documentElement.dataset.browserPreview = 'true';
    const preview = document.createElement('div');
    preview.className = 'browser-preview';
    preview.innerHTML = `
      <section class="preview-provider preview-chatgpt">
        <div class="preview-provider-top">ChatGPT</div>
        <div class="preview-copy">
          <strong>Como posso ajudar?</strong>
          <span>Prévia visual do WebContentsView do ChatGPT.</span>
        </div>
      </section>
      <section class="preview-provider preview-grok">
        <div class="preview-provider-top">Grok</div>
        <div class="preview-copy">
          <strong>What do you want to know?</strong>
          <span>Prévia visual do WebContentsView do Grok.</span>
        </div>
      </section>
    `;
    document.getElementById('viewSurface').appendChild(preview);

    window.addEventListener('pointermove', (event) => {
      const railHandleWidth = 14;
      const railHandleHeight = 110;
      const toolbarHandleWidth = 72;
      const toolbarHandleHeight = 16;
      const toolbarInset = 8;

      const railHandleTop = Math.max(
        0,
        (window.innerHeight - railHandleHeight) / 2
      );
      const inRailHandle =
        event.clientX <= railHandleWidth &&
        event.clientY >= railHandleTop &&
        event.clientY <= railHandleTop + railHandleHeight;

      if (inRailHandle) {
        clearTimeout(previewRailTimer);
        setPreviewChromeVisibility('rail', true);
      } else if (state.railVisible && event.clientX > 66) {
        schedulePreviewHide('rail');
      }

      const inToolbarHandle =
        event.clientX >=
          window.innerWidth - toolbarHandleWidth - toolbarInset &&
        event.clientY <= toolbarHandleHeight;

      if (inToolbarHandle) {
        clearTimeout(previewToolbarTimer);
        setPreviewChromeVisibility('toolbar', true);
      } else if (state.toolbarVisible && event.clientY > 72) {
        schedulePreviewHide('toolbar');
      }
    });

    renderState();
  }
})();
