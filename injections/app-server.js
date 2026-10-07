(() => {
  const API_KEY = '__chatClientAppServer';
  const VERSION = 2;
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

  function answerText(element) {
    const blocks = [...element.querySelectorAll(
      '.markdown, .response-content-markdown, [data-markdown-text-style="assistant-message"]'
    )];
    if (blocks.length) {
      return blocks.map(textOf).join('\n\n');
    }
    if (element.matches('.response-content-markdown, [data-testid="assistant-message"]')) {
      return textOf(element);
    }
    // O corpo sem markdown é usado por algumas respostas curtas do ChatGPT.
    return textOf(element.querySelector('[data-message-content]'));
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
