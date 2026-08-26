(() => {
  const API_KEY = '__chatClientQuimeraAutoApprove';
  const TOOL_NAME = 'quimera';
  const ALLOW_LABELS = new Set(['permitir', 'allow']);
  const PROMPT_PHRASES = ['permitir que', 'allow '];
  const MAX_CONTAINER_TEXT_LENGTH = 6000;
  const MAX_ANCESTOR_DEPTH = 14;
  const DEFAULT_CLICK_DELAY_MS = 3000;
  const MAX_CLICK_DELAY_MS = 30000;
  const SCAN_DEBOUNCE_MS = 500;
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const LOG_PREFIX = '[chatclient:quimera]';

  if (window[API_KEY]?.version === 2) {
    return;
  }

  const state = {
    enabled: true,
    delayMs: DEFAULT_CLICK_DELAY_MS,
    processedButtons: new WeakSet()
  };

  function normalizeDelayMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_CLICK_DELAY_MS;
    }
    return Math.min(MAX_CLICK_DELAY_MS, Math.max(0, Math.round(numeric)));
  }

  function normalizedText(element) {
    return (element.textContent || '').trim().toLowerCase();
  }

  function isDisabled(element) {
    return element.disabled === true || element.getAttribute('aria-disabled') === 'true';
  }

  function findQuimeraContainer(element) {
    let container = element;

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && container; depth += 1) {
      const text = normalizedText(container);
      const hasPromptPhrase = PROMPT_PHRASES.some((phrase) => text.includes(phrase));

      if (
        text.length <= MAX_CONTAINER_TEXT_LENGTH &&
        text.includes(TOOL_NAME) &&
        hasPromptPhrase
      ) {
        return container;
      }

      container = container.parentElement;
    }

    return null;
  }

  function scanAndApprove() {
    if (!state.enabled) {
      return;
    }

    for (const candidate of document.querySelectorAll(BUTTON_SELECTOR)) {
      if (state.processedButtons.has(candidate)) {
        continue;
      }

      if (!ALLOW_LABELS.has(normalizedText(candidate))) {
        continue;
      }

      if (!findQuimeraContainer(candidate) || isDisabled(candidate)) {
        continue;
      }

      state.processedButtons.add(candidate);
      const delayMs = state.delayMs;

      setTimeout(() => {
        if (!state.enabled || !candidate.isConnected || isDisabled(candidate)) {
          return;
        }

        console.info(LOG_PREFIX, 'aprovando prompt da Quimera');
        candidate.click();
      }, delayMs);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer !== null) {
      return;
    }

    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndApprove();
    }, SCAN_DEBOUNCE_MS);
  }

  function mutationsMayContainButton(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches(BUTTON_SELECTOR) || node.querySelector(BUTTON_SELECTOR)) {
            return true;
          }
          continue;
        }

        // Labels de botão podem chegar como text nodes inseridos depois do elemento.
        if (node.nodeType === Node.TEXT_NODE && node.parentElement?.closest(BUTTON_SELECTOR)) {
          return true;
        }
      }
    }

    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (!state.enabled || !mutationsMayContainButton(mutations)) {
      return;
    }

    scheduleScan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window[API_KEY] = {
    version: 2,
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      if (state.enabled) {
        scheduleScan();
      }
    },
    getEnabled() {
      return state.enabled;
    },
    setDelayMs(delayMs) {
      state.delayMs = normalizeDelayMs(delayMs);
    },
    getDelayMs() {
      return state.delayMs;
    }
  };

  scheduleScan();
})();
