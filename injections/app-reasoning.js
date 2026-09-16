(() => {
  const API_KEY = '__chatClientAppReasoning';
  const API_VERSION = 6;
  // Posições do slider nativo de "Potência" do ChatGPT.
  // 0 troca para o modelo instantâneo (sem raciocínio); 1-3 são esforços do thinking.
  const LEVEL_POSITIONS = {
    low: 0,
    medium: 1,
    high: 2,
    'extra-high': 3
  };
  const HIDE_STYLE_ID = '__chatclient-reasoning-hide';

  if (window[API_KEY]?.version === API_VERSION) {
    return;
  }

  const state = {
    level: null,
    token: 0,
    queue: Promise.resolve(false)
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(getter, timeoutMs, stepMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = getter();
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        return null;
      }
      await sleep(stepMs);
    }
  }

  function firePointer(el, type) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1 }));
  }

  function fireKey(el, key) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  function findPill() {
    const form = document.querySelector('form[data-type="unified-composer"]');
    if (!form) {
      return null;
    }
    return form.querySelector('button.__composer-pill[aria-haspopup="menu"]') ||
      [...form.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => !b.dataset.testid) ||
      null;
  }

  function findSlider() {
    return document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]');
  }

  function hidePopperWhileAutomating() {
    if (document.getElementById(HIDE_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    style.textContent =
      '[data-radix-popper-content-wrapper]:has([data-model-reasoning-effort-slider]) { visibility: hidden !important; }';
    document.head.appendChild(style);
  }

  function unhidePopper() {
    document.getElementById(HIDE_STYLE_ID)?.remove();
  }

  async function applyLevel(level, token) {
    const target = LEVEL_POSITIONS[level];
    // Após dom-ready o React ainda está montando o composer.
    const pill = await waitFor(findPill, 20000, 500);
    if (!pill || token !== state.token) {
      return false;
    }

    const menuWasOpen = Boolean(findSlider());
    try {
      if (!menuWasOpen) {
        hidePopperWhileAutomating();
        firePointer(pill, 'pointerdown');
        firePointer(pill, 'pointerup');
        pill.click();
      }

      const slider = await waitFor(findSlider, 3000, 100);
      if (!slider || token !== state.token) {
        return false;
      }

      slider.focus();
      let current = Number(slider.getAttribute('aria-valuenow'));
      if (!Number.isFinite(current)) {
        // Leitura falhou: Home leva à posição 0 e o alvo vira um deslocamento absoluto.
        fireKey(slider, 'Home');
        await sleep(150);
        current = 0;
      }

      const key = target > current ? 'ArrowRight' : 'ArrowLeft';
      for (let i = 0; i < Math.abs(target - current); i++) {
        fireKey(slider, key);
        await sleep(120);
      }

      const applied = Number(slider.getAttribute('aria-valuenow')) === target;

      if (!menuWasOpen) {
        fireKey(slider, 'Escape');
        const closed = await waitFor(() => !findSlider(), 2000, 100);
        if (!closed) {
          firePointer(document.body, 'pointerdown');
          await waitFor(() => !findSlider(), 1000, 100);
        }
      }

      return applied;
    } finally {
      unhidePopper();
    }
  }

  window[API_KEY] = {
    version: API_VERSION,
    setLevel(level) {
      if (!(level in LEVEL_POSITIONS)) {
        return Promise.resolve(false);
      }

      state.level = level;
      const token = ++state.token;
      state.queue = state.queue
        .catch(() => false)
        .then(() => applyLevel(level, token))
        .catch(() => false);
      return state.queue;
    },
    getLevel() {
      return state.level;
    },
    getPillText() {
      return findPill()?.textContent?.trim() ?? null;
    }
  };
})();
