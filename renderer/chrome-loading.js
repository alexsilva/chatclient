(() => {
  const bridge = window.chatClient;
  const label = document.getElementById('loadingLabel');
  const errorBox = document.getElementById('loadingError');
  const retryButton = document.getElementById('retryButton');

  function render(state) {
    const items = state?.items || [];
    if (!items.length) {
      return;
    }

    const failed = items.filter((item) => item.error);
    const loading = items.filter((item) => item.loading);
    const names = (loading.length ? loading : items)
      .map((item) => item.label)
      .join(' e ');

    if (failed.length && !loading.length) {
      label.textContent = `Falha ao carregar ${failed.map((i) => i.label).join(' e ')}`;
      errorBox.textContent = failed[0].error || '';
      errorBox.hidden = false;
      retryButton.hidden = false;
      document.body.classList.add('failed');
      return;
    }

    label.textContent = `Carregando ${names}…`;
    errorBox.hidden = true;
    retryButton.hidden = true;
    document.body.classList.remove('failed');
  }

  retryButton.addEventListener('click', () => {
    bridge.refresh().catch(() => {});
  });

  bridge.onLoadingState(render);
})();
