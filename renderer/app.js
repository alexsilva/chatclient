(() => {
  const bridge = window.chatClient;
  const isElectron = Boolean(bridge);

  const railButtons = [...document.querySelectorAll('[data-mode]')];
  const modeLabel = document.getElementById('modeLabel');
  const contentFrame = document.getElementById('contentFrame');
  const compareHeader = document.getElementById('compareHeader');
  const compareDivider = document.getElementById('compareDivider');
  const refreshButton = document.getElementById('refreshButton');
  const approvalsButton = document.getElementById('approvalsButton');
  const approvalsSwitch = document.getElementById('approvalsSwitch');
  const policySection = document.getElementById('policySection');
  const policyList = document.getElementById('policyList');
  const policyForm = document.getElementById('policyForm');
  const policyNameInput = document.getElementById('policyNameInput');
  const appReasoningSelect = document.getElementById('appReasoningSelect');
  const restoreWorkspaceSwitch = document.getElementById('restoreWorkspaceSwitch');
  const settingsButton = document.getElementById('settingsButton');
  const settingsPanel = document.getElementById('settingsPanel');
  const closeSettingsButton = document.getElementById('closeSettingsButton');
  const toast = document.getElementById('toast');

  const CATCH_ALL_POLICY_ID = '*';
  const CATCH_ALL_POLICY_HINT =
    'Vale para todo app que peça permissão e não tenha política própria — inclusive os que você ainda não cadastrou.';

  const state = {
    mode: 'chatgpt',
    splitRatio: 0.5,
    appApprovalsEnabled: true,
    appApprovalPolicies: [
      { id: 'quimera', name: 'Quimera', enabled: true, delayMs: 3000, scope: 'once' },
      { id: CATCH_ALL_POLICY_ID, name: 'Outros apps', enabled: false, delayMs: 3000, scope: 'once' }
    ],
    appReasoningLevel: 'high',
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

  const policyElements = new Map();

  function createPolicyElement(policy) {
    const isCatchAll = policy.id === CATCH_ALL_POLICY_ID;
    const element = document.createElement('article');
    element.className = 'policy-item';
    element.dataset.policyId = policy.id;
    element.innerHTML = `
      <div class="policy-head">
        <strong class="policy-name"></strong>
        <button class="switch" type="button" role="switch" data-action="toggle"><span></span></button>
        <button class="policy-remove" type="button" data-action="remove" title="Remover app">×</button>
      </div>
      <p class="policy-hint"></p>
      <div class="policy-controls">
        <label class="policy-field">
          <span>Atraso</span>
          <span class="setting-number-control">
            <input class="setting-number" type="number" min="0" max="30" step="0.5" data-action="delay">
            <span>s</span>
          </span>
        </label>
        <label class="policy-field">
          <span>Escopo</span>
          <select class="setting-select" data-action="scope">
            <option value="once">Somente esta chamada</option>
            <option value="conversation">Toda a conversa</option>
          </select>
        </label>
      </div>
    `;

    const hint = element.querySelector('.policy-hint');
    hint.hidden = !isCatchAll;
    hint.textContent = isCatchAll ? CATCH_ALL_POLICY_HINT : '';
    // O curinga não é um app cadastrado: não há o que remover.
    element.querySelector('[data-action="remove"]').hidden = isCatchAll;

    return element;
  }

  function updatePolicyElement(element, policy) {
    const toggle = element.querySelector('[data-action="toggle"]');
    const delayInput = element.querySelector('[data-action="delay"]');
    const scopeSelect = element.querySelector('[data-action="scope"]');

    element.classList.toggle('off', !policy.enabled);
    element.querySelector('.policy-name').textContent = policy.name;
    toggle.classList.toggle('active', policy.enabled);
    toggle.setAttribute('aria-checked', String(policy.enabled));
    toggle.setAttribute('aria-label', `Aprovar ${policy.name} automaticamente`);
    element.querySelector('[data-action="remove"]').setAttribute('aria-label', `Remover ${policy.name}`);

    if (document.activeElement !== delayInput) {
      delayInput.value = String(policy.delayMs / 1000);
    }

    if (document.activeElement !== scopeSelect) {
      scopeSelect.value = policy.scope;
    }
  }

  // Os nós são reaproveitados entre renders: recriar a lista a cada evento de
  // estado tiraria o foco de quem estivesse editando um atraso ou um escopo.
  function renderPolicies() {
    state.appApprovalPolicies.forEach((policy, index) => {
      let element = policyElements.get(policy.id);

      if (!element) {
        element = createPolicyElement(policy);
        policyElements.set(policy.id, element);
      }

      updatePolicyElement(element, policy);

      if (policyList.children[index] !== element) {
        policyList.insertBefore(element, policyList.children[index] || null);
      }
    });

    const ids = new Set(state.appApprovalPolicies.map((policy) => policy.id));
    for (const [id, element] of policyElements) {
      if (!ids.has(id)) {
        element.remove();
        policyElements.delete(id);
      }
    }
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

    approvalsButton.classList.toggle('active', state.appApprovalsEnabled);
    approvalsButton.setAttribute('aria-pressed', String(state.appApprovalsEnabled));
    approvalsButton.title = state.appApprovalsEnabled
      ? 'Aprovação automática de apps: ativada'
      : 'Aprovação automática de apps: desativada';

    approvalsSwitch.classList.toggle('active', state.appApprovalsEnabled);
    approvalsSwitch.setAttribute('aria-checked', String(state.appApprovalsEnabled));
    policySection.classList.toggle('inactive', !state.appApprovalsEnabled);
    renderPolicies();

    if (document.activeElement !== appReasoningSelect) {
      appReasoningSelect.value = state.appReasoningLevel;
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

  async function setApprovalsEnabled(enabled) {
    state.appApprovalsEnabled = Boolean(enabled);
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      Object.assign(state, await bridge.setAppApprovalsEnabled(state.appApprovalsEnabled));
      renderState();
    } catch {
      showToast('Não foi possível atualizar a aprovação automática.');
    }
  }

  function secondsToDelayMs(seconds) {
    const numeric = Number(seconds);
    const normalized = Number.isFinite(numeric) ? Math.min(30, Math.max(0, numeric)) : 3;
    return Math.round(normalized * 1000);
  }

  async function updatePolicy(id, patch) {
    const previousPolicies = state.appApprovalPolicies;
    if (!previousPolicies.some((policy) => policy.id === id)) {
      return;
    }

    state.appApprovalPolicies = previousPolicies.map((policy) =>
      policy.id === id ? { ...policy, ...patch } : policy
    );
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      Object.assign(state, await bridge.updateAppApprovalPolicy(id, patch));
      renderState();
    } catch {
      state.appApprovalPolicies = previousPolicies;
      renderState();
      showToast('Não foi possível atualizar a política do app.');
    }
  }

  async function addPolicy(name) {
    const appName = name.trim();
    if (!appName) {
      return;
    }

    // Mesma comparação do processo principal, para avisar aqui em vez de deixar
    // o IPC recusar com uma mensagem genérica.
    const foldName = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const previousPolicies = state.appApprovalPolicies;
    const duplicated = previousPolicies.some(
      (policy) => policy.id !== CATCH_ALL_POLICY_ID && foldName(policy.name) === foldName(appName)
    );

    if (duplicated) {
      showToast(`${appName} já tem uma política.`);
      return;
    }

    // O id definitivo vem do processo principal; até lá o item aparece com um
    // provisório para a lista não piscar.
    const optimistic = { id: `pending:${appName}`, name: appName, enabled: true, delayMs: 3000, scope: 'once' };
    state.appApprovalPolicies = [
      ...previousPolicies.filter((policy) => policy.id !== CATCH_ALL_POLICY_ID),
      optimistic,
      ...previousPolicies.filter((policy) => policy.id === CATCH_ALL_POLICY_ID)
    ];
    policyNameInput.value = '';
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      Object.assign(state, await bridge.addAppApprovalPolicy(appName));
      renderState();
    } catch {
      state.appApprovalPolicies = previousPolicies;
      renderState();
      showToast('Não foi possível adicionar o app.');
    }
  }

  async function removePolicy(id) {
    const previousPolicies = state.appApprovalPolicies;
    state.appApprovalPolicies = previousPolicies.filter((policy) => policy.id !== id);
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      Object.assign(state, await bridge.removeAppApprovalPolicy(id));
      renderState();
    } catch {
      state.appApprovalPolicies = previousPolicies;
      renderState();
      showToast('Não foi possível remover o app.');
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

  async function setAppReasoningLevel(level) {
    if (!['low', 'medium', 'high', 'extra-high'].includes(level)) {
      return;
    }

    const previousLevel = state.appReasoningLevel;
    state.appReasoningLevel = level;
    renderState();

    if (!isElectron) {
      return;
    }

    try {
      const result = await bridge.setAppReasoningLevel(level);
      state.appReasoningLevel = result.level;
      renderState();
    } catch {
      state.appReasoningLevel = previousLevel;
      renderState();
      showToast('Não foi possível atualizar o raciocínio do ChatGPT.');
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

  approvalsButton.addEventListener('click', () => {
    setApprovalsEnabled(!state.appApprovalsEnabled);
  });

  approvalsSwitch.addEventListener('click', () => {
    setApprovalsEnabled(!state.appApprovalsEnabled);
  });

  // Delegação: os itens da lista são criados e descartados conforme as políticas.
  policyList.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    const id = control?.closest('.policy-item')?.dataset.policyId;
    if (!id) {
      return;
    }

    if (control.dataset.action === 'toggle') {
      const policy = state.appApprovalPolicies.find((item) => item.id === id);
      updatePolicy(id, { enabled: !policy?.enabled });
    } else if (control.dataset.action === 'remove') {
      removePolicy(id);
    }
  });

  policyList.addEventListener('change', (event) => {
    const control = event.target.closest('[data-action]');
    const id = control?.closest('.policy-item')?.dataset.policyId;
    if (!id) {
      return;
    }

    if (control.dataset.action === 'delay') {
      updatePolicy(id, { delayMs: secondsToDelayMs(control.value) });
    } else if (control.dataset.action === 'scope') {
      updatePolicy(id, { scope: control.value });
    }
  });

  policyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addPolicy(policyNameInput.value);
  });

  appReasoningSelect.addEventListener('change', () => {
    setAppReasoningLevel(appReasoningSelect.value);
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
