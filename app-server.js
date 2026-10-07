const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');

const DEFAULT_SERVER_CONFIG = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 8787,
  key: ''
});
const MODEL_ID = 'active-chat';
const MAX_BODY_BYTES = 1024 * 1024;

class AppServerError extends Error {
  constructor(message, status = 500, code = 'bridge_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeServerConfig(config = {}) {
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  const port = Number(config.port);
  const key = typeof config.key === 'string' ? config.key.trim() : '';
  if (!host || /[\s/\\?#]/.test(host) || (host.includes(':') && !isIP(host.replace(/^\[|\]$/g, '')))) {
    throw new AppServerError('Informe um host válido, sem protocolo ou caminho.', 400, 'invalid_host');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppServerError('A porta deve estar entre 1 e 65535.', 400, 'invalid_port');
  }
  if (/[\r\n]/.test(key) || (config.enabled && !key)) {
    throw new AppServerError('Defina uma chave para ativar o servidor.', 400, 'invalid_key');
  }
  return { enabled: Boolean(config.enabled), host, port, key };
}

function lastUserMessage(body) {
  if (!body || !Array.isArray(body.messages)) {
    throw new AppServerError('Envie messages com uma mensagem user de texto.', 400, 'invalid_messages');
  }
  const message = body.messages.findLast((item) => item?.role === 'user');
  let content = message?.content;
  if (Array.isArray(content)) {
    if (content.some((part) => part?.type !== 'text' || typeof part.text !== 'string')) {
      throw new AppServerError('A ponte aceita somente mensagens de texto.', 400, 'unsupported_content');
    }
    content = content.map((part) => part.text).join('\n');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new AppServerError('A última mensagem user deve conter texto.', 400, 'invalid_messages');
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new AppServerError('A ponte retorna uma resposta por pedido.', 400, 'unsupported_n');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new AppServerError('stream deve ser true ou false.', 400, 'invalid_stream');
  }
  return content;
}

function errorPayload(error) {
  return { error: {
    message: error.message || 'Não foi possível acessar o chat ativo.',
    type: error.status >= 500 ? 'server_error' : 'invalid_request_error',
    param: null,
    code: error.code || 'bridge_error'
  } };
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('error', failed);
      request.removeListener('aborted', aborted);
    };
    const failed = (error) => { cleanup(); reject(error); };
    const aborted = () => failed(new AppServerError('O cliente desconectou.', 400, 'client_disconnected'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed(new AppServerError('Pedido maior que 1 MiB.', 413, 'body_too_large'));
        request.resume();
      } else {
        chunks.push(chunk);
      }
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppServerError('O corpo do pedido deve ser JSON válido.', 400, 'invalid_json'));
      }
    };
    request.on('data', data);
    request.on('end', end);
    request.on('error', failed);
    request.on('aborted', aborted);
  });
}

class AppServer {
  constructor({ relay, onState = () => {}, timeoutMs = 10 * 60 * 1000 }) {
    this.relay = relay;
    this.onState = onState;
    this.timeoutMs = timeoutMs;
    this.config = { ...DEFAULT_SERVER_CONFIG };
    this.server = null;
    this.activeRequest = null;
    this.error = null;
    this.configQueue = Promise.resolve();
  }

  getState() {
    const { host, port } = this.config;
    const address = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host;
    return {
      ...this.config,
      running: Boolean(this.server?.listening),
      busy: Boolean(this.activeRequest),
      error: this.error,
      baseUrl: `http://${address}:${port}/v1`
    };
  }

  emitState() {
    this.onState(this.getState());
  }

  configure(config) {
    const next = normalizeServerConfig(config);
    const apply = async () => {
      const sameAddress = next.host === this.config.host && next.port === this.config.port;
      if (!next.enabled || !sameAddress) {
        await this.stop();
      }
      this.config = next;
      this.error = null;
      if (next.enabled && !this.server?.listening) {
        await this.start();
      }
      this.emitState();
      return this.getState();
    };
    this.configQueue = this.configQueue.catch(() => {}).then(apply);
    return this.configQueue;
  }

  async start() {
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        if (!response.destroyed && !response.writableEnded) {
          sendJson(response, error.status || 500, errorPayload(error));
        }
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    this.server = server;
    await new Promise((resolve) => {
      const failed = (error) => {
        this.error = `Não foi possível iniciar o servidor: ${error.message}`;
        this.server = null;
        resolve();
      };
      server.once('error', failed);
      server.listen(this.config.port, this.config.host.replace(/^\[|\]$/g, ''), () => {
        server.removeListener('error', failed);
        server.on('error', (error) => {
          this.error = error.message;
          this.emitState();
        });
        resolve();
      });
    });
  }

