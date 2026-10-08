(() => {
  const API_KEY = '__chatClientAppServer';
  const TAP_KEY = '__chatClientAppServerTap';
  const VERSION = 11;
  if (window[API_KEY]?.version === VERSION) {
    return;
  }

  // Só há estado do pedido em andamento. A conversa e seu histórico continuam
  // sendo mantidos pela interface do provedor.
  let pending = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => Boolean(element &&
    (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const textOf = (element) => (element?.innerText ?? element?.textContent ?? '').replace(/\r\n/g, '\n').trim();
  const fail = (code, message) => ({ error: { code, message } });

  function conversationUrl() {
    return /\/c\/[^/]+\/?$/.test(location.pathname) ? `${location.origin}${location.pathname}` : null;
  }

  function composer(providerId) {
    const selectors = providerId === 'chatgpt'
      ? ['#prompt-textarea', 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
        '[data-composer-input] [contenteditable="true"][role="textbox"]',
        'form[data-type="unified-composer"] [contenteditable="true"]']
      : ['main textarea', 'textarea', 'main [contenteditable="true"][role="textbox"]', 'main .tiptap[contenteditable="true"]'];
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) {
        return element;
      }
    }
    return null;
  }

  function editorText(editor) {
    return 'value' in editor ? editor.value.trim() : textOf(editor);
  }

  function label(button) {
    const labelledBy = (button.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ');
    return (button.getAttribute('aria-label') || labelledBy || button.getAttribute('title') || textOf(button)).trim();
  }

  function stopButton() {
    return [...document.querySelectorAll('button')].find((button) => visible(button) && (
      button.dataset.testid === 'stop-button' ||
      /^(stop(?: generating| response)?|parar(?: de gerar| resposta)?|interromper(?: resposta| geração)?)$/i.test(label(button))
    ));
  }

  function sendButton(editor) {
    const scope = editor.closest('form') || document.querySelector('main') || document;
    const stop = stopButton();
    return [...scope.querySelectorAll('button')].find((button) => visible(button) &&
      button !== stop && button.dataset.testid !== 'stop-button' && (
        button.dataset.testid === 'send-button' || button.id === 'composer-submit-button' ||
        /^(send(?: message| prompt)?|submit|enviar(?: mensagem| prompt)?)$/i.test(label(button))
      ));
  }

  function messages(role, providerId) {
    const semantic = [...document.querySelectorAll(`[data-message-author-role="${role}"]`)];
    if (semantic.length) {
      return semantic;
    }
    if (providerId === 'chatgpt') {
      return [...document.querySelectorAll(`[data-chatgpt-search-unit-key$=":${role}"]`)];
    }
    // Grok não publica o atributo do ChatGPT. Limitamos a busca às bolhas de
    // mensagem, sem incluir blocos de raciocínio ou a navegação lateral.
    return [...document.querySelectorAll(role === 'assistant'
      ? '.message-bubble .response-content-markdown, [data-testid="assistant-message"]'
      : '.message-bubble.bg-surface-l1, [data-testid="user-message"]')];
  }

  function messageKey(element) {
    return element.getAttribute('data-message-id') || element.getAttribute('data-id') ||
      element.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\s+/)[0] ||
      element.getAttribute('data-chatgpt-search-unit-key') || element;
  }

  function userText(element) {
    return textOf(element.querySelector('[data-user-message-bubble]') || element);
  }

  const TURN_SELECTOR = '[data-turn-key], [data-content-search-turn-key], ' +
    '[data-talvt-turn-state], [data-testid^="conversation-turn-"], article';
  const ACTIVITY_HEADER_SELECTOR = '[class~="group/activity-header"]';
  const REASONING_SELECTOR = '[data-markdown-text-style="secondary"], [data-reasoning-content], ' +
    '[data-testid="reasoning-content"], [data-testid="thinking-content"], .reasoning-content';
  const MARKDOWN_SELECTOR = '.markdown, .response-content-markdown, [data-markdown-text-style="assistant-message"]';

  function turnKey(element) {
    const keyed = element.closest('[data-turn-key], [data-content-search-turn-key]');
    return keyed?.getAttribute('data-turn-key') || keyed?.getAttribute('data-content-search-turn-key') ||
      element.getAttribute('data-testid') || element;
  }

  function isReasoningBlock(element) {
    if (element.closest(REASONING_SELECTOR)) {
      return true;
    }
    // Na UI atual, o painel de atividade usa a mesma marcação de markdown da
    // resposta final. O cabeçalho irmão é o que identifica esse painel.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.querySelector(`:scope > ${ACTIVITY_HEADER_SELECTOR}`)) {
        return true;
      }
      if (parent.matches(TURN_SELECTOR)) {
        break;
      }
    }
    return false;
  }

  function recordReasoning(request, seen, index, text) {
    const previous = seen[index] || '';
    if (!text || text === previous || previous.startsWith(text)) {
      return;
    }
    const extension = previous && text.startsWith(previous) ? text.slice(previous.length) :
      `${request.reasoning ? '\n\n' : ''}${text}`;
    request.reasoning += extension;
    seen[index] = text;
  }

  function captureReasoning(request, latestUser) {
    const scopes = [...document.querySelectorAll(TURN_SELECTOR)].filter((scope) =>
      !request.turns.has(turnKey(scope)) && (scope.contains(latestUser) ||
        (latestUser.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const outer = scopes.filter((scope) => !scopes.some((other) => other !== scope && other.contains(scope)));
    let opening = false;
    for (const scope of outer) {
      const headers = [...scope.querySelectorAll(ACTIVITY_HEADER_SELECTOR)];
      const disclosures = [...scope.querySelectorAll('button[aria-expanded], details > summary')].filter((button) =>
        visible(button) && /^(thinking|thought(?: for)?|pensando|pensou(?: por)?|raciocinando|raciocínio)(?:\b|…|\.)/i.test(label(button)));
      for (const button of disclosures) {
        const closed = button.tagName === 'SUMMARY' ? !button.parentElement.open : button.getAttribute('aria-expanded') === 'false';
        if (closed && !request.openedThinking.has(button)) {
          request.openedThinking.add(button);
          request.thinkingOpenedAt = Date.now();
          button.click();
          opening = true;
        }
      }
      const panels = [...scope.querySelectorAll(REASONING_SELECTOR), ...headers.map((header) => header.parentElement)];
      for (const button of disclosures) {
        const controlled = document.getElementById(button.getAttribute('aria-controls'));
        if (controlled) {
          panels.push(controlled);
        }
        if (button.tagName === 'SUMMARY') {
          panels.push(button.parentElement);
        }
      }
      const found = [...new Set(panels.flatMap((panel) => panel.matches(REASONING_SELECTOR)
        ? [panel] : [...panel.querySelectorAll(`${MARKDOWN_SELECTOR}, ${REASONING_SELECTOR}`)]))];
      const blocks = found.filter((block) => !found.some((other) => other !== block && other.contains(block)));
      const key = turnKey(scope);
      let seen = request.reasoningBlocks.get(key);
      if (!seen) {
        seen = [];
        request.reasoningBlocks.set(key, seen);
      }
      blocks.forEach((block, index) => {
        if (!visible(block) || block.closest('[hidden], [aria-hidden="true"]')) {
          return;
        }
        // Captura apenas o texto que a UI expõe. O transcript mantém resumos
        // já exibidos mesmo quando o provedor recolhe ou substitui o painel.
        request.reasoningNodes.set(block, { seen, index });
        recordReasoning(request, seen, index, textOf(block));
      });
      // Indicadores de geração e rótulos como “Pensando” não contêm o resumo
      // do modelo e nunca são usados como fallback de reasoning_content.
    }
    return opening || Date.now() - request.thinkingOpenedAt < 500;
  }

  function observeReasoning(request) {
    request.observer = new MutationObserver(() => {
      if (pending !== request || conversationUrl() !== request.url || request.stream) {
        return;
      }
      const latestUser = messages('user', request.providerId).at(-1);
      if (!latestUser || request.users.has(messageKey(latestUser)) || userText(latestUser) !== request.message) {
        return;
      }
      // A UI pode desmontar a atualização de atividade ao começar a resposta.
      // Conserva a última versão dos nós que já eram visíveis neste pedido.
      for (const [block, { seen, index }] of request.reasoningNodes) {
        if (!block.isConnected) {
          recordReasoning(request, seen, index, textOf(block));
          request.reasoningNodes.delete(block);
        }
      }
      captureReasoning(request, latestUser);
    });
    request.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  // O ChatGPT entrega cada etapa do raciocínio no SSE da própria página, com
  // título e texto; o DOM mostra só os títulos. A ponte lê uma cópia desse
  // stream, sem alterar a resposta da página. Todo SSE de conversa é seguido
  // desde o início: uma mensagem enviada durante um turno em andamento
  // (steering) chega no SSE que a página já tinha aberto.
  const STREAM_PATH = /^\/backend-api\/(?:f\/)?conversation(?:\/|$)/;
  const plain = (value) => (typeof value === 'string' ? value : '');
  const partsText = (parts) => (Array.isArray(parts) ? parts.map(plain).join('') : '').replace(/\r\n/g, '\n').trim();

  function tapStream(response) {
    if (!response.body || !(response.headers.get('content-type') || '').includes('text/event-stream') ||
      !STREAM_PATH.test(new URL(response.url, location.href).pathname)) {
      return;
    }
    const stream = { roots: new Map(), channel: 0, path: '', op: '', conversationId: null };
    const reader = response.clone().body.getReader();
    readStream(stream, reader).catch(() => {}).finally(() => reader.cancel().catch(() => {}));
  }

  if (!window[TAP_KEY] && /(?:^|\.)chatgpt\.com$/.test(location.hostname)) {
    const tap = { listener: null };
    const pageFetch = window.fetch;
    window.fetch = function fetch(...args) {
      const result = pageFetch.apply(this, args);
      return result.then((response) => {
        try {
          tap.listener?.(response);
        } catch {
          // A cópia do stream nunca interfere no fetch da página.
        }
        return response;
      });
    };
    window[TAP_KEY] = tap;
  }
  // Versões recarregadas da ponte trocam só o leitor, sem empilhar wrappers.
  // Streams abertos por uma versão anterior passam a ser lidos pela atual.
  if (window[TAP_KEY]) {
    window[TAP_KEY].listener = tapStream;
    window[TAP_KEY].onEvent = readEvent;
  }

  async function readStream(stream, reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const data = buffer.slice(0, end).split('\n').filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        buffer = buffer.slice(end + 2);
        if (data && data !== '[DONE]') {
          window[TAP_KEY]?.onEvent?.(stream, data);
        }
      }
    }
  }

  function readEvent(stream, data) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') {
      return;
    }
    // O estado do delta encoding é mantido mesmo sem pedido pendente.
    let root = null;
    if (typeof event.type !== 'string') {
      if (Number.isInteger(event.c)) {
        stream.channel = event.c;
      }
      if ('message' in event) {
        stream.roots.set(stream.channel, event);
      } else {
        // No delta encoding v1, campos omitidos repetem o caminho, a operação e
        // o canal anteriores. Canais distintos mantêm árvores independentes.
        stream.path = typeof event.p === 'string' ? event.p : stream.path;
        stream.op = typeof event.o === 'string' ? event.o : stream.op;
        applyDelta(stream, stream.path, stream.op, event.v);
      }
      root = stream.roots.get(stream.channel);
    }
    stream.conversationId = plain(event.conversation_id) || plain(root?.conversation_id) || stream.conversationId;

    const request = pending;
    if (!request || request.providerId !== 'chatgpt' || !request.submitted || conversationUrl() !== request.url) {
      return;
    }
    if (request.stream !== stream) {
      // Até a mensagem enviada por steering aparecer, o progresso do turno em
      // andamento na mesma conversa também é atividade do pedido.
      if (!request.stream && (bindStream(request, stream, event, root) || stream.conversationId === request.conversationId)) {
        request.activitySeq++;
      }
      return;
    }
    // Qualquer evento posterior do mesmo SSE é atividade real do provedor,
    // inclusive tool calls e markers que não geram texto visível.
    request.activitySeq++;
    readThoughts(request, root);
    readAnswer(request, root);
  }

  // Liga o pedido ao SSE que traz a mensagem enviada pela ponte: o input de um
  // turno novo ou, com steering, a mensagem do usuário no turno em andamento.
  function bindStream(request, stream, event, root) {
    let turn;
    if (event.type === 'input_message') {
      if (partsText(event.input_message?.content?.parts) !== request.message) {
        return false;
      }
      turn = event.input_message.metadata?.turn_exchange_id;
    } else {
      const message = root?.message;
      if (message?.author?.role !== 'user' || partsText(message.content?.parts) !== request.message ||
        (stream.conversationId && stream.conversationId !== request.conversationId)) {
        return false;
      }
      turn = message.metadata?.turn_exchange_id;
      // O que o turno já produziu antes da mensagem pertence ao pedido anterior.
      for (const previous of stream.roots.values()) {
        if (previous?.message?.id) {
          request.ignored.add(previous.message.id);
        }
      }
    }
    request.stream = stream;
    request.turnExchangeId = turn || request.turnExchangeId;
    return true;
  }

  function applyDelta(stream, path, op, value) {
    if (op === 'patch') {
      for (const item of Array.isArray(value) ? value : []) {
        if (Number.isInteger(item?.c)) {
          stream.channel = item.c;
        }
        applyDelta(stream, plain(item?.p), plain(item?.o), item?.v);
      }
      return;
    }
    const keys = path.split('/').slice(1).map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length) {
      if (op === 'add' || op === 'replace') {
        stream.roots.set(stream.channel, value);
      }
      return;
    }
    let parent = stream.roots.get(stream.channel);
    for (const key of keys.slice(0, -1)) {
      parent = parent?.[key];
    }
    if (!parent || typeof parent !== 'object') {
      return;
    }
    const key = keys.at(-1);
    const current = parent[key];
    if (op === 'append') {
      parent[key] = Array.isArray(current) ? current.concat(value) : `${current ?? ''}${value}`;
    } else if (op === 'add' || op === 'replace') {
      parent[key] = value;
    } else if (op === 'truncate' && (typeof current === 'string' || Array.isArray(current))) {
      parent[key] = current.slice(0, value);
    } else if (op === 'remove') {
      delete parent[key];
    }
  }

  // Mensagem do assistente no turno ligado ao pedido, ou null.
  function replyMessage(request, root) {
    const message = root?.message;
    if (!message || typeof message !== 'object' || message.author?.role !== 'assistant' || request.ignored.has(message.id) ||
      (root.conversation_id && root.conversation_id !== request.conversationId)) {
      return null;
    }
    const turn = message.metadata?.turn_exchange_id;
    return request.turnExchangeId && turn && turn !== request.turnExchangeId ? null : message;
  }

  function readThoughts(request, root) {
    const message = replyMessage(request, root);
    if (message?.content?.content_type !== 'thoughts') {
      return;
    }
    const thoughts = Array.isArray(message.content.thoughts) ? message.content.thoughts : [];
    thoughts.forEach((thought, index) => {
      // Cada etapa termina com o título no passado e sem texto: não a repete.
      const closing = !plain(thought?.content).trim() && thoughts.slice(0, index).some((item) => plain(item?.content).trim());
      recordThought(request, `${message.id}:${index}`, thought, closing);
    });
  }

  function readAnswer(request, root) {
    const message = replyMessage(request, root);
    if (!message) {
      return;
    }
    const contentType = message.content?.content_type;
    if (contentType !== 'text' && contentType !== 'multimodal_text') {
      return;
    }

    // Modelos novos podem produzir mensagens visíveis em canais distintos.
    // Só o canal final compõe content; commentary/thinking continuam separados.
    const channel = message.channel || message.metadata?.channel;
    if (channel && channel !== 'final') {
      return;
    }

    const parts = message.content?.parts;
    if (!Array.isArray(parts)) {
      return;
    }
    const text = parts.map((part) => typeof part === 'string' ? part : plain(part?.text)).join('');
    const key = message.id || 'final';
    if (request.answerMessageId && request.answerMessageId !== key) {
      return;
    }
    request.answerMessageId ||= key;
    const previous = request.answerMessages.get(key) || '';
    if (!text || text === previous || !text.startsWith(previous)) {
      return;
    }
    request.answerMessages.set(key, text);
    request.answer += text.slice(previous.length);
    request.answerComplete ||= message.status === 'finished_successfully';
  }

  function recordThought(request, key, thought, closing) {
    const summary = plain(thought?.summary).trim();
    const content = plain(thought?.content);
    let state = request.thoughts.get(key);
    if (!state) {
      if (closing || (!summary && !content.trim())) {
        return;
      }
      state = { content: '' };
      request.thoughts.set(key, state);
      request.openThought = key;
      if (summary) {
        request.reasoning += `${request.reasoning ? '\n\n' : ''}**${summary}**`;
      }
    }
    // reasoning_content só cresce: uma etapa já seguida por outra não é reescrita.
    if (request.openThought !== key || content.length <= state.content.length || !content.startsWith(state.content)) {
      return;
    }
    if (state.content) {
      request.reasoning += content.slice(state.content.length);
    } else if (content.trim()) {
      request.reasoning += `${request.reasoning ? '\n\n' : ''}${content.trimStart()}`;
    } else {
      return;
    }
    state.content = content;
  }

  function release(request) {
    if (pending === request) {
      pending = null;
    }
    request.observer?.disconnect();
    if (conversationUrl() === request.url) {
      for (const button of request.openedThinking) {
        if (button.isConnected && (button.tagName === 'SUMMARY' ? button.parentElement.open : button.getAttribute('aria-expanded') === 'true')) {
          button.click();
        }
      }
    }
  }

  function directSender(editor, providerId) {
    if (providerId !== 'chatgpt') {
      return null;
    }
    const form = editor.closest('form');
    const fiberKey = form && Object.keys(form).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey && form[fiberKey];
    const conversationId = location.pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
    // Reconhece o contrato do composer, sem depender de nomes minificados ou
    // chamar o onSubmit do form, que ainda leria o editor vazio.
    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props?.conversationId === conversationId && props.composerController?.view?.dom === editor &&
        typeof props.onSubmit === 'function' && typeof props.onPromptChange === 'function' &&
        typeof props.onStop === 'function') {
        return props;
      }
    }
    return null;
  }

  // O innerText da resposta já renderizada perderia títulos, listas, ênfases,
  // links, tabelas e cercas de código. O conversor devolve o markdown de origem.
  const SKIPPED_TAGS = new Set(['BUTTON', 'SVG', 'IMG', 'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'SELECT']);
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'FIGURE', 'DETAILS', 'SUMMARY', 'ASIDE']);

  const skipped = (element) => SKIPPED_TAGS.has(element.tagName.toUpperCase()) ||
    element.getAttribute('data-markdown-copy') === 'exclude';

  function wrap(text, mark) {
    const [, before, body, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return body ? `${before}${mark}${body}${mark}${after}` : text;
  }

  function inlineCode(text) {
    const mark = '`'.repeat(Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length)) + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return `${mark}${pad}${text}${pad}${mark}`;
  }

  function texOf(element) {
    return element.querySelector('annotation[encoding="application/x-tex"]')?.textContent.trim();
  }

  function linkOf(anchor) {
    // As citações do ChatGPT terminam com o contador de fontes extras ("+1").
    const citation = Boolean(anchor.closest('[data-markdown-copy="contents"]'));
    const label = inlineChildren(anchor).trim();
    const text = citation ? label.replace(/\s*\+\d+$/, '') : label;
    const href = (anchor.getAttribute('href') || '').replace(/ /g, '%20').replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
    if (!href || /^javascript:/i.test(href)) {
      return text;
    }
    return !text || text === href ? href : `[${text}](${href})`;
  }

  function inlineChildren(parent) {
    return [...parent.childNodes].map(inlineOf).join('');
  }

  function inlineOf(node) {
    if (node.nodeType === 3) {
      return node.textContent;
    }
    if (node.nodeType !== 1) {
      return '';
    }
    if (node.tagName === 'INPUT') {
      return node.type === 'checkbox' ? (node.checked ? '[x] ' : '[ ] ') : '';
    }
    if (skipped(node)) {
      return '';
    }
    if (node.getAttribute('data-markdown-copy') === 'inline-code' || node.tagName === 'CODE') {
      return inlineCode(node.textContent);
    }
    if (node.classList.contains('katex') && texOf(node)) {
      return `$${texOf(node)}$`;
    }
    switch (node.tagName) {
      case 'BR': return '  \n';
      case 'STRONG': case 'B': return wrap(inlineChildren(node), '**');
      case 'EM': case 'I': return wrap(inlineChildren(node), '*');
      case 'DEL': case 'S': return wrap(inlineChildren(node), '~~');
      case 'A': return linkOf(node);
      default: return inlineChildren(node);
    }
  }

  function codeBlock(block) {
    const code = block.querySelector('code') || block;
    const text = code.textContent.replace(/\n$/, '');
    // O ChatGPT atual só informa a linguagem no rótulo do cabeçalho ("Bash",
    // "Texto simples"); a marcação antiga usa a classe language-*.
    let language = /language-([\w+#-]+)/.exec(code.className)?.[1] || '';
    if (!language) {
      const header = block.querySelector('[data-markdown-copy="exclude"]');
      const label = (header?.innerText || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
      language = /\s/.test(label) ? 'text' : label;
    }
    const mark = '`'.repeat(Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length)) + 1);
    return `${mark}${language.toLowerCase()}\n${text}\n${mark}`;
  }

  function listOf(list) {
    const ordered = list.tagName === 'OL';
    let number = Number.parseInt(list.getAttribute('start'), 10);
    if (!Number.isFinite(number)) {
      number = 1;
    }
    const items = [...list.children].filter((item) => item.tagName === 'LI' && !skipped(item));
    const loose = items.some((item) => [...item.children].some((child) => child.tagName === 'P'));
    return items.map((item) => {
      const marker = ordered ? `${number++}. ` : '- ';
      const body = blocksOf(item).join(loose ? '\n\n' : '\n');
      return marker + body.split('\n').map((line, index) => (index && line ? ' '.repeat(marker.length) + line : line)).join('\n');
    }).join(loose ? '\n\n' : '\n');
  }

  function tableOf(table) {
    const rows = [...table.querySelectorAll('tr')].map((row) =>
      [...row.children].filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD'));
    if (!rows.length) {
      return '';
    }
    const width = Math.max(...rows.map((row) => row.length));
    const line = (cells) => `|${Array.from({ length: width }, (_, index) => {
      const text = cells[index] ? blocksOf(cells[index]).join('<br>').replace(/\n/g, '<br>').replace(/\|/g, '\\|') : '';
      return text ? ` ${text} ` : ' ';
    }).join('|')}|`;
    const rule = Array.from({ length: width }, (_, index) => {
      const align = rows[0][index]?.getAttribute('align');
      return align === 'right' ? '---:' : align === 'center' ? ':---:' : align === 'left' ? ':---' : '---';
    });
    return [line(rows[0]), `| ${rule.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }

  // Devolve a lista de blocos de um elemento, ou null quando o nó é inline.
  function blockOf(node) {
    if (node.nodeType !== 1) {
      return null;
    }
    const tag = node.tagName;
    if (node.getAttribute('data-markdown-copy') === 'code-block' || tag === 'PRE') {
      return [codeBlock(node)];
    }
    if (node.classList.contains('katex-display') && texOf(node)) {
      return [`$$\n${texOf(node)}\n$$`];
    }
    if (/^H[1-6]$/.test(tag)) {
      const text = inlineChildren(node).trim();
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : [];
    }
    switch (tag) {
      case 'P': return [inlineChildren(node).trim()].filter(Boolean);
      case 'UL': case 'OL': return [listOf(node)];
      case 'TABLE': return [tableOf(node)];
      case 'HR': return ['---'];
      case 'BLOCKQUOTE': return [blocksOf(node).join('\n\n').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')];
      default: return CONTAINER_TAGS.has(tag) ? blocksOf(node) : null;
    }
  }

  function blocksOf(parent) {
    const blocks = [];
    let run = '';
    const flush = () => {
      if (run.trim()) {
        blocks.push(run.trim());
      }
      run = '';
    };
    for (const node of parent.childNodes) {
      if (node.nodeType === 1 && skipped(node)) {
        continue;
      }
      const block = blockOf(node);
      if (block) {
        flush();
        blocks.push(...block);
      } else {
        run += inlineOf(node);
      }
    }
    flush();
    return blocks;
  }

  const markdownOf = (root) => (root ? blocksOf(root).join('\n\n') : '');

  function answerText(element) {
    const found = [...element.querySelectorAll(MARKDOWN_SELECTOR)].filter((block) => !isReasoningBlock(block));
    // As gerações do ChatGPT aninham esses marcadores: só o mais externo conta.
    const blocks = found.filter((block) => !found.some((other) => other !== block && other.contains(block)));
    if (blocks.length) {
      return blocks.map(markdownOf).filter(Boolean).join('\n\n');
    }
    if (element.matches('.response-content-markdown, [data-testid="assistant-message"]')) {
      return markdownOf(element);
    }
    // O corpo sem markdown é usado por algumas respostas curtas do ChatGPT.
    return markdownOf(element.querySelector('[data-message-content]'));
  }

  function turnComplete(element) {
    const currentTurn = element.closest('[data-talvt-turn-state]');
    if (currentTurn) {
      return currentTurn.getAttribute('data-talvt-turn-state') === 'complete';
    }
    const turn = element.closest('[data-testid^="conversation-turn-"], article') || element.closest('.message-bubble') || element;
    return Boolean(turn.querySelector(
      '[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], button[aria-label="Copy response"], button[aria-label="Copiar resposta"]'
    ));
  }

  function insertText(editor, message) {
    editor.focus();
    if ('value' in editor) {
      const prototype = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(editor, message);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('insertText', false, message)) {
      editor.replaceChildren(...message.split('\n').map((line) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        return paragraph;
      }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    }
  }

  // Remove do editor o texto que a ponte inseriu e não chegou a enviar.
  function clearInserted(request) {
    if (request.sendMode === 'editor' && !request.submitted && request.editor.isConnected && editorText(request.editor) === request.message) {
      insertText(request.editor, '');
    }
  }

  async function begin({ id, providerId, message }) {
    const url = conversationUrl();
    if (!url) {
      return fail('no_active_chat', 'Abra uma conversa existente no provedor ativo.');
    }
    if (pending) {
      return fail('chat_busy', 'O chat ativo está ocupado.');
    }
    const editor = composer(providerId);
    if (!editor) {
      return fail('composer_unavailable', 'O campo de mensagem do chat não está disponível.');
    }
    if (editorText(editor)) {
      return fail('composer_not_empty', 'Envie ou limpe o rascunho do chat antes de usar a ponte.');
    }
    const sender = directSender(editor, providerId);
    // Com um turno em andamento, o ChatGPT aceita outra mensagem no mesmo turno
    // (steering), como o botão Enviar da UI. Sem isso, o envio fica para depois.
    const generating = Boolean(stopButton() || sender?.isStreaming);
    if ((generating && !sender?.isSteeringEnabled) || sender?.isSubmitting || sender?.isStopping) {
      return fail('chat_busy', 'O chat ativo está ocupado.');
    }
    if (sender && ['attachments', 'mcpAppAttachments', 'commentAttachments', 'selectedTextAttachments']
      .some((key) => sender[key]?.length)) {
      return fail('composer_not_empty', 'Envie ou remova os anexos do rascunho antes de usar a ponte.');
    }
    if (sender?.readOnly || sender?.submissionBlocked || sender?.rateLimitConversationSendBlocked) {
      return fail('send_unavailable', 'O provedor bloqueou o envio na conversa ativa.');
    }
    const request = {
      id, providerId, editor, message: message.replace(/\r\n/g, '\n').trim(), url,
      users: new Set(messages('user', providerId).map(messageKey)),
      assistants: new Set(messages('assistant', providerId).map(messageKey)),
      turns: new Set([...document.querySelectorAll(TURN_SELECTOR)].map(turnKey)),
      conversationId: location.pathname.match(/\/c\/([^/]+)\/?$/)?.[1],
      reasoning: '', reasoningBlocks: new Map(), reasoningNodes: new Map(), openedThinking: new Set(), thinkingOpenedAt: 0,
      answer: '', answerComplete: false, answerMessageId: null, answerMessages: new Map(),
      stream: null, ignored: new Set(), activitySeq: 0, turnExchangeId: null, thoughts: new Map(), openThought: null,
      sendMode: sender ? 'direct' : 'editor',
      submitted: false, sawBusy: false, lastText: '', changedAt: Date.now()
    };
    pending = request;
    try {
      observeReasoning(request);
      if (sender) {
        // O callback nativo recebe o texto completo, mantém o histórico/modelo
        // da página e valida o pedido novamente antes de efetivar o envio.
        request.submitted = true;
        const accepted = await sender.onSubmit(message, undefined, {
          preserveDraft: true,
          isSubmissionCurrent: () => pending === request && conversationUrl() === url && !editorText(editor)
        });
        if (pending !== request || conversationUrl() !== url) {
          release(request);
          return fail('chat_changed', 'O pedido foi cancelado ou a conversa mudou antes do envio.');
        }
        if (accepted !== true) {
          release(request);
          // Não tenta o botão após chamar o callback: uma falha de contrato
          // pode ter ocorrido depois de o provedor já aceitar a mensagem.
          return fail('send_unavailable', 'O provedor não confirmou o envio direto da mensagem.');
        }
        return { ok: true, sendMode: 'direct' };
      }
      insertText(editor, message);
      const deadline = Date.now() + 3000;
      while (pending === request && Date.now() < deadline) {
        if (conversationUrl() !== url) {
          release(request);
          return fail('chat_changed', 'A conversa ativa mudou antes do envio.');
        }
        if (stopButton()) {
          release(request);
          clearInserted(request);
          return fail('chat_busy', 'Uma geração começou no chat antes do envio.');
        }
        const button = sendButton(editor);
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && editorText(editor) === request.message) {
          request.submitted = true;
          button.click();
          return { ok: true, sendMode: 'editor' };
        }
        await sleep(50);
      }
      release(request);
      return fail('send_unavailable', 'Não foi possível enviar a mensagem pelo botão do chat.');
    } catch (error) {
      release(request);
      return fail('send_unavailable', `Não foi possível enviar pelo ${request.sendMode === 'direct' ? 'callback do provedor' : 'campo do chat'}: ${error.message}`);
    }
  }

  function poll(id) {
    const request = pending;
    if (!request || request.id !== id) {
      return fail('request_lost', 'O pedido não está mais ligado à conversa.');
    }
    if (conversationUrl() !== request.url) {
      return fail('chat_changed', 'A conversa mudou enquanto a resposta era aguardada.');
    }
    const users = messages('user', request.providerId);
    const latestUser = users.at(-1);
    if (!latestUser || request.users.has(messageKey(latestUser))) {
      return { text: '', done: false };
    }
    if (userText(latestUser) !== request.message) {
      return fail('chat_changed', 'Outra mensagem foi enviada no chat durante o pedido.');
    }
    // O DOM só é lido quando o stream do ChatGPT não foi ligado ao pedido.
    const previousReasoning = request.reasoning;
    const thinkingOpening = !request.stream && captureReasoning(request, latestUser);
    if (request.reasoning !== previousReasoning) {
      request.activitySeq++;
    }
    const replies = messages('assistant', request.providerId).filter((element) =>
      !request.assistants.has(messageKey(element)) &&
      (latestUser.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    const reply = replies.at(-1);
    const currentTurn = reply?.closest('[data-talvt-turn-state]');
    const busy = Boolean(stopButton()) || Boolean(reply?.closest('[data-is-streaming="true"]')) ||
      Boolean(currentTurn && currentTurn.getAttribute('data-talvt-turn-state') !== 'complete');
    request.sawBusy ||= busy;
    const text = reply ? answerText(reply) : '';
    if (text !== request.lastText) {
      request.lastText = text;
      request.changedAt = Date.now();
      request.activitySeq++;
    }
    const error = [...document.querySelectorAll('[role="alert"], [data-testid="conversation-error"]')]
      .find((element) => visible(element) && /something went wrong|error|erro|falha|try again|tente novamente/i.test(textOf(element)));
    if (error) {
      return fail('provider_error', textOf(error));
    }
    const done = Boolean(text && !busy && !thinkingOpening && (turnComplete(reply) ||
      (request.sawBusy && Date.now() - request.changedAt >= 1500)));
    return {
      text,
      reasoning: request.reasoning,
      streamedText: request.answer,
      streamedComplete: request.answerComplete,
      activitySeq: request.activitySeq,
      done,
      sendMode: request.sendMode
    };
  }

  window[API_KEY] = {
    version: VERSION,
    begin,
    poll,
    cancel(id) {
      if (pending?.id === id) {
        const request = pending;
        release(request);
        clearInserted(request);
      }
    }
  };
})();
