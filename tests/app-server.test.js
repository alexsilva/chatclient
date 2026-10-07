const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { AppServer, AppServerError, DEFAULT_SERVER_CONFIG, normalizeServerConfig } = require('../app-server');

async function freePort() {
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function setup(t, relay, options = {}) {
  const server = new AppServer({ relay, ...options });
  const port = await freePort();
  t.after(() => server.stop());
  await server.configure({ ...DEFAULT_SERVER_CONFIG, enabled: true, port, key: 'test-key' });
  assert.equal(server.getState().running, true);
  const request = (body, headers = {}) => fetch(`${server.getState().baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { server, request };
}

const prompt = (text = 'Última mensagem') => ({ model: 'active-chat', messages: [{ role: 'user', content: text }] });

test('valida host, porta e chave sem alterar configurações válidas', () => {
  assert.deepEqual(normalizeServerConfig(DEFAULT_SERVER_CONFIG), DEFAULT_SERVER_CONFIG);
  assert.equal(normalizeServerConfig({ ...DEFAULT_SERVER_CONFIG, host: '[::1]' }).host, '[::1]');
  for (const patch of [{ host: 'http://localhost' }, { host: 'localhost:1234' }, { port: 0 }, { port: 65536 }, { port: 1.2 }, { enabled: true }]) {
    assert.throws(() => normalizeServerConfig({ ...DEFAULT_SERVER_CONFIG, ...patch }), AppServerError);
  }
});

test('autentica completions e models; não encaminha pedidos sem chave', async (t) => {
  let calls = 0;
  const { server, request } = await setup(t, async () => { calls++; return 'Resposta'; });
  for (const key of ['', 'Bearer errada']) {
    const response = await request(prompt(), { Authorization: key });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'invalid_api_key');
  }
  assert.equal(calls, 0);
  const models = await fetch(`${server.getState().baseUrl}/models`, { headers: { Authorization: 'Bearer test-key' } });
  assert.deepEqual((await models.json()).data.map((model) => model.id), ['active-chat']);
  const preflight = await fetch(`${server.getState().baseUrl}/chat/completions`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
});

test('encaminha só a última mensagem user e devolve o texto exato da UI', async (t) => {
  const received = [];
  const { request } = await setup(t, async ({ message }) => { received.push(message); return 'Texto real\n\n```js\n1 + 1\n```'; });
  const response = await request({
    model: 'qualquer-alias',
    messages: [
      { role: 'system', content: 'Nunca encaminhar' },
      { role: 'user', content: 'Histórico antigo' },
      { role: 'assistant', content: 'Resposta antiga' },
      { role: 'user', content: [{ type: 'text', text: 'Primeira linha' }, { type: 'text', text: 'Última linha' }] }
    ]
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(received, ['Primeira linha\nÚltima linha']);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'qualquer-alias');
  assert.equal(body.choices[0].message.content, 'Texto real\n\n```js\n1 + 1\n```');
  assert.equal('usage' in body, false);
});

test('stream SSE mantém o texto, termina com stop e [DONE]', async (t) => {
  const { request } = await setup(t, async ({ onStart, onDelta }) => {
    onStart();
    onDelta('Resposta ');
    return 'Resposta final';
  });
  const response = await request({ ...prompt(), stream: true });
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || '').join(''), 'Resposta final');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('rejeita JSON inválido, imagens, mensagem vazia e pedidos grandes antes de tocar no chat', async (t) => {
  let calls = 0;
  const { request } = await setup(t, async () => { calls++; return 'Resposta'; });
  const cases = [
    ['{', 400, 'invalid_json'],
    [{ messages: [] }, 400, 'invalid_messages'],
    [prompt('  '), 400, 'invalid_messages'],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }] }, 400, 'unsupported_content'],
    [{ ...prompt(), n: 2 }, 400, 'unsupported_n'],
    [{ ...prompt(), stream: 'true' }, 400, 'invalid_stream'],
    [prompt('x'.repeat(1024 * 1024)), 413, 'body_too_large']
  ];
  for (const [body, status, code] of cases) {
    const response = await request(body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(calls, 0);
});

test('propaga ausência de conversa e libera o servidor após a falha', async (t) => {
  let attempts = 0;
  const { request, server } = await setup(t, async () => {
    if (!attempts++) { throw new AppServerError('Sem conversa ativa', 409, 'no_active_chat'); }
    return 'Resposta';
  });
  const failed = await request(prompt());
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error.code, 'no_active_chat');
  assert.equal(server.getState().busy, false);
  assert.equal((await request(prompt())).status, 200);
});

test('serializa o chat recusando um segundo pedido enquanto a resposta está pendente', async (t) => {
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { request, server } = await setup(t, async () => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = request(prompt('Primeiro'));
  await ready;
  assert.equal(server.getState().busy, true);
  const second = await request(prompt('Segundo'));
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'chat_busy');
  finish('Resposta do primeiro');
  assert.equal((await (await first).json()).choices[0].message.content, 'Resposta do primeiro');
  assert.equal(server.getState().busy, false);
});

test('timeout cancela a ponte mesmo se a UI não resolver sua promessa', async (t) => {
  let signal;
  const { request, server } = await setup(t, async (args) => { signal = args.signal; return new Promise(() => {}); }, { timeoutMs: 50 });
  const response = await request(prompt());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'chat_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(server.getState().busy, false);
});

test('desconectar um cliente cancela o pedido e permite novos pedidos', async (t) => {
  let canceled;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const cancellation = new Promise((resolve) => { canceled = resolve; });
  const { server } = await setup(t, async ({ signal }) => {
    started();
    signal.addEventListener('abort', () => canceled(signal.reason.code), { once: true });
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = fetch(`${server.getState().baseUrl}/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer test-key' },
    body: JSON.stringify(prompt()), signal: controller.signal
  }).catch((error) => error);
  await ready;
  controller.abort();
  await pending;
  assert.equal(await cancellation, 'client_disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.getState().busy, false);
});

test('informa porta ocupada, permite tentar novamente e trocar host/porta/chave', async (t) => {
  const blocker = http.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => { if (blocker.listening) { blocker.close(); } });
  const server = new AppServer({ relay: async () => 'Resposta' });
  t.after(() => server.stop());
  const config = { ...DEFAULT_SERVER_CONFIG, enabled: true, port: blocker.address().port, key: 'test-key' };
  await server.configure(config);
  assert.equal(server.getState().running, false);
  assert.match(server.getState().error, /EADDRINUSE/);
  await new Promise((resolve) => blocker.close(resolve));
  await server.configure(config);
  assert.equal(server.getState().running, true);
  const oldUrl = server.getState().baseUrl;
  await server.configure({ ...config, port: await freePort(), key: 'new-key' });
  await assert.rejects(fetch(`${oldUrl}/models`));
  const models = await fetch(`${server.getState().baseUrl}/models`, { headers: { Authorization: 'Bearer new-key' } });
  assert.equal(models.status, 200);
  await server.configure({ ...server.config, enabled: false });
  assert.equal(server.getState().running, false);
});

test('falha durante SSE é um erro e nunca uma resposta inventada', async (t) => {
  const { request } = await setup(t, async ({ onStart }) => {
    onStart();
    throw new AppServerError('A conversa mudou', 409, 'chat_changed');
  });
  const response = await request({ ...prompt(), stream: true });
  const text = await response.text();
  assert.match(text, /"code":"chat_changed"/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});
