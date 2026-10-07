(() => {
  const API_KEY = '__chatClientAppServer';
  const VERSION = 3;
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
    return (button.getAttribute('aria-label') || button.getAttribute('title') || textOf(button)).trim();
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
    const found = [...element.querySelectorAll(
      '.markdown, .response-content-markdown, [data-markdown-text-style="assistant-message"]'
    )];
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

  async function begin({ id, providerId, message }) {
    const url = conversationUrl();
    if (!url) {
      return fail('no_active_chat', 'Abra uma conversa existente no provedor ativo.');
    }
    if (pending || stopButton()) {
      return fail('chat_busy', 'O chat ativo está ocupado.');
    }
    const editor = composer(providerId);
    if (!editor) {
      return fail('composer_unavailable', 'O campo de mensagem do chat não está disponível.');
    }
    if (editorText(editor)) {
      return fail('composer_not_empty', 'Envie ou limpe o rascunho do chat antes de usar a ponte.');
    }
    const request = {
      id, providerId, editor, message: message.replace(/\r\n/g, '\n').trim(), url,
      users: new Set(messages('user', providerId).map(messageKey)),
      assistants: new Set(messages('assistant', providerId).map(messageKey)),
      submitted: false, sawBusy: false, lastText: '', changedAt: Date.now()
    };
    pending = request;
    try {
      insertText(editor, message);
      const deadline = Date.now() + 3000;
      while (pending === request && Date.now() < deadline) {
        if (conversationUrl() !== url) {
          pending = null;
          return fail('chat_changed', 'A conversa ativa mudou antes do envio.');
        }
        if (stopButton()) {
          pending = null;
          return fail('chat_busy', 'Uma geração começou no chat antes do envio.');
        }
        const button = sendButton(editor);
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && editorText(editor) === request.message) {
          request.submitted = true;
          button.click();
          return { ok: true };
        }
        await sleep(50);
      }
      if (pending === request) {
        pending = null;
      }
      return fail('send_unavailable', 'Não foi possível enviar a mensagem pelo botão do chat.');
    } catch (error) {
      if (pending === request) {
        pending = null;
      }
      return fail('send_unavailable', `Não foi possível preencher o chat: ${error.message}`);
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
    }
    const error = [...document.querySelectorAll('[role="alert"], [data-testid="conversation-error"]')]
      .find((element) => visible(element) && /something went wrong|error|erro|falha|try again|tente novamente/i.test(textOf(element)));
    if (error) {
      return fail('provider_error', textOf(error));
    }
    const done = Boolean(text && !busy && (turnComplete(reply) ||
      (request.sawBusy && Date.now() - request.changedAt >= 1500)));
    return { text, done };
  }

  window[API_KEY] = {
    version: VERSION,
    begin,
    poll,
    cancel(id) {
      if (pending?.id === id) {
        const request = pending;
        pending = null;
        if (!request.submitted && request.editor.isConnected && editorText(request.editor) === request.message) {
          insertText(request.editor, '');
        }
      }
    }
  };
})();
