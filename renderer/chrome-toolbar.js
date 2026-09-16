(() => {
  const bridge = window.chatClient;
  const modeLabel = document.getElementById('modeLabel');
  const approvalsButton = document.getElementById('approvalsButton');
  const refreshButton = document.getElementById('refreshButton');
  let currentState = {
    mode: 'chatgpt',
    appApprovalsEnabled: true
  };

  function render(state) {
    currentState = { ...currentState, ...state };
    const labels = {
      chatgpt: 'ChatGPT',
      grok: 'Grok',
      compare: 'Comparar'
    };
    modeLabel.textContent = labels[currentState.mode] || 'ChatGPT';
    approvalsButton.classList.toggle('active', currentState.appApprovalsEnabled);
    approvalsButton.setAttribute('aria-pressed', String(currentState.appApprovalsEnabled));
  }

  approvalsButton.addEventListener('click', async () => {
    const result = await bridge
      .setAppApprovalsEnabled(!currentState.appApprovalsEnabled)
      .catch(() => null);
    if (result) {
      render(result);
    }
  });

  refreshButton.addEventListener('click', async () => {
    refreshButton.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 360, easing: 'ease-out' }
    );
    await bridge.refresh().catch(() => {});
  });

  function renderChrome(state) {
    document.body.classList.toggle('collapsed', !state.toolbarVisible);
  }

  // Recolhida, a view inteira é a alça: qualquer hover pede o reveal.
  let lastRevealAt = 0;
  document.addEventListener('pointermove', () => {
    const now = Date.now();
    if (document.body.classList.contains('collapsed') && now - lastRevealAt > 150) {
      lastRevealAt = now;
      bridge.revealChrome('toolbar').catch(() => {});
    }
  });

  bridge.onState(render);
  bridge.onChromeState(renderChrome);
  bridge.getState().then((state) => {
    render(state);
    renderChrome(state);
  }).catch(() => {});
})();
