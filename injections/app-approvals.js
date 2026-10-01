(() => {
  const API_KEY = '__chatClientAppApprovals';
  const LEGACY_API_KEY = '__chatClientQuimeraAutoApprove';
  const VERSION = 3;
  // Política curinga: vale para todo app que não tem política própria.
  const CATCH_ALL_POLICY_ID = '*';
  // O botão que aprova a chamada diz "Permitir" no modal antigo e "Permitir uma
  // vez" no card atual (approvalRequestCard); em inglês, "Allow" / "Allow once".
  // Variantes do card trocam o rótulo ("Permitir nesta conversa"), por isso só o
  // prefixo é fixo.
  const ALLOW_LABEL_PATTERN = /^(permitir|allow)\b/;
  // Rótulos de aprovação exatos para uma única chamada: desempatam quando o
  // card traz mais de um botão "Permitir ...".
  const ONCE_LABEL_PATTERN = /^(permitir|allow)( uma vez| once)?$/;
  // O botão que recusa diz "Cancelar" no modal antigo e "Negar" no card atual.
  const DENY_LABEL_PATTERN = /^(cancelar|cancel|negar|deny|recusar|decline)\b/;
  const PROMPT_PHRASES = [
    'permitir que',
    'allow ',
    ' quer ',
    ' wants ',
    ' gostaria ',
    ' would like '
  ];
  // O card atual marca a própria raiz; é o ancestral mais confiável para achar
  // o texto do pedido (nome do app) e os botões irmãos.
  const APPROVAL_CARD_SELECTOR = '[data-codex-approval-surface]';
  const MAX_CONTAINER_TEXT_LENGTH = 6000;
  const MAX_ANCESTOR_DEPTH = 14;
  const MAX_PROMPT_EXPANSION_DEPTH = 4;
  const DEFAULT_DELAY_MS = 3000;
  const MAX_DELAY_MS = 30000;
  const SCAN_DEBOUNCE_MS = 500;
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const MENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"]';
  const MENU_SELECTOR = '[role="menu"]';
  const MENU_ITEM_SELECTOR = '[role="menuitem"]';
  const MENU_OPEN_TIMEOUT_MS = 1500;
  const MENU_POLL_INTERVAL_MS = 50;
  const SCOPES = new Set(['once', 'conversation']);
  const DEFAULT_SCOPE = 'once';
  // Os rótulos do menu vêm do backend do ChatGPT (e seguem o idioma da conta),
  // então o escopo é reconhecido por padrão de texto em vez de string fixa.
  const CONVERSATION_OPTION_PATTERN = /convers|sess[ãa]o|session|(this|neste|este) chat/i;
  // Escopos mais amplos que "esta conversa": nunca são escolhidos nem clicados
  // no lugar de "Permitir uma vez" (ex.: "Permitir sempre", "Allow low-risk tools").
  const BROADER_SCOPE_PATTERN = /\ball\b|todas|todos|sempre|always|qualquer|every|baixo risco|low[- ]risk/i;
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

  // Rótulo visível do botão. O card atual embute a dica de atalho no botão
  // (<kbd aria-hidden>⏎</kbd> em "Permitir uma vez", "Esc" em "Negar"); ela não
  // faz parte do rótulo e entraria no textContent.
  function buttonLabel(button) {
    const walker = document.createTreeWalker(
      button,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            return node.tagName === 'KBD' || node.getAttribute('aria-hidden') === 'true'
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let text = '';
    while (walker.nextNode()) {
      text += walker.currentNode.nodeValue;
    }

    return foldText(text).replace(/\s+/g, ' ');
  }

  function isAllowButton(button) {
    const label = buttonLabel(button);
    return ALLOW_LABEL_PATTERN.test(label) && !BROADER_SCOPE_PATTERN.test(label);
  }

  function isDenyButton(button) {
    return DENY_LABEL_PATTERN.test(buttonLabel(button));
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
    return (
      element.disabled === true ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.hasAttribute('data-disabled')
    );
  }

  function isVisible(element) {
    return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
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

  function hasDenyButton(container, except) {
    for (const button of container.querySelectorAll(BUTTON_SELECTOR)) {
      if (button !== except && isDenyButton(button)) {
        return true;
      }
    }
    return false;
  }

  function isPermissionContainer(container, allowButton, text) {
    if (text.length > MAX_CONTAINER_TEXT_LENGTH) {
      return false;
    }

    // Um modal com ações Cancelar / Permitir e texto como “<app> quer ...” não
    // traz a frase “Permitir que ...”; o card atual traz as duas coisas. A dupla
    // de ações evita tratar qualquer botão “Permitir” da página como prompt de
    // permissão.
    return (
      container.matches(APPROVAL_CARD_SELECTOR) ||
      isApprovalPrompt(text) ||
      hasDenyButton(container, allowButton)
    );
  }

  function allowButtonsIn(container) {
    return [...container.querySelectorAll(BUTTON_SELECTOR)].filter(isAllowButton);
  }

  function containsSingleAllowButton(container) {
    return allowButtonsIn(container).length <= 1;
  }

  // Opções extras do backend viram botões "Permitir ..." ao lado do principal.
  // Só o principal ("Permitir uma vez") é clicado; com dois candidatos iguais o
  // card fica para o usuário.
  function isPrimaryAllowButton(button, card) {
    const allowButtons = allowButtonsIn(card);
    if (allowButtons.length === 1) {
      return allowButtons[0] === button;
    }

    const once = allowButtons.filter((candidate) => ONCE_LABEL_PATTERN.test(buttonLabel(candidate)));
    return once.length === 1 && once[0] === button;
  }

  function matchPolicy(text) {
    if (text.length > MAX_CONTAINER_TEXT_LENGTH) {
      return null;
    }

    return (
      state.policies.find((policy) => !policy.catchAll && text.includes(policy.match)) ||
      state.policies.find((policy) => policy.catchAll) ||
      null
    );
  }

  // O app dono do prompt é identificado pelo nome no texto do balão de permissão;
  // sem política nomeada, o pedido cai no curinga (se o usuário o tiver ligado).
  function resolvePolicy(allowButton) {
    const card = allowButton.closest(APPROVAL_CARD_SELECTOR);
    if (card) {
      return isPrimaryAllowButton(allowButton, card) ? matchPolicy(elementText(card)) : null;
    }

    let container = allowButton;
    let promptDepth = -1;

    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && container; depth += 1) {
      // Um ancestral que já engloba outro pedido mistura os dois textos e deixaria
      // a política de um app decidir pelo prompt do outro.
      if (container !== allowButton && !containsSingleAllowButton(container)) {
        break;
      }

      const text = elementText(container);

      if (isPermissionContainer(container, allowButton, text)) {
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

  // O ChatGPT troca o botão de aprovar por um split button quando a ação traz
  // opções extras: a seta ao lado (um botão só de ícone, sem texto) abre o menu
  // de escopo. Um tooltip pode envolver o botão principal, por isso o irmão é
  // procurado também um nível acima.
  function findScopeMenuTrigger(allowButton) {
    const scopes = [allowButton.parentElement, allowButton.parentElement?.parentElement];

    for (const scope of scopes) {
      if (!scope) {
        continue;
      }

      for (const button of scope.querySelectorAll(MENU_TRIGGER_SELECTOR)) {
        if (
          button !== allowButton &&
          !allowButton.contains(button) &&
          !isDisabled(button) &&
          buttonLabel(button) === ''
        ) {
          return button;
        }
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

  function pressPointer(target) {
    target.dispatchEvent(new PointerEvent('pointerdown', pointerEventInit(1)));
    target.dispatchEvent(new PointerEvent('pointerup', pointerEventInit(0)));
  }

  function isMenuOpen(trigger) {
    return (
      trigger.getAttribute('aria-expanded') === 'true' ||
      trigger.getAttribute('data-state') === 'open'
    );
  }

  function getScopeMenuItems(trigger) {
    const menuId = trigger.getAttribute('aria-controls');
    let menu = menuId ? document.getElementById(menuId) : null;

    if (!menu && isMenuOpen(trigger)) {
      // Sem aria-controls, o menu visível aberto por último é o do trigger.
      menu = [...document.querySelectorAll(MENU_SELECTOR)].filter(isVisible).at(-1) || null;
    }

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

  async function openScopeMenu(trigger) {
    // Triggers do Radix abrem no pointerdown, e não no click sintético; o click
    // fica como reserva para um trigger que só reaja a ele.
    pressPointer(trigger);
    let items = await waitForScopeMenuItems(trigger);

    if (items.length === 0 && !isMenuOpen(trigger)) {
      trigger.click();
      items = await waitForScopeMenuItems(trigger);
    }

    return items;
  }

  // Escape está fora de cogitação: o card atual usa Esc como atalho de "Negar" e
  // trataria o evento sintético como recusa. Um novo pointerdown no trigger
  // alterna o menu para fechado; um fora dele é a reserva.
  async function closeScopeMenu(trigger) {
    if (!isMenuOpen(trigger)) {
      return;
    }

    pressPointer(trigger);
    await sleep(MENU_POLL_INTERVAL_MS);

    if (isMenuOpen(trigger)) {
      pressPointer(document.body);
    }
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

    const items = await openScopeMenu(trigger);

    if (items.length === 0) {
      log('warn', `${policy.name}: menu de escopo não abriu; aprovando apenas esta chamada`);
      await closeScopeMenu(trigger);
      return false;
    }

    const option = pickConversationOption(items);
    if (!option) {
      log('warn', `${policy.name}: nenhuma opção de conversa reconhecida; aprovando apenas esta chamada`);
      await closeScopeMenu(trigger);
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

    log('info', `${policy.name}: aprovando esta chamada —`, buttonLabel(candidate));
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

      if (!isAllowButton(candidate) || isDisabled(candidate)) {
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
