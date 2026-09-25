(() => {
  const API_KEY = '__chatClientAppReasoning';
  const API_VERSION = 7;
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

  function debugLog(message) {
    if (window.__chatClientDebug === true) {
      console.info('[chatclient:reasoning]', message);
    }
  }

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

  function isVisible(el) {
    return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function firePointer(el, type, buttons) {
    const EventClass = window.PointerEvent || window.MouseEvent;
    el.dispatchEvent(new EventClass(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    }));
  }

  function fireKey(el, key) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  function findPill() {
    const buttons = [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVisible);
    const semantic = buttons.find((button) => {
      const label = button.getAttribute('aria-label') || '';
      const text = button.textContent || '';
      return (
        /selecionar modelo do chatgpt|select chatgpt model/i.test(label) ||
        /esforço de raciocínio|reasoning effort/i.test(text)
      );
    });
    if (semantic) {
      return semantic;
    }

    const form = document.querySelector('form[data-type="unified-composer"]');
    if (!form) {
      return null;
    }
    return form.querySelector('button.__composer-pill[aria-haspopup="menu"]') ||
      [...form.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => !b.dataset.testid) ||
      null;
  }

  function findSlider(pill = null) {
    const menuId = pill?.getAttribute('aria-controls');
    const owned = menuId
      ? document.getElementById(menuId)?.querySelector('[role="slider"][aria-valuenow]')
      : null;
    if (owned && isVisible(owned)) {
      return owned;
    }

    return [...document.querySelectorAll('[role="slider"][aria-valuenow]')]
      .filter(isVisible)
      .at(-1) || null;
  }

  function effortSurfaceOpen(pill) {
    return (
      pill?.getAttribute('aria-expanded') === 'true' ||
      pill?.getAttribute('data-state') === 'open' ||
      Boolean(findSlider(pill))
    );
  }

  function hidePopperWhileAutomating() {
    if (document.getElementById(HIDE_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    style.textContent =
      '[data-radix-popper-content-wrapper]:has([role="slider"][aria-valuenow]) {' +
      ' visibility: hidden !important; }';
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

    const menuWasOpen = effortSurfaceOpen(pill);
    try {
      if (!menuWasOpen) {
        hidePopperWhileAutomating();
        pill.click();
        let opened = await waitFor(() => effortSurfaceOpen(pill), 1500, 50);
        if (!opened) {
          firePointer(pill, 'pointerdown', 1);
          opened = await waitFor(() => effortSurfaceOpen(pill), 1500, 50);
        }
        if (!opened) {
          return false;
        }
      }

      const slider = await waitFor(() => findSlider(pill), 3000, 100);
      if (!slider || token !== state.token) {
        return false;
      }

      let current = Number(slider.getAttribute('aria-valuenow'));
      if (!Number.isFinite(current)) {
        return false;
      }
      const initial = current;

      const control = slider.closest('[role="menuitem"]') || slider;
      for (let attempts = 0; attempts < 5 && current !== target; attempts += 1) {
        control.focus();
        fireKey(control, target > current ? 'ArrowRight' : 'ArrowLeft');

        const previous = current;
        const changed = await waitFor(() => {
          const next = Number(findSlider(pill)?.getAttribute('aria-valuenow'));
          return Number.isFinite(next) && next !== previous ? next : null;
        }, 1000, 40);

        if (changed === null) {
          return false;
        }
        current = changed;
      }

      const applied = current === target;
      if (applied) {
        debugLog(`aplicado ${initial} -> ${current} (${level})`);
      }

      if (!menuWasOpen) {
        fireKey(pill, 'Escape');
        const closed = await waitFor(() => !effortSurfaceOpen(pill), 2000, 100);
        if (!closed) {
          firePointer(document.body, 'pointerdown', 1);
          firePointer(document.body, 'pointerup', 0);
          await waitFor(() => !effortSurfaceOpen(pill), 1000, 100);
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
