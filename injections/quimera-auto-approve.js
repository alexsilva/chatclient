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
  const MENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"]';
  const MENU_ITEM_SELECTOR = '[role="menuitem"]';
  const MENU_OPEN_TIMEOUT_MS = 1500;
  const MENU_POLL_INTERVAL_MS = 50;
  const SCOPES = new Set(['once', 'conversation']);
  const DEFAULT_SCOPE = 'once';
  // Os rótulos do menu vêm do backend do ChatGPT (e seguem o idioma da conta),
  // então o escopo é reconhecido por padrão de texto em vez de string fixa.
  const CONVERSATION_OPTION_PATTERN = /convers|sess[ãa]o|session|(this|neste|este) chat/i;
  const BROADER_SCOPE_PATTERN = /\ball\b|todas|todos|sempre|always|qualquer|every/i;
  const LOG_PREFIX = '[chatclient:quimera]';

  const previous = window[API_KEY];
  if (previous?.version === 3) {
    return;
  }

  // Uma versão anterior mantém seu próprio observer vivo nesta página; desligá-la
  // evita que as duas automações disputem o mesmo prompt de permissão.
  previous?.setEnabled?.(false);

  const state = {
    enabled: true,
    delayMs: DEFAULT_CLICK_DELAY_MS,
    scope: DEFAULT_SCOPE,
    processedButtons: new WeakSet(),
    approvalQueue: Promise.resolve()
  };

  function normalizeDelayMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_CLICK_DELAY_MS;
    }
    return Math.min(MAX_CLICK_DELAY_MS, Math.max(0, Math.round(numeric)));
  }

  function normalizeScope(value) {
    return SCOPES.has(value) ? value : DEFAULT_SCOPE;
  }

  function normalizedText(element) {
    return (element.textContent || '').trim().toLowerCase();
  }

  function isDisabled(element) {
    return element.disabled === true || element.getAttribute('aria-disabled') === 'true';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  // O ChatGPT troca o botão "Permitir" por um split button quando a ação traz
  // opções extras: o irmão imediato é a seta que abre o menu de escopo.
  function findScopeMenuTrigger(allowButton) {
    const wrapper = allowButton.parentElement;
    if (!wrapper) {
      return null;
    }

    for (const sibling of wrapper.children) {
      if (sibling !== allowButton && sibling.matches(MENU_TRIGGER_SELECTOR) && !isDisabled(sibling)) {
        return sibling;
      }
    }

    return null;
  }

  function pointerEventInit(buttons) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };
  }

  function openScopeMenu(trigger) {
    // Triggers do Radix abrem no pointerdown, e não no click sintético.
    trigger.dispatchEvent(new PointerEvent('pointerdown', pointerEventInit(1)));
    trigger.dispatchEvent(new PointerEvent('pointerup', pointerEventInit(0)));
  }

  function closeScopeMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  function getScopeMenuItems(trigger) {
    const menuId = trigger.getAttribute('aria-controls');
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!menu) {
      return [];
    }

    return [...menu.querySelectorAll(MENU_ITEM_SELECTOR)].filter((item) => !isDisabled(item));
  }

  async function waitForScopeMenuItems(trigger) {
    const deadline = Date.now() + MENU_OPEN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const items = getScopeMenuItems(trigger);
      if (items.length > 0) {
        return items;
      }
      await sleep(MENU_POLL_INTERVAL_MS);
    }

    return [];
  }

  // Sem correspondência explícita a conversa/sessão o menu é descartado: aprovar
  // uma opção desconhecida poderia conceder um escopo mais amplo que o pedido.
  function pickConversationOption(items) {
    return items.find((item) => {
      const text = normalizedText(item);
      return CONVERSATION_OPTION_PATTERN.test(text) && !BROADER_SCOPE_PATTERN.test(text);
    }) || null;
  }

  async function approveForConversation(allowButton) {
    const trigger = findScopeMenuTrigger(allowButton);
    if (!trigger) {
      return false;
    }

    openScopeMenu(trigger);
    const items = await waitForScopeMenuItems(trigger);

    if (items.length === 0) {
      console.warn(LOG_PREFIX, 'menu de escopo não abriu; aprovando apenas esta chamada');
      return false;
    }

    const option = pickConversationOption(items);
    if (!option) {
      closeScopeMenu();
      console.warn(LOG_PREFIX, 'nenhuma opção de conversa reconhecida; aprovando apenas esta chamada');
      return false;
    }

    console.info(LOG_PREFIX, 'aprovando para a conversa:', normalizedText(option));
    option.click();
    return true;
  }

  function canApprove(candidate) {
    return state.enabled && candidate.isConnected && !isDisabled(candidate);
  }

  async function approve(candidate) {
    if (!canApprove(candidate)) {
      return;
    }

    if (state.scope === 'conversation' && (await approveForConversation(candidate))) {
      return;
    }

    // O menu pode ter consumido o prompt ou a permissão pode ter sido resolvida
    // pelo usuário enquanto o escopo era negociado.
    if (!canApprove(candidate)) {
      return;
    }

    console.info(LOG_PREFIX, 'aprovando prompt da Quimera');
    candidate.click();
  }

  // Aprovações são serializadas: dois menus de escopo abertos ao mesmo tempo se
  // fechariam mutuamente.
  function enqueueApproval(candidate) {
    state.approvalQueue = state.approvalQueue
      .then(() => approve(candidate))
      .catch((error) => {
        console.warn(LOG_PREFIX, 'falha ao aprovar prompt:', error);
      });
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
      setTimeout(() => enqueueApproval(candidate), state.delayMs);
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
    version: 3,
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
    },
    setScope(scope) {
      state.scope = normalizeScope(scope);
    },
    getScope() {
      return state.scope;
    }
  };

  scheduleScan();
})();
