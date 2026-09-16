(() => {
  const API_KEY = '__chatClientAppApprovals';
  const LEGACY_API_KEY = '__chatClientQuimeraAutoApprove';
  const VERSION = 1;
  // Política curinga: vale para todo app que não tem política própria.
  const CATCH_ALL_POLICY_ID = '*';
  const ALLOW_LABELS = new Set(['permitir', 'allow']);
  const PROMPT_PHRASES = ['permitir que', 'allow '];
  const MAX_CONTAINER_TEXT_LENGTH = 6000;
  const MAX_ANCESTOR_DEPTH = 14;
  const MAX_PROMPT_EXPANSION_DEPTH = 4;
  const DEFAULT_DELAY_MS = 3000;
  const MAX_DELAY_MS = 30000;
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
  const LOG_PREFIX = '[chatclient:approvals]';

  const previous = window[API_KEY];
  if (previous?.version === VERSION) {
    return;
  }

  // Uma versão anterior mantém seu próprio observer vivo nesta página; desligá-la
  // evita que as duas automações disputem o mesmo prompt de permissão.
  previous?.setEnabled?.(false);
  window[LEGACY_API_KEY]?.setEnabled?.(false);

  const state = {
    enabled: true,
    policies: [],
    processedButtons: new WeakSet(),
    approvalQueue: Promise.resolve()
  };

  // Log só no modo debug do ChatClient (execução a partir do código-fonte). O
  // processo principal define a flag antes de injetar este script; instalado ela
  // chega como false e nada é escrito no console da página.
  function log(method, ...args) {
    if (window.__chatClientDebug !== true) {
      return;
    }

    console[method](LOG_PREFIX, ...args);
  }

  function normalizeDelayMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_DELAY_MS;
    }
    return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(numeric)));
  }

  // Nomes de app são digitados pelo usuário e o prompt vem do ChatGPT: comparar
  // sem acento e sem caixa evita que "Quimerá"/"QUIMERA" deixem de casar.
  function foldText(value) {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function elementText(element) {
    return foldText(element.textContent || '');
  }

  function normalizePolicy(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
      return null;
    }

    const name = typeof raw.name === 'string' ? raw.name : raw.id;
    const catchAll = raw.id === CATCH_ALL_POLICY_ID;
    const match = catchAll ? '' : foldText(name);

    if (!catchAll && !match) {
      return null;
    }

    return {
      id: raw.id,
      name,
      match,
      catchAll,
      enabled: raw.enabled !== false,
      delayMs: normalizeDelayMs(raw.delayMs),
      scope: SCOPES.has(raw.scope) ? raw.scope : DEFAULT_SCOPE
    };
  }

  function findPolicy(policyId) {
    return state.policies.find((policy) => policy.id === policyId) || null;
  }

  function isDisabled(element) {
    return element.disabled === true || element.getAttribute('aria-disabled') === 'true';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isApprovalPrompt(text) {
    return (
      text.length <= MAX_CONTAINER_TEXT_LENGTH &&
      PROMPT_PHRASES.some((phrase) => text.includes(phrase))
    );
  }

  function containsSingleAllowButton(container) {
    let found = 0;

    for (const button of container.querySelectorAll(BUTTON_SELECTOR)) {
      if (ALLOW_LABELS.has(elementText(button)) && ++found > 1) {
        return false;
      }
    }

    return true;
  }

  // O app dono do prompt é identificado pelo nome no texto do balão de permissão;
  // sem política nomeada, o pedido cai no curinga (se o usuário o tiver ligado).
  function resolvePolicy(allowButton) {
    let container = allowButton;
    let promptDepth = -1;

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && container; depth += 1) {
      // Um ancestral que já engloba outro pedido mistura os dois textos e deixaria
      // a política de um app decidir pelo prompt do outro.
      if (container !== allowButton && !containsSingleAllowButton(container)) {
        break;
      }

      const text = elementText(container);

      if (isApprovalPrompt(text)) {
        if (promptDepth === -1) {
          promptDepth = depth;
        }

        const named = state.policies.find(
          (policy) => !policy.catchAll && text.includes(policy.match)
        );
        if (named) {
          return named;
        }
      }

      // O nome do app costuma estar no mesmo bloco do texto do pedido; alguns
      // níveis acima ainda são o balão, mais que isso já é a conversa em volta.
      if (promptDepth !== -1 && depth - promptDepth >= MAX_PROMPT_EXPANSION_DEPTH) {
        break;
      }

      container = container.parentElement;
    }

    return promptDepth !== -1
      ? state.policies.find((policy) => policy.catchAll) || null
      : null;
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
      const text = elementText(item);
      return CONVERSATION_OPTION_PATTERN.test(text) && !BROADER_SCOPE_PATTERN.test(text);
    }) || null;
  }

  async function approveForConversation(allowButton, policy) {
    const trigger = findScopeMenuTrigger(allowButton);
    if (!trigger) {
      return false;
    }

    openScopeMenu(trigger);
    const items = await waitForScopeMenuItems(trigger);

    if (items.length === 0) {
      log('warn', `${policy.name}: menu de escopo não abriu; aprovando apenas esta chamada`);
      return false;
    }

    const option = pickConversationOption(items);
    if (!option) {
      closeScopeMenu();
      log('warn', `${policy.name}: nenhuma opção de conversa reconhecida; aprovando apenas esta chamada`);
      return false;
    }

    log('info', `${policy.name}: aprovando para a conversa —`, elementText(option));
    option.click();
    return true;
  }

  function canApprove(candidate) {
    return state.enabled && candidate.isConnected && !isDisabled(candidate);
  }

  async function approve(candidate, policyId) {
    // A política é relida aqui: ela pode ter sido desligada ou removida enquanto
    // o atraso corria.
    const policy = findPolicy(policyId);
    if (!policy || !policy.enabled || !canApprove(candidate)) {
      return;
    }

    if (policy.scope === 'conversation' && (await approveForConversation(candidate, policy))) {
      return;
    }

    // O menu pode ter consumido o prompt ou a permissão pode ter sido resolvida
    // pelo usuário enquanto o escopo era negociado.
    if (!canApprove(candidate)) {
      return;
    }

    log('info', `${policy.name}: aprovando esta chamada`);
    candidate.click();
  }

  // Aprovações são serializadas: dois menus de escopo abertos ao mesmo tempo se
  // fechariam mutuamente.
  function enqueueApproval(candidate, policyId) {
    state.approvalQueue = state.approvalQueue
      .then(() => approve(candidate, policyId))
      .catch((error) => {
        log('warn', 'falha ao aprovar prompt:', error);
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

      if (!ALLOW_LABELS.has(elementText(candidate)) || isDisabled(candidate)) {
        continue;
      }

      const policy = resolvePolicy(candidate);
      if (!policy) {
        continue;
      }

      // Prompts sem aprovação automática ficam sem marca: se a política for
      // ligada com o pedido na tela, o próximo scan ainda o encontra.
      if (!policy.enabled) {
        continue;
      }

      state.processedButtons.add(candidate);
      setTimeout(() => enqueueApproval(candidate, policy.id), policy.delayMs);
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
    version: VERSION,
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      if (state.enabled) {
        scheduleScan();
      }
    },
    getEnabled() {
      return state.enabled;
    },
    setPolicies(policies) {
      state.policies = Array.isArray(policies)
        ? policies.map(normalizePolicy).filter(Boolean)
        : [];
      scheduleScan();
    },
    getPolicies() {
      return state.policies.map(({ id, name, enabled, delayMs, scope }) => ({
        id,
        name,
        enabled,
        delayMs,
        scope
      }));
    }
  };

  scheduleScan();
})();
