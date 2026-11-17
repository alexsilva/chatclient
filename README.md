# ChatClient

Cliente desktop Electron para usar múltiplos provedores de IA em uma única interface. ChatGPT, Grok e Claude são carregados em `WebContentsView` independentes e persistentes.

## Interface

O shell do ChatClient oferece três provedores e um modo de comparação:

- **ChatGPT** — exibe `https://chatgpt.com`.
- **Grok** — exibe `https://grok.com/`.
- **Claude** — exibe `https://claude.ai/`.
- **Comparar** — exibe os dois provedores lado a lado com divisor ajustável.

Os provedores permanecem vivos ao alternar entre os modos, evitando reload desnecessário e preservando a sessão de cada serviço.

### Atalhos

- `Alt+1`: ChatGPT
- `Alt+2`: Grok
- `Alt+3`: Comparar
- `Alt+4`: Claude
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

A ponte oferece `GET /v1/models` e `POST /v1/chat/completions`, com o formato de [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Ela envia **somente o texto da última mensagem `user`** à conversa atual e devolve o corpo da resposta exibida. Histórico recebido, mensagens `system`/`developer` e parâmetros de geração não são enviados ao chat. Nenhuma conversa é criada, selecionada ou mantida pelo servidor.

No ChatGPT, a ponte chama o callback nativo de envio com o texto completo, sem preencher nem processar o editor. O histórico, o modelo e o transporte continuam sendo os da página. Se esse contrato não estiver disponível, ela usa o campo e o botão de envio; o Grok também usa esse caminho. Depois de tentar o callback, uma falha retorna erro sem repetir o envio pelo botão, para evitar mensagens duplicadas.

ChatGPT e Grok usam a view já aberta. No modo **Comparar**, o alvo é o último chat que recebeu foco; cada pedido permanece ligado àquela conversa até terminar. A mensagem enviada e a resposta ficam na UI do provedor e são retornadas ao cliente.

O resumo de raciocínio é devolvido em `message.reasoning_content` no JSON, separado de `message.content`. No ChatGPT, a ponte lê uma cópia do SSE que a própria página recebe para o pedido (`/backend-api/f/conversation`) e extrai as etapas `thoughts`, na ordem em que chegam: o título em negrito e o texto de cada etapa. É o mesmo resumo do painel de atividade do ChatGPT, não os tokens internos do modelo; o DOM mostra só os títulos. Respostas rápidas costumam não ter etapas (a UI mostra apenas “Pensou por Xs”), e então o campo é omitido.

Sem esse stream, e no Grok, a ponte lê os resumos visíveis no DOM: abre os painéis “Pensando”/“Pensou…” do pedido atual quando necessário e os recolhe ao terminar. Indicadores como “ChatGPT está respondendo” e rótulos como “Pensando” não são enviados nesse campo. Os resumos capturados são preservados como um transcript, inclusive quando a página substitui ou recolhe um resumo durante a geração.

`stream: true` retorna SSE: o thinking é entregue durante a geração em `delta.reasoning_content` e, no ChatGPT, a resposta final é encaminhada incrementalmente em `delta.content` a partir do SSE nativo da página. Quando o provedor conclui a mensagem final, a ponte envia `finish_reason: stop` e `[DONE]`; o DOM continua sendo usado como fallback quando esse stream não está disponível. O timeout da ponte é de inatividade: atividade real do stream renova o prazo, portanto execuções longas não são encerradas apenas por ultrapassarem 10 minutos. O Quimera já interpreta `reasoning_content`; outros clientes precisam reconhecer essa extensão. Não há estimativa de consumo de tokens. A ponte aceita texto; anexos e chamadas de ferramentas não são convertidos em respostas da API.

Na versão **1.0.6**, o servidor HTTP adia o status `200`/SSE até receber o primeiro delta (texto ou thinking) ou até concluir a resposta. Assim, se a mensagem for enviada, mas a captura do primeiro resultado falhar, o cliente recebe o **HTTP 4xx/5xx correto em JSON**, em vez de um SSE iniciado falsamente como sucesso com erro interno. Depois do primeiro delta, erros ainda são enviados como evento de erro no próprio SSE, sem criar uma conclusão artificial. A interface da página continua sendo a fonte de verdade; a API não sintetiza respostas.

Abra uma conversa existente antes de usar o servidor. Com uma geração em andamento, a ponte faz o mesmo que o botão **Enviar** da UI: no ChatGPT, turnos que aceitam steering recebem a mensagem no próprio turno e a resposta final do turno é devolvida ao cliente, lida do SSE que a página já tinha aberto. Quando a UI não aceita mensagens durante a geração (por exemplo, no Grok), o envio espera o turno terminar, limitado pelo timeout de inatividade. Se houver um rascunho, anexos no composer nativo ou outro pedido pendente, a ponte retorna um erro sem sobrescrever o campo. Trocar de conversa durante o pedido também retorna erro. Desconectar o cliente cancela a espera; a guarda nativa invalida um envio direto ainda em preparação, e a geração já iniciada permanece na UI.

Exemplo:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer SUA_CHAVE' \
  -H 'Content-Type: application/json' \
  -d '{"model":"active-chat","messages":[{"role":"user","content":"Olá"}]}'
```

## Múltiplas instâncias locais

O ChatClient 1.0.5 isola **as configurações por processo** para permitir
que Quimera conecte várias janelas independentes sem sobrescrever
a porta/chave do servidor de outra janela. Um lease atômico reserva um slot:
a primeira instância usa a porta inicial `8787`, a segunda `8788`
e a terceira `8789` (até oito janelas); alterações de porta feitas na
interface são preservadas para aquele slot. É possível fixar a identidade
ao lançar com `--chatclient-instance=0`, `=1`, `=2`, etc.
Um slot já ocupado é recusado, em vez de compartilhar a mesma configuração.

As preferências são gravadas em
`~/.config/chatclient/session-state.instance-N.json`, e as antigas
`session-state.json` são **apenas lidas** na migração inicial, preservando
a chave configurada. O diretório Chromium e a sessão autenticada não são
apagados, movidos nem copiados. Cada processo possui um servidor HTTP
independente, e as portas devem coincidir com a configuração Quimera
de cada variante. Os processos já abertos com versões antigas continuam
com a lógica antiga até serem reiniciados.

O envio ao ChatGPT primeiro utiliza o callback nativo quando reconhecido.
Se o callback não estiver disponível, a ponte faz a digitação usando
`WebContents.insertText` do Electron, em vez de editar o HTML do campo.
A API só confirma o envio após recibo de mensagem vinculada no DOM ou SSE;
chamar o botão isoladamente não basta. Em erros ambíguos, ela falha
com `send_unconfirmed` (HTTP 422, sem retry automático) **sem repetir
a mensagem**. Qualquer falha depois que a mensagem pode ter chegado ao
chat (`chat_changed`, `chat_timeout`, `provider_error` etc.) também
responde HTTP 422 com `x-should-retry: false`, mantendo o `code` original:
clientes OpenAI-compatible repetem 408/409/5xx, e a repetição duplicaria
a mensagem na conversa. Uma resposta final identificada pelo SSE
pode ser retornada mesmo quando o ChatGPT virtualiza a bolha do usuário.
Com o SSE vinculado, a bolha exibida não precisa ter o texto exato do
pedido (o ChatGPT pode formatar o markdown); outra bolha nova depois dela
continua sendo tratada como `chat_changed`.

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

Em dev, `injections/app-server.js` é relido a cada pedido da ponte. Alterações em `main.js` ou no servidor HTTP ainda exigem reiniciar o aplicativo.

Com o modo debug ativo, o console das views é reemitido no processo principal e sai junto do `npm start`:

- mensagens do próprio ChatClient, sempre. Elas levam o prefixo `[chatclient…]`, e o rótulo à frente diz de qual view vieram (`[chatgpt]`, `[shell]`, `[rail]`…).
- erros das views do shell, porque exceção não capturada é o que mais interessa em depuração. Na página do provedor eles não passam: ali o log viraria o console do site.

### Prévia do shell no navegador

A interface própria do ChatClient pode ser testada isoladamente sem abrir os provedores reais:

```bash
npm run preview
```

Abra `http://127.0.0.1:4173`.

No modo de prévia, placeholders representam os `WebContentsView` de ChatGPT, Grok e Claude. Isso permite validar layout, responsividade e interações do shell diretamente no browser.

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
├── WebContentsView: Grok
│   └── https://grok.com/
└── WebContentsView: Claude
    └── https://claude.ai/

Comparar: ChatGPT + Grok
```

`main.js` controla ciclo de vida, navegação e layout dos provedores. `app-server.js` oferece o servidor HTTP e chama a ponte da view ativa; `injections/app-server.js` envia pelo callback nativo do ChatGPT (ou pelo campo da página) e observa o thinking visível e a resposta. `preload.js` expõe apenas a ponte IPC necessária ao shell. Scripts específicos de páginas ficam em `injections/`.

## Release

Tags no formato `v*` acionam o workflow de release no GitHub Actions. As notas são geradas a partir dos commits posteriores ao hash configurado em `package.json`.
