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

  bridge.onState(render);
  bridge.getState().then(render).catch(() => {});
})();
