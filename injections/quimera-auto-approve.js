(() => {
  const API_KEY = '__chatClientQuimeraAutoApprove';
  const TOOL_NAME = 'quimera';
  const ALLOW_LABELS = new Set(['permitir', 'allow']);
  const PROMPT_PHRASES = ['permitir que', 'allow '];
  const MAX_CONTAINER_TEXT_LENGTH = 6000;
  const MAX_ANCESTOR_DEPTH = 14;
  const CLICK_DELAY_MIN_MS = 400;
  const CLICK_DELAY_MAX_MS = 900;
  const LOG_PREFIX = '[chatclient:quimera]';

  if (window[API_KEY]?.version === 1) {
    return;
  }

  const state = {
    enabled: true,
    processedButtons: new WeakSet()
  };

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

    for (const candidate of document.querySelectorAll('button, [role="button"]')) {
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
      const delayMs = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);

      setTimeout(() => {
        if (!state.enabled || !candidate.isConnected || isDisabled(candidate)) {
          return;
        }

        console.info(LOG_PREFIX, 'aprovando prompt da Quimera');
        candidate.click();
      }, delayMs);
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanAndApprove();
    });
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window[API_KEY] = {
    version: 1,
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      if (state.enabled) {
        scheduleScan();
      }
    },
    getEnabled() {
      return state.enabled;
    }
  };

  scheduleScan();
})();