  async stop() {
    this.activeRequest?.abort(new AppServerError('O servidor foi desligado.', 503, 'server_stopped'));
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    this.emitState();
  }

  async handleRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const provided = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${this.config.key}`);
    if (!this.config.key || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppServerError('Chave inválida. Use Authorization: Bearer <key>.', 401, 'invalid_api_key');
    }
    const path = new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '');
    if (request.method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, { object: 'list', data: [
        { id: MODEL_ID, object: 'model', created: 0, owned_by: 'chatclient' }
      ] });
      return;
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      throw new AppServerError('Endpoint não encontrado.', 404, 'not_found');
    }

    const body = await readBody(request);
    const message = lastUserMessage(body);
    if (this.activeRequest) {
      throw new AppServerError('O chat está atendendo outro pedido.', 409, 'chat_busy');
    }
    if (response.destroyed) {
      return;
    }

    const controller = new AbortController();
    this.activeRequest = controller;
    this.emitState();
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof body.model === 'string' && body.model ? body.model : MODEL_ID;
    let heartbeat = null;
    let streamed = '';
    let reasoning = '';
    const event = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta, finishReason = null) => event({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
    });
    const startStream = () => {
      if (!body.stream || response.headersSent || response.destroyed) {
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive'
      });
      response.flushHeaders();
      chunk({ role: 'assistant', content: '' });
      heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
    };
    const disconnected = () => {
      if (!response.writableEnded) {
        controller.abort(new AppServerError('O cliente desconectou.', 499, 'client_disconnected'));
      }
    };
    response.on('close', disconnected);
    let timeout = null;
    const refreshTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(
        new AppServerError('Tempo esgotado aguardando a resposta do chat.', 504, 'chat_timeout')
      ), this.timeoutMs);
    };
    // timeoutMs representa inatividade, não duração total da execução.
    refreshTimeout();
    let aborted;
    const abortPromise = new Promise((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    try {
      const result = await Promise.race([
        this.relay({
          id, message, signal: controller.signal,
          onStart: () => {
            refreshTimeout();
            startStream();
          },
          onActivity: refreshTimeout,
          onDelta: (delta) => {
            refreshTimeout();
            if (body.stream && !controller.signal.aborted && !response.destroyed) {
              startStream();
              streamed += delta;
              chunk({ content: delta });
            }
          },
          onReasoningDelta: (delta) => {
            refreshTimeout();
            if (!controller.signal.aborted && !response.destroyed && typeof delta === 'string' && delta) {
              reasoning += delta;
              if (body.stream) {
                startStream();
                chunk({ reasoning_content: delta });
              }
            }
          }
        }),
        abortPromise
      ]);
      if (controller.signal.aborted || response.destroyed) {
        return;
      }
      const text = typeof result === 'string' ? result : result?.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new AppServerError('O chat não produziu uma resposta de texto.', 502, 'empty_response');
      }
      if (result?.reasoning) {
        if (typeof result.reasoning !== 'string' || !result.reasoning.startsWith(reasoning)) {
          throw new AppServerError('O thinking mudou durante o envio.', 502, 'reasoning_changed');
        }
        const rest = result.reasoning.slice(reasoning.length);
        reasoning = result.reasoning;
        if (body.stream && rest) {
          startStream();
          chunk({ reasoning_content: rest });
        }
      }
      if (body.stream) {
        startStream();
        if (result?.streamedComplete && streamed) {
          // O SSE nativo é a fonte canônica enquanto a geração acontece. A UI
          // pode reserializar o mesmo markdown de outra forma ao renderizar
          // (por exemplo, <br> vira dois espaços antes de \n), então não exige
          // igualdade textual depois que o próprio provedor marcou o stream
          // final como concluído.
        } else {
          if (!text.startsWith(streamed)) {
            throw new AppServerError('A resposta mudou durante o envio.', 502, 'response_changed');
          }
          if (text.length > streamed.length) {
            chunk({ content: text.slice(streamed.length) });
          }
        }
        chunk({}, 'stop');
        response.end('data: [DONE]\n\n');
      } else {
        sendJson(response, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: {
            role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {})
          }, logprobs: null, finish_reason: 'stop' }]
        });
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) {
          event(errorPayload(error));
          response.end('data: [DONE]\n\n');
        } else {
          sendJson(response, error.status || 500, errorPayload(error));
        }
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      response.removeListener('close', disconnected);
      controller.signal.removeEventListener('abort', aborted);
      if (this.activeRequest === controller) {
        this.activeRequest = null;
      }
      this.emitState();
    }
  }
}

module.exports = { AppServer, AppServerError, DEFAULT_SERVER_CONFIG, normalizeServerConfig };
