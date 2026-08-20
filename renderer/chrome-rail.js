(() => {
  const bridge = window.chatClient;
  const buttons = [...document.querySelectorAll('[data-mode]')];
  const settingsButton = document.getElementById('settingsButton');

  function render(state) {
    for (const button of buttons) {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const result = await bridge.setMode(button.dataset.mode).catch(() => null);
      if (result) {
        render(result);
      }
    });
  }

  settingsButton.addEventListener('click', () => {
    bridge.openSettings().catch(() => {});
  });

  function renderChrome(state) {
    document.body.classList.toggle('collapsed', !state.railVisible);
  }

  // Recolhida, a view inteira é a alça: qualquer hover pede o reveal.
  let lastRevealAt = 0;
  document.addEventListener('pointermove', () => {
    const now = Date.now();
    if (document.body.classList.contains('collapsed') && now - lastRevealAt > 150) {
      lastRevealAt = now;
      bridge.revealChrome('rail').catch(() => {});
    }
  });

  bridge.onState(render);
  bridge.onChromeState(renderChrome);
  bridge.getState().then((state) => {
    render(state);
    renderChrome(state);
  }).catch(() => {});
})();
