(() => {
  const bridge = window.chatClient;
  const modeLabel = document.getElementById('modeLabel');
  const quimeraButton = document.getElementById('quimeraButton');
  const refreshButton = document.getElementById('refreshButton');
  let currentState = {
    mode: 'chatgpt',
    quimeraAutoApproveEnabled: true
  };

  function render(state) {
    currentState = { ...currentState, ...state };
    const labels = {
      chatgpt: 'ChatGPT',
      grok: 'Grok',
      compare: 'Comparar'
    };
    modeLabel.textContent = labels[currentState.mode] || 'ChatGPT';
    quimeraButton.classList.toggle('active', currentState.quimeraAutoApproveEnabled);
    quimeraButton.setAttribute('aria-pressed', String(currentState.quimeraAutoApproveEnabled));
  }

  quimeraButton.addEventListener('click', async () => {
    const result = await bridge
      .setQuimeraAutoApprove(!currentState.quimeraAutoApproveEnabled)
      .catch(() => null);
    if (result) {
      render({ quimeraAutoApproveEnabled: result.enabled });
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
