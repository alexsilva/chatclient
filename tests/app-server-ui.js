// Teste integrado com páginas locais simuladas: nunca usa contas ou chats reais.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');

const profile = mkdtempSync(join(tmpdir(), 'chatclient-server-test-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
writeFileSync(join(profile, 'session-state.json'), JSON.stringify({
  restoreWorkspaceEnabled: false,
  appServer: { enabled: false, host: '127.0.0.1', port: 8791, key: 'persisted-key' }
}));

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body { color: #ddd; background: #171717; font: 16px sans-serif; padding: 24px; }
main { max-width: 700px; } [contenteditable="true"] { min-height: 60px; padding: 10px; border: 1px solid #999; }
button { padding: 8px; } article { margin-bottom: 10px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
[data-message-author-role="user"], .markdown, [data-user-message-bubble], [data-markdown-text-style="assistant-message"] { white-space: pre-wrap; }
</style></head><body><main>
<article data-testid="conversation-turn-0"><div data-message-author-role="user" data-message-id="old-user">Pergunta antiga</div></article>
<article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="old-assistant"><div class="markdown">Resposta antiga que nunca deve vazar</div></div><button type="button" data-testid="copy-turn-action-button">Copiar</button></article>
<section id="messages"></section><form data-type="unified-composer">
<div id="prompt-textarea" contenteditable="true" role="textbox"></div>
<button id="composer-submit-button" type="button" data-testid="send-button" aria-label="Enviar mensagem" disabled>Enviar</button></form>
</main><script>
window.sentMessages = [];
window.responseDelay = 180;
const editor = document.getElementById('prompt-textarea');
const button = document.getElementById('composer-submit-button');
if (location.hostname === 'grok.com') {
  for (const message of document.querySelectorAll('[data-message-author-role]')) {
    message.classList.add('message-bubble');
    if (message.dataset.messageAuthorRole === 'user') { message.classList.add('bg-surface-l1'); }
    message.querySelector('.markdown')?.classList.add('response-content-markdown');
    message.removeAttribute('data-message-author-role');
  }
}
editor.addEventListener('input', () => { button.disabled = !editor.innerText.trim(); });
window.inputEvents = 0;
editor.addEventListener('input', () => { window.inputEvents++; });
window.submitMessage = (message, options = {}) => {
  if (button.dataset.testid === 'stop-button') { return false; }
  window.sentMessages.push(message);
  const index = window.sentMessages.length;
  if (window.streamThoughts) {
    // A página consome o próprio SSE; a ponte só pode ler uma cópia.
    window.pageStream = fetch('/backend-api/f/conversation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: window.streamInput || message, conversation: location.pathname.split('/c/')[1], turn: 'turn-' + index })
    }).then((response) => response.text()).then((text) => { window.pageStreamText = text; });
  }
  if (!options.preserveDraft) { editor.replaceChildren(); }
  button.dataset.testid = 'stop-button';
  button.setAttribute('aria-label', 'Stop generating');
  button.textContent = 'Stop';
  const user = document.createElement('div');
  user.dataset.messageAuthorRole = 'user';
  user.dataset.messageId = 'user-' + index;
  if (location.hostname === 'grok.com') {
    user.removeAttribute('data-message-author-role');
    user.className = 'message-bubble bg-surface-l1';
    user.style.whiteSpace = 'pre-wrap';
  }
  user.textContent = message;
  document.getElementById('messages').appendChild(user);
  const turn = document.createElement('article');
  turn.dataset.testid = 'conversation-turn-' + (index + 1);
  let turnContainer = turn;
  const reply = document.createElement('div');
  reply.dataset.messageAuthorRole = 'assistant';
  reply.dataset.messageId = 'assistant-' + index;
  const markdown = document.createElement('div');
  markdown.className = 'markdown';
  if (location.hostname === 'grok.com') {
    reply.removeAttribute('data-message-author-role');
    reply.className = 'message-bubble';
    markdown.classList.add('response-content-markdown');
  }
  markdown.textContent = '**Resposta em transformação';
  if (window.modernMarkup) {
    user.removeAttribute('data-message-author-role');
    user.removeAttribute('data-message-id');
    user.dataset.chatgptSearchUnitKey = 'turn-' + index + ':0:user';
    user.dataset.chatgptSearchMessageIds = 'user-' + index;
    const bubble = document.createElement('div');
    bubble.dataset.userMessageBubble = 'true';
    bubble.textContent = message;
    const actions = document.createElement('span');
    actions.textContent = 'Ações da mensagem';
    user.replaceChildren(bubble, actions);
    reply.removeAttribute('data-message-author-role');
    reply.removeAttribute('data-message-id');
    reply.dataset.chatgptSearchUnitKey = 'turn-' + index + ':1:assistant';
    reply.dataset.chatgptSearchMessageIds = 'assistant-' + index;
    markdown.className = '';
    markdown.dataset.markdownTextStyle = 'assistant-message';
    turn.dataset.talvtTurnState = 'streaming';
    const heading = document.createElement('h4');
    heading.textContent = 'ChatGPT disse:';
    const reasoning = document.createElement('div');
    reasoning.dataset.markdownTextStyle = 'secondary';
    reasoning.className = 'markdown';
    reasoning.textContent = 'Pensamento que não faz parte da resposta';
    reply.append(heading);
    if (window.activityStatusOnly) {
      turn.dataset.talvtTurnState = 'complete';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-busy', 'true');
      const statusLabel = document.createElement('span');
      statusLabel.className = 'sr-only';
      statusLabel.textContent = window.activityStatusLabel || 'ChatGPT está respondendo';
      const dot = document.createElement('span');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.cssText = 'display:inline-block;width:12px;height:12px;background:#aaa;border-radius:50%';
      status.append(statusLabel, dot);
      // O status real é irmão do turno interno, dentro do wrapper com chave.
      const wrapper = document.createElement('div');
      wrapper.dataset.turnKey = 'status-turn-' + index;
      turn.prepend(user);
      wrapper.append(turn, status);
      turnContainer = wrapper;
      window.lastGenerationStatus = status;
    } else if (window.activityThinking) {
      const activity = document.createElement('div');
      const header = document.createElement('div');
      header.className = 'group/activity-header';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-labelledby', 'thinking-' + index);
      const label = document.createElement('span');
      label.id = 'thinking-' + index;
      label.textContent = 'Pensou por 2s';
      header.append(toggle, label);
      activity.append(header);
      reasoning.dataset.markdownTextStyle = 'assistant-message';
      reasoning.dataset.markdownTextTone = 'primary';
      reasoning.textContent = 'Conferindo';
      let staged = false;
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        if (expanded) { reasoning.remove(); } else {
          activity.append(reasoning);
          window.thinkingOpenCount = (window.thinkingOpenCount || 0) + 1;
          if (!staged) {
            staged = true;
            setTimeout(() => { reasoning.textContent = 'Conferindo a solicitação.'; }, 350);
            setTimeout(() => { reasoning.textContent = 'Verificação concluída.'; }, 700);
          }
        }
      });
      window.lastThinkingToggle = toggle;
      window.lastThinkingContent = reasoning;
      const wrapper = document.createElement('div');
      wrapper.dataset.contentSearchTurnKey = 'thinking-turn-' + index;
      wrapper.append(turn, activity);
      turnContainer = wrapper;
    } else if (window.streamThoughts) {
      // Como na página real, o DOM do raciocínio deriva do SSE já recebido.
      window.pageStream.then(() => reply.append(reasoning));
    } else {
      reply.append(reasoning);
    }
    // O controle de copiar pode existir antes de terminar a geração.
    const copy = document.createElement('button');
    copy.dataset.testid = 'copy-turn-action-button';
    copy.textContent = 'Copiar';
    turn.appendChild(copy);
    button.dataset.testid = '';
    button.setAttribute('aria-label', 'Parar');
    // Simula a remontagem de uma mensagem antiga após o envio.
    const old = document.querySelector('[data-chatgpt-search-message-ids="old-assistant"]');
    if (old) { document.getElementById('messages').appendChild(old.cloneNode(true)); }
  }
  if (!window.activityStatusOnly) {
    reply.appendChild(markdown);
    turn.appendChild(reply);
  }
  document.getElementById('messages').appendChild(turnContainer);
  setTimeout(() => {
    if (window.activityStatusOnly) {
      window.lastGenerationStatus.remove();
      reply.appendChild(markdown);
      turn.appendChild(reply);
    }
    if (window.activityThinking && window.removeThinkingBeforeFinal) {
      window.lastThinkingContent.textContent = 'Resumo completo antes de desmontar.';
      window.lastThinkingContent.remove();
      window.lastThinkingToggle.parentElement.parentElement.remove();
    }
    if (window.richReply) { markdown.innerHTML = window.richReply; } else { markdown.textContent = 'Resposta final: ' + message; }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.testid = 'copy-turn-action-button';
    copy.textContent = 'Copiar';
    turn.appendChild(copy);
    button.dataset.testid = 'send-button';
    button.setAttribute('aria-label', 'Enviar mensagem');
    button.textContent = 'Enviar';
    button.disabled = true;
    if (window.modernMarkup) {
      turn.dataset.talvtTurnState = 'complete';
      button.dataset.testid = '';
    }
  }, window.responseDelay);
  return true;
};
button.addEventListener('click', () => window.submitMessage(editor.innerText.trim()));
window.enableDirectSubmit = () => {
  const form = editor.closest('form');
  window.directCalls = [];
  window.directProps = {
    conversationId: location.pathname.split('/c/')[1],
    composerController: { view: { dom: editor } },
    onPromptChange: () => {}, onStop: () => {},
    attachments: [], mcpAppAttachments: [], commentAttachments: [], selectedTextAttachments: [],
    async onSubmit(message, navigation, options) {
      window.directCalls.push({ message, navigation, preserveDraft: options.preserveDraft });
      if (window.directSubmitDelay) { await new Promise(resolve => setTimeout(resolve, window.directSubmitDelay)); }
      if (!options.isSubmissionCurrent() || window.directResult === false) { return false; }
      const accepted = window.submitMessage(message, options);
      if (window.directError) { throw new Error('Falha após chamar o envio nativo'); }
      return accepted;
    }
  };
  form.__reactFiber$bridgeTest = { memoizedProps: { onSubmit: () => { throw new Error('Não chamar o submit do form'); } },
    return: { memoizedProps: window.directProps, return: null } };
};
</script></body></html>`;

async function eventually(getter, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getter();
    if (result) { return result; }
    await wait(50);
  }
  throw new Error('Condição não satisfeita no teste de UI.');
}

// SSE no formato do ChatGPT (delta encoding v1): etapas de raciocínio em
// mensagens `thoughts`, campos herdados, patch e o título final no passado.
function thoughtStream({ message, conversation, turn }) {
  const thought = (id, thoughts, turnId = turn) => ({
    message: { id, author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts }, metadata: { turn_exchange_id: turnId } },
    conversation_id: conversation
  });
  const delta = (data) => `event: delta\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    'event: delta_encoding\ndata: "v1"\n\n',
    `data: ${JSON.stringify({ type: 'input_message', conversation_id: conversation, input_message: {
      author: { role: 'user' }, content: { content_type: 'text', parts: [message] }, metadata: { turn_exchange_id: turn } } })}\n\n`,
    delta({ p: '', o: 'add', v: thought('foreign', [{ summary: 'Outro turno', content: 'Não deve aparecer.' }], 'turn-other'), c: 0 }),
    delta({ p: '', o: 'add', v: thought('t1', [{ summary: 'Lendo o pedido', content: 'Estou conferindo', finished: false }]), c: 1 }),
    delta({ p: '/message/content/thoughts/0/content', o: 'append', v: ' a mensagem' }),
    delta({ v: ' recebida, com acentuação.' }),
    delta({ p: '/message/content/thoughts', o: 'append', v: [{ summary: 'Leu o pedido', content: '', finished: true }] }),
    delta({ p: '', o: 'add', v: thought('t2', [{ summary: 'Conferindo a resposta', content: '' }]), c: 2 }),
    delta({ o: 'patch', v: [{ p: '/message/content/thoughts/0/content', o: 'append', v: 'Tudo certo.' },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' }] }),
    ': ping\n\n',
    'data: [DONE]\n\n'
  ].join('');
  // Quebra em bytes, inclusive no meio de caracteres UTF-8 e de eventos.
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 37) {
        controller.enqueue(bytes.slice(offset, offset + 37));
        await wait(8);
      }
      controller.close();
    }
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

async function freePort() {
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', async (request) => (
    new URL(request.url).pathname === '/backend-api/f/conversation'
      ? thoughtStream(JSON.parse(await request.text()))
      : new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  ));
  const window = await eventually(() => BrowserWindow.getAllWindows()[0]);
  const shell = (script) => window.webContents.executeJavaScript(script, true);
  await eventually(() => !window.webContents.isLoading());
  await eventually(() => shell('Boolean(window.chatClient && document.getElementById("serverForm"))'));
  const contents = await eventually(() => window.contentView.children
    .map((view) => view.webContents).find((view) => view.getURL().startsWith('https://chatgpt.com')));
  const page = (script) => contents.executeJavaScript(script, true).catch((error) => {
    throw new Error(`${error.message}\nScript: ${script}`, { cause: error });
  });
  await eventually(() => page('Boolean(window.__chatClientAppServer && window.sentMessages)'));
  const restored = await shell('window.chatClient.getState()');
  assert.equal(restored.appServer.port, 8791);
  assert.equal(restored.appServer.key, 'persisted-key');
  assert.equal(restored.restoreWorkspaceEnabled, false);
  const port = await freePort();

  // Habilita pelo modal, usando a ponte real do preload e o processo principal.
  await shell(`
    document.getElementById('settingsButton').click();
    document.getElementById('serverPortInput').value = ${port};
    document.getElementById('serverKeyInput').value = 'ui-test-key';
    document.getElementById('serverKeyInput').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('serverSwitch').click();
  `);
  await eventually(() => shell('window.chatClient.getState().then(state => state.appServer.running)'));
  const request = (text, options = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ui-test-key' },
    body: JSON.stringify({ model: 'active-chat', messages: [
      { role: 'system', content: 'Não deve ser encaminhado' },
      { role: 'user', content: 'Histórico que não deve ser encaminhado' },
      { role: 'assistant', content: 'Outra resposta antiga' },
      { role: 'user', content: text }
    ], ...options })
  });

  let response = await request('Sem conversa');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'no_active_chat');
  assert.deepEqual(await page('window.sentMessages'), []);

  await page('history.pushState({}, "", "/c/conversa-existente");');
  response = await request('Mensagem nova\nSegunda linha');
  const firstAnswer = await response.json();
  assert.equal(response.status, 200, JSON.stringify(firstAnswer));
  assert.equal(firstAnswer.choices[0].message.content, 'Resposta final: Mensagem nova\nSegunda linha');
  assert.deepEqual(await page('window.sentMessages'), ['Mensagem nova\nSegunda linha']);

  response = await request('Teste SSE', { stream: true });
  const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map(JSON.parse);
  assert.equal(events.map((event) => event.choices[0].delta.content || '').join(''), 'Resposta final: Teste SSE');

  // Um rascunho digitado pelo humano fica intacto.
  await page('document.getElementById("prompt-textarea").textContent = "Rascunho do Alex";');
  response = await request('Não sobrescrever');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'composer_not_empty');
  assert.equal(await page('document.getElementById("prompt-textarea").innerText'), 'Rascunho do Alex');
  await page(`
    document.getElementById('prompt-textarea').replaceChildren();
    window.blockSend = () => { document.getElementById('composer-submit-button').disabled = true; };
    document.getElementById('prompt-textarea').addEventListener('input', window.blockSend);
  `);
  const controller = new AbortController();
  const canceled = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer ui-test-key' }, signal: controller.signal,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Cancelar antes de enviar' }] })
  }).catch((error) => error);
  await eventually(() => page('document.getElementById("prompt-textarea").innerText === "Cancelar antes de enviar"'));
  controller.abort();
  await canceled;
  await eventually(() => page('!document.getElementById("prompt-textarea").innerText.trim()'));
  assert.equal(await page('window.sentMessages.includes("Cancelar antes de enviar")'), false);
  await page(`
    document.getElementById('prompt-textarea').removeEventListener('input', window.blockSend);
    window.responseDelay = 900;
  `);

  const pending = request('Pedido demorado');
  await eventually(() => page('window.sentMessages.includes("Pedido demorado")'));
  response = await request('Pedido simultâneo');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'chat_busy');
  assert.equal((await (await pending).json()).choices[0].message.content, 'Resposta final: Pedido demorado');

  const changed = request('Troca de conversa');
  await eventually(() => page('window.sentMessages.includes("Troca de conversa")'));
  await page('history.pushState({}, "", "/c/outra-conversa");');
  response = await changed;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'chat_changed');
  await eventually(() => page('document.getElementById("composer-submit-button").dataset.testid === "send-button"'));

  // Estrutura atual do ChatGPT: editor sem id, marcadores de busca nas mensagens
  // e conclusão explícita do turno, sem os seletores legados.
  await page(`(() => {
    window.modernMarkup = true;
    window.responseDelay = 650;
    const form = document.querySelector('form');
    form.removeAttribute('data-type');
    form.setAttribute('data-chatgpt-composer', '');
    const editor = document.getElementById('prompt-textarea');
    editor.removeAttribute('id');
    editor.setAttribute('data-composer-markdown', '');
    const button = document.getElementById('composer-submit-button');
    button.removeAttribute('id');
    button.dataset.testid = '';
    for (const message of document.querySelectorAll('[data-message-author-role]')) {
      const role = message.dataset.messageAuthorRole;
      message.dataset.chatgptSearchUnitKey = message.dataset.messageId + ':' + role;
      message.dataset.chatgptSearchMessageIds = message.dataset.messageId;
      message.removeAttribute('data-message-author-role');
      message.removeAttribute('data-message-id');
      if (role === 'assistant') {
        const markdown = message.querySelector('.markdown');
        markdown.className = '';
        markdown.dataset.markdownTextStyle = 'assistant-message';
        message.closest('article').dataset.talvtTurnState = 'complete';
      }
    }
  })()`);
  response = await request('ChatGPT atual\nSegunda linha');
  const modernAnswer = await response.json();
  assert.equal(response.status, 200, JSON.stringify(modernAnswer));
  assert.equal(modernAnswer.choices[0].message.content, 'Resposta final: ChatGPT atual\nSegunda linha');
  assert.equal(modernAnswer.choices[0].message.reasoning_content, 'Pensamento que não faz parte da resposta');
  assert.equal(await page('window.sentMessages.at(-1)'), 'ChatGPT atual\nSegunda linha');

  // A resposta renderizada volta como o markdown de origem, não como o texto plano da tela.
  const richHtml = [
    '<h2>Título</h2>',
    '<p><span>Texto com </span><strong><span>negrito</span></strong><span>, </span><span data-markdown-copy="inline-code">código</span><span> e </span><a href="https://example.com/x">link</a><span>.</span></p>',
    '<ul><li><span>um</span></li><li><span>dois</span><ul><li><span>aninhado</span></li></ul></li></ul>',
    '<ol start="3"><li><span>três</span></li><li><span>quatro</span></li></ol>',
    '<blockquote><p><span>Citação com </span><strong><span>ênfase</span></strong></p></blockquote>',
    '<div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><svg></svg><div>Bash</div><button type="button">Copiar</button></div><div><code><span>echo "a"</span>\n<span>ls</span></code></div></div>',
    '<div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>Texto simples</div><button type="button">Copiar</button></div><div><code>```\nx\n```</code></div></div>',
    '<div><table><thead><tr><th>Nome</th><th align="right">Valor</th></tr></thead><tbody><tr><td>a | b</td><td align="right">1</td></tr></tbody></table><div data-markdown-copy="exclude"><button type="button">Copiar tabela</button></div></div>',
    '<hr>',
    '<p><span>Fim.</span><span data-markdown-copy="contents"><a href="https://docs.example"><span>Doc</span><span>+1</span></a></span></p>'
  ].join('');
  const richMarkdown = [
    '## Título',
    'Texto com **negrito**, `código` e [link](https://example.com/x).',
    '- um\n- dois\n  - aninhado',
    '3. três\n4. quatro',
    '> Citação com **ênfase**',
    '```bash\necho "a"\nls\n```',
    '````text\n```\nx\n```\n````',
    '| Nome | Valor |\n| --- | ---: |\n| a \\| b | 1 |',
    '---',
    'Fim.[Doc](https://docs.example)'
  ].join('\n\n');
  await page(`window.richReply = ${JSON.stringify(richHtml)};`);
  response = await request('Resposta formatada');
  const richAnswer = await response.json();
  assert.equal(response.status, 200, JSON.stringify(richAnswer));
  assert.equal(richAnswer.choices[0].message.content, richMarkdown);
  await page('window.richReply = null;');

  // Contrato encontrado na página real: onSubmit do componente, com texto,
  // flags nativas e guarda de cancelamento. O editor e o onSubmit do form não são usados.
  await page('window.enableDirectSubmit(); window.responseDelay = 250; window.inputEvents = 0;');
  response = await request('Direto\nSegunda linha');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Resposta final: Direto\nSegunda linha');
  assert.deepEqual(await page('window.directCalls'), [{ message: 'Direto\nSegunda linha', navigation: undefined, preserveDraft: true }]);
  assert.equal(await page('window.inputEvents'), 0);
  assert.equal(await page('document.querySelector("form [contenteditable]").innerText.trim()'), '');

  // Rascunho, anexos e bloqueios continuam protegidos mesmo sem usar o input.
  await page('document.querySelector("form [contenteditable]").textContent = "Rascunho direto";');
  response = await request('Não apagar rascunho');
  assert.equal((await response.json()).error.code, 'composer_not_empty');
  assert.equal(await page('document.querySelector("form [contenteditable]").innerText'), 'Rascunho direto');
  await page('document.querySelector("form [contenteditable]").replaceChildren(); window.directProps.attachments = [{}];');
  response = await request('Não enviar anexos humanos');
  assert.equal((await response.json()).error.code, 'composer_not_empty');
  await page('window.directProps.attachments = []; window.directProps.submissionBlocked = true;');
  response = await request('Envio bloqueado pelo provedor');
  assert.equal((await response.json()).error.code, 'send_unavailable');
  assert.equal(await page('window.directCalls.length'), 1);
  await page('window.directProps.submissionBlocked = false; window.directResult = false;');
  response = await request('Rejeitar envio direto');
  assert.equal((await response.json()).error.code, 'send_unavailable');
  assert.equal(await page('window.sentMessages.includes("Rejeitar envio direto")'), false);
  assert.equal(await page('window.inputEvents'), 0);

  // Desconectar durante a preparação nativa invalida a guarda e impede o envio.
  await page('window.directResult = true; window.directSubmitDelay = 450;');
  const directController = new AbortController();
  const canceledDirect = fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ui-test-key' }, signal: directController.signal,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Cancelar envio direto' }] })
  }).catch((error) => error);
  await eventually(() => page('window.directCalls.at(-1).message === "Cancelar envio direto"'));
  directController.abort();
  await canceledDirect;
  await wait(600);
  assert.equal(await page('window.sentMessages.includes("Cancelar envio direto")'), false);
  assert.equal(await page('window.inputEvents'), 0);

  const draftDuringSend = request('Rascunho durante envio direto');
  await eventually(() => page('window.directCalls.at(-1).message === "Rascunho durante envio direto"'));
  await page('document.querySelector("form [contenteditable]").textContent = "Rascunho enquanto prepara";');
  assert.equal((await (await draftDuringSend).json()).error.code, 'send_unavailable');
  assert.equal(await page('document.querySelector("form [contenteditable]").innerText'), 'Rascunho enquanto prepara');
  assert.equal(await page('window.sentMessages.includes("Rascunho durante envio direto")'), false);
  await page('document.querySelector("form [contenteditable]").replaceChildren();');

  const originalPath = await page('location.pathname');
  const changedDirect = request('Troca antes de efetivar envio direto');
  await eventually(() => page('window.directCalls.at(-1).message === "Troca antes de efetivar envio direto"'));
  await page('history.pushState({}, "", "/c/troca-direta");');
  assert.equal((await (await changedDirect).json()).error.code, 'chat_changed');
  assert.equal(await page('window.sentMessages.includes("Troca antes de efetivar envio direto")'), false);
  await page(`history.pushState({}, "", ${JSON.stringify(originalPath)}); window.directSubmitDelay = 0; window.directError = true;`);
  response = await request('Falha depois de aceitar');
  assert.equal((await response.json()).error.code, 'send_unavailable');
  await eventually(() => page(`Boolean(document.querySelector('form button[aria-label="Enviar mensagem"]'))`));
  assert.equal(await page('window.sentMessages.filter(text => text === "Falha depois de aceitar").length'), 1);
  assert.equal(await page('window.inputEvents'), 0);
  await page('window.directError = false; window.responseDelay = 150;');
  const longMessage = 'Linha de teste sem passar pelo editor.\n'.repeat(2048).trim();
  response = await request(longMessage);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Resposta final: ' + longMessage);
  assert.equal(await page('window.inputEvents'), 0);

  // ChatGPT real: as etapas de raciocínio vêm do SSE da página, com título e
  // texto, e substituem a leitura do DOM (que só mostra os títulos).
  const streamedThinking = '**Lendo o pedido**\n\nEstou conferindo a mensagem recebida, com acentuação.' +
    '\n\n**Conferindo a resposta**\n\nTudo certo.';
  await page('window.streamThoughts = true; window.responseDelay = 900;');
  response = await request('Thinking pelo stream', { stream: true });
  const streamText = await response.text();
  const streamEvents = streamText.split('\n\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map(JSON.parse);
  assert.equal(streamEvents.map((event) => event.choices[0].delta.reasoning_content || '').join(''), streamedThinking);
  assert.equal(streamEvents.map((event) => event.choices[0].delta.content || '').join(''), 'Resposta final: Thinking pelo stream');
  assert.ok(streamText.indexOf('reasoning_content') < streamText.indexOf('Resposta final:'));
  await eventually(() => page('window.pageStreamText?.endsWith("data: [DONE]\\n\\n")'));
  response = await request('Thinking pelo stream em JSON');
  const streamedAnswer = (await response.json()).choices[0].message;
  assert.equal(streamedAnswer.reasoning_content, streamedThinking);
  assert.equal(streamedAnswer.content, 'Resposta final: Thinking pelo stream em JSON');
  // O stream de outra mensagem é ignorado e o pedido volta a usar o DOM.
  await page('window.streamInput = "Mensagem de outro envio";');
  response = await request('Stream de outra mensagem');
  assert.equal((await response.json()).choices[0].message.reasoning_content, 'Pensamento que não faz parte da resposta');
  await page('window.streamThoughts = false; window.streamInput = null; window.responseDelay = 150;');
  await page('window.activityThinking = true; window.responseDelay = 1800;');

  // O painel atual usa aria-labelledby e monta seu markdown só ao abrir.
  // Thinking aparece no SSE antes do fim e nunca entra no content.
  response = await request('Thinking em tempo real', { stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let thinkingStream = '';
  while (!thinkingStream.includes('reasoning_content')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    thinkingStream += decoder.decode(value, { stream: true });
  }
  assert.equal(await page('document.querySelector("form button[aria-label=Parar]") !== null'), true);
  assert.doesNotMatch(thinkingStream, /Resposta final:/);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { break; }
    thinkingStream += decoder.decode(value, { stream: true });
  }
  const thinkingEvents = thinkingStream.split('\n\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map(JSON.parse);
  assert.equal(thinkingEvents.map((event) => event.choices[0].delta.reasoning_content || '').join(''),
    'Conferindo a solicitação.\n\nVerificação concluída.');
  assert.equal(thinkingEvents.map((event) => event.choices[0].delta.content || '').join(''), 'Resposta final: Thinking em tempo real');
  await eventually(() => page('window.lastThinkingToggle.getAttribute("aria-expanded") === "false"'));
  assert.equal(await page('window.thinkingOpenCount'), 1);
  assert.equal(await page('window.inputEvents'), 0);
  await page('window.removeThinkingBeforeFinal = true;');
  response = await request('Thinking desmontado');
  const unmounted = (await response.json()).choices[0].message;
  assert.equal(unmounted.reasoning_content,
    'Conferindo a solicitação.\n\nVerificação concluída.\n\nResumo completo antes de desmontar.');
  assert.equal(unmounted.content, 'Resposta final: Thinking desmontado');
  await page('window.activityThinking = false; window.responseDelay = 150;');

  // Um indicador acessível de geração não contém raciocínio. O SSE permanece
  // aberto até a resposta, sem usar o status atual ou antigo como thinking.
  await page(`
    window.activityStatusOnly = true;
    window.responseDelay = 1200;
    const oldStatus = document.createElement('span');
    oldStatus.id = 'old-generation-status';
    oldStatus.setAttribute('role', 'status');
    oldStatus.setAttribute('aria-busy', 'true');
    oldStatus.textContent = 'ChatGPT is responding';
    document.querySelector('article').append(oldStatus);
  `);
  response = await request('Indicador sem resumo', { stream: true });
  const statusReader = response.body.getReader();
  const firstStatusChunk = await statusReader.read();
  assert.equal(firstStatusChunk.done, false);
  let statusStream = decoder.decode(firstStatusChunk.value, { stream: true });
  assert.equal(await page('window.lastGenerationStatus.isConnected'), true);
  assert.doesNotMatch(statusStream, /Resposta final:/);
  assert.doesNotMatch(statusStream, /reasoning_content/);
  for (;;) {
    const { value, done } = await statusReader.read();
    if (done) { break; }
    statusStream += decoder.decode(value, { stream: true });
  }
  const statusEvents = statusStream.split('\n\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map(JSON.parse);
  assert.equal(statusEvents.some((event) => 'reasoning_content' in event.choices[0].delta), false);
  assert.equal(statusEvents.map((event) => event.choices[0].delta.content || '').join(''),
    'Resposta final: Indicador sem resumo');
  await page(`window.responseDelay = 450; window.activityStatusLabel = 'ChatGPT is responding';`);
  response = await request('Indicador em inglês sem resumo');
  const englishStatus = (await response.json()).choices[0].message;
  assert.equal('reasoning_content' in englishStatus, false);
  assert.equal(englishStatus.content, 'Resposta final: Indicador em inglês sem resumo');
  await page(`window.responseDelay = 450; window.activityStatusLabel = 'Carregando mensagens mais antigas…';`);
  response = await request('Indicador sem relação com thinking');
  const unrelatedStatus = (await response.json()).choices[0].message;
  assert.equal('reasoning_content' in unrelatedStatus, false);
  assert.equal(unrelatedStatus.content, 'Resposta final: Indicador sem relação com thinking');
  await page(`
    window.activityStatusOnly = false;
    window.activityStatusLabel = '';
    window.responseDelay = 150;
    document.getElementById('old-generation-status').remove();
  `);

  // Sem um contrato reconhecido, a ponte continua usando o editor.
  await page('delete document.querySelector("form").__reactFiber$bridgeTest; window.inputEvents = 0;');
  response = await request('Fallback pelo editor');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Resposta final: Fallback pelo editor');
  assert.ok(await page('window.inputEvents > 0'));

  // O modo atual define o alvo sem criar uma conversa para a API.
  await shell('window.chatClient.setMode("grok")');
  const grok = await eventually(() => window.contentView.children.map((view) => view.webContents)
    .find((view) => view.getURL().startsWith('https://grok.com')));
  const grokPage = (script) => grok.executeJavaScript(script, true);
  await eventually(() => grokPage('Boolean(window.__chatClientAppServer && window.sentMessages)'));
  response = await request('Grok sem conversa');
  assert.equal((await response.json()).error.code, 'no_active_chat');
  await grokPage(`
    history.pushState({}, '', '/c/grok-existente');
    const old = document.getElementById('prompt-textarea');
    const textarea = document.createElement('textarea');
    textarea.id = 'grok-composer';
    old.replaceWith(textarea);
    textarea.addEventListener('input', () => {
      old.innerText = textarea.value;
      document.getElementById('composer-submit-button').disabled = !textarea.value.trim();
    });
    window.responseDelay = 100;
  `);
  response = await request('Mensagem no Grok');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Resposta final: Mensagem no Grok');
  assert.deepEqual(await grokPage('window.sentMessages'), ['Mensagem no Grok']);

  await shell('window.chatClient.setMode("compare")');
  contents.focus();
  await eventually(() => shell('window.chatClient.getState().then(state => state.appServer.targetProvider === "chatgpt")'));
  response = await request('Chat selecionado no modo Comparar');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Resposta final: Chat selecionado no modo Comparar');

  // Mudanças de estado não apagam campos ainda não salvos no modal.
  await shell(`
    document.getElementById('serverHostInput').value = 'localhost';
    document.getElementById('serverHostInput').dispatchEvent(new Event('input', { bubbles: true }));
    window.chatClient.setAppReasoningLevel('medium');
  `);
  assert.equal(await shell('document.getElementById("serverHostInput").value'), 'localhost');
  await wait(350);
  const saved = JSON.parse(readFileSync(join(profile, 'session-state.json'), 'utf8'));
  assert.deepEqual(saved.appServer, { enabled: true, host: '127.0.0.1', port, key: 'ui-test-key' });
  assert.equal(saved.restoreWorkspaceEnabled, false);
  await shell('document.getElementById("serverForm").scrollIntoView({ block: "center" });');
  const layout = await shell(`(() => {
    const form = document.getElementById('serverForm').getBoundingClientRect();
    const card = document.querySelector('.settings-card').getBoundingClientRect();
    return { width: form.width, cardWidth: card.width, overflow: document.querySelector('.settings-card').scrollWidth > document.querySelector('.settings-card').clientWidth };
  })()`);
  assert.equal(layout.overflow, false);
  assert.ok(layout.width < layout.cardWidth);
  const screenshotPath = join(tmpdir(), 'chatclient-server-ui.png');
  writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  await shell('document.getElementById("serverSwitch").click();');
  await eventually(() => shell('window.chatClient.getState().then(state => !state.appServer.running)'));
  console.log('Testes integrados Electron: OK. Modal, HTTP, ChatGPT/Grok, SSE, thinking ao vivo, envio direto, fallback, rascunho, cancelamento, concorrência e troca de conversa.');
  console.log(`Screenshot do modal: ${screenshotPath}`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('quit', () => rmSync(profile, { recursive: true, force: true }));
require('../main');
