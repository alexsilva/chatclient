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

  bridge.onState(render);
  bridge.getState().then(render).catch(() => {});
})();
