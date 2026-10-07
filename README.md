# ChatClient

Cliente desktop Electron para usar múltiplos provedores de IA em uma única interface. A primeira versão multi-provider mantém ChatGPT e Grok carregados em `WebContentsView` independentes e persistentes.

## Interface

O shell do ChatClient fornece três modos principais:

- **ChatGPT** — exibe `https://chatgpt.com`.
- **Grok** — exibe `https://grok.com/`.
- **Comparar** — exibe os dois provedores lado a lado com divisor ajustável.

Os provedores permanecem vivos ao alternar entre os modos, evitando reload desnecessário e preservando a sessão de cada serviço.

### Atalhos

- `Alt+1`: ChatGPT
- `Alt+2`: Grok
- `Alt+3`: Comparar
- `F5` ou `Ctrl+R`: recarrega o provedor ativo; no modo Comparar recarrega ambos

## Aprovação automática de apps

O ChatClient responde pelos pedidos de permissão que os apps do ChatGPT (Quimera, conectores, MCPs) mostram no meio da conversa. A automação é injetada apenas no `WebContentsView` do ChatGPT; o botão de escudo no shell é a chave geral.

Em **Configurações**, cada app tem sua própria política:

- **Nome do app** — como ele aparece no texto do pedido. A comparação ignora acentos e caixa.
- **Ativa** — sem isso, os pedidos daquele app ficam esperando por você.
- **Atraso** — tempo entre detectar o pedido e responder, de 0 a 30 s.
- **Escopo** — `Somente esta chamada` clica em *Permitir uma vez* (*Permitir*, no layout antigo); `Toda a conversa` abre o menu ao lado do botão e escolhe a opção de conversa, quando o ChatGPT a oferece.

A política **Outros apps** é o curinga: vale para todo app sem política própria. Ela nasce desligada, porque aprovar apps que ninguém nomeou é o escopo mais amplo possível.

Quando há políticas concorrentes, a mais específica vence: um app com política própria desligada continua esperando por você mesmo com o curinga ligado.

## Servidor OpenAI para o chat ativo

Em **Configurações → Servidor OpenAI · Chat ativo**, defina **host**, **porta** e **chave (key)** e ative o interruptor. O padrão é `127.0.0.1:8787`, inicialmente desligado. A configuração é salva independentemente da opção de restaurar o workspace; o servidor acompanha o ciclo de vida do aplicativo.

Configure seu cliente com:

- **Base URL:** `http://127.0.0.1:8787/v1` (ou o host e a porta escolhidos).
- **API key:** a chave definida no modal, enviada como `Authorization: Bearer <key>`.
- **Modelo:** `active-chat`, um alias para o chat aberto. O modelo real continua sendo escolhido na interface do provedor.

A ponte oferece `GET /v1/models` e `POST /v1/chat/completions`, com o formato de [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Ela envia **somente o texto da última mensagem `user`** ao campo da conversa atual e devolve o corpo da resposta exibida. Histórico recebido, mensagens `system`/`developer` e parâmetros de geração não são enviados ao chat. Nenhuma conversa é criada, selecionada ou mantida pelo servidor.

ChatGPT e Grok usam a view já aberta. No modo **Comparar**, o alvo é o último chat que recebeu foco; cada pedido permanece ligado àquela conversa até terminar. A mensagem enviada e a resposta ficam na UI do provedor e são retornadas ao cliente.

`stream: true` retorna SSE: o conteúdo é entregue quando a UI conclui a resposta, seguido de `finish_reason: stop` e `[DONE]`. Isso evita devolver versões intermediárias alteradas pela renderização do markdown. Não há estimativa de consumo de tokens. A ponte aceita texto; anexos e chamadas de ferramentas não são convertidos em respostas da API.

Abra uma conversa existente antes de usar o servidor. Se houver um rascunho, uma geração em andamento ou outro pedido pendente, a ponte retorna um erro sem sobrescrever o campo. Trocar de conversa durante o pedido também retorna erro. Desconectar o cliente cancela a espera, e a geração já iniciada permanece na UI.

Exemplo:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer SUA_CHAVE' \
  -H 'Content-Type: application/json' \
  -d '{"model":"active-chat","messages":[{"role":"user","content":"Olá"}]}'
```

## Desenvolvimento

### Pré-requisitos

- Node.js 20+
- npm
- bibliotecas de runtime exigidas pelo Electron na distribuição Linux usada

### Instalar

```bash
npm install
```

### Executar o aplicativo

```bash
npm start
```

### Log e modo debug

O ChatClient só escreve log quando roda a partir do código-fonte. Instalado — `.deb` ou AppImage —, `app.isPackaged` é verdadeiro, o modo debug fica desligado e o cliente fica em silêncio: nem o processo principal, nem as injeções, e o Chromium reduzido a falhas fatais.

Com o modo debug ativo, o console das views é reemitido no processo principal e sai junto do `npm start`:

- mensagens do próprio ChatClient, sempre. Elas levam o prefixo `[chatclient…]`, e o rótulo à frente diz de qual view vieram (`[chatgpt]`, `[shell]`, `[rail]`…).
- erros das views do shell, porque exceção não capturada é o que mais interessa em depuração. Na página do provedor eles não passam: ali o log viraria o console do site.

### Prévia do shell no navegador

A interface própria do ChatClient pode ser testada isoladamente sem abrir os provedores reais:

```bash
npm run preview
```

Abra `http://127.0.0.1:4173`.

No modo de prévia, placeholders representam os `WebContentsView` de ChatGPT e Grok. Isso permite validar layout, responsividade e interações do shell diretamente no browser.

### Testes da ponte

`npm test` valida o servidor HTTP, autenticação, última mensagem, SSE e falhas. `npm run test:ui` testa o modal e as injeções no Electron com páginas simuladas e um perfil temporário, sem acessar conversas reais. Em Linux sem display, use `xvfb-run -a -s '-screen 0 1280x1024x24 -extension GLX' npm run test:ui`. Os seletores das páginas dependem da UI de cada provedor.

## Build Linux

```bash
npm run build:linux
```

Os artefatos são gerados em `dist/`:

- AppImage
- `.deb`

## Arquitetura

```text
BrowserWindow
├── renderer/                  # shell do ChatClient
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── WebContentsView: ChatGPT
│   └── https://chatgpt.com
└── WebContentsView: Grok
    └── https://grok.com/
```

`main.js` controla ciclo de vida, navegação e layout dos provedores. `app-server.js` oferece o servidor HTTP e chama a ponte da view ativa; `injections/app-server.js` envia pelo campo da página e observa a resposta. `preload.js` expõe apenas a ponte IPC necessária ao shell. Scripts específicos de páginas ficam em `injections/`.

## Release

Tags no formato `v*` acionam o workflow de release no GitHub Actions. As notas são geradas a partir dos commits posteriores ao hash configurado em `package.json`.
