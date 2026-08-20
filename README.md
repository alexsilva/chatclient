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

## Quimera

O ChatClient mantém a automação de auto-aprovação da Quimera para o ChatGPT. O controle visual fica no shell do aplicativo, enquanto a automação é injetada apenas no `WebContentsView` do ChatGPT.

O toggle também está disponível em **Configurações**.

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

### Prévia do shell no navegador

A interface própria do ChatClient pode ser testada isoladamente sem abrir os provedores reais:

```bash
npm run preview
```

Abra `http://127.0.0.1:4173`.

No modo de prévia, placeholders representam os `WebContentsView` de ChatGPT e Grok. Isso permite validar layout, responsividade e interações do shell diretamente no browser.

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

`main.js` controla ciclo de vida, navegação e layout dos provedores. `preload.js` expõe apenas a ponte IPC necessária ao shell. Scripts específicos de páginas ficam em `injections/`.

## Release

Tags no formato `v*` acionam o workflow de release no GitHub Actions. As notas são geradas a partir dos commits posteriores ao hash configurado em `package.json`.
