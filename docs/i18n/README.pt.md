<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — um painel local que fica de olho em todos os seus repos Git e sinaliza os que precisam de você" />
</p>

# repo-radar

> Plano 365 Open Source #027 · Um painel local que fica de olho em todos os seus repos Git e mostra quais precisam de você.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Você tem mais repos Git do que consegue acompanhar na mão. O repo-radar fica de olho em todos eles e mostra os poucos que precisam de você agora — para que o resto saia da sua cabeça.

Ele traz à tona o que você de outra forma esqueceria de checar:

- **Repos que você perdeu de vista** — todos os repos que você possui em uma única tela, com busca, abra qualquer um com um clique.
- **Trabalho que ficou pela metade** — mudanças não commitadas, não enviadas ou em stash, sinalizadas antes que você as perca.
- **GitHub esperando por você** — PRs abertos, issues e CI falhando em todos os repos, reunidos através do seu `gh` local já autenticado.
- **Projetos que ficam obsoletos** — os que você não toca há tempo demais, ou com lançamento atrasado.

Os que precisam de ação sobem ao topo do painel como uma fila, classificados por urgência, um item por repo — clique para resolver diretamente. Dispense com ✓ e ele fica de fora até que algo realmente mude; quando não há nada esperando, ele mostra "all clear". O resto dos seus repos está sempre a uma busca de distância.

## Instalação

Pegue o arquivo da sua plataforma em [Releases](https://github.com/rockbenben/repo-radar/releases) — sem necessidade de Node.js. O app não é assinado digitalmente, então cada sistema operacional avisa na primeira execução:

- **Windows** — execute `repo-radar-<version>-x64-setup.exe`; no aviso do SmartScreen clique em *Mais informações → Executar assim mesmo*.
- **macOS** — abra `repo-radar-<version>-arm64.dmg` e arraste o app para Applications. Clique com o botão direito → Abrir na primeira vez; se o macOS disser que está danificado, limpe a flag de quarentena uma vez com `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Ou execute a partir do código-fonte:

```bash
npm install
npm start
```

No primeiro lançamento, clique em **Adicionar diretórios de escaneamento** (ou ⚙ Configurações → Diretórios de escaneamento) e aponte para as pastas que contêm seus repos — sem JSON, sem reiniciar; ele reescaneia no instante em que você salva. As configurações ficam em `~/.repo-radar/config.json` se você preferir editá-las à mão.

## O painel

Um cartão por repo — cor de saúde, branch, resumo da árvore de trabalho, à frente/atrás, último commit, tags — com **editor / terminal / pasta** de um clique em cada cartão. A partir daqui você pode:

- **Encontrar** — busque, clique em uma linguagem / `#tag` / lâmpada de atenção para filtrar, ordene e agrupe por pasta ou linguagem; salve qualquer filtro + ordenação + agrupamento como uma visão nomeada. ⌘/Ctrl-K abre um lançador.
- **Agir em lotes** — selecione repos para fetch / pull (`--ff-only`) / push, ou execute um comando de shell em paralelo sobre eles (com pré-visualização de dry-run e saída por repo). A falha de um repo nunca impede os demais.
- **Aprofundar em um repo** — o painel de detalhes dá um resumo completo de saúde, trocar / criar / descartar branches, **commit no local** com um diff ao vivo, PR e CI do GitHub sob demanda, commits recentes, stashes, um mapa de calor de 12 semanas e uma limpeza segura de um clique de branches já mesclados.
- **Manter-se atualizado** — escaneamento automático opcional por monitoramento de arquivos e fetch agendado em segundo plano, ambos desligados por padrão. Uma aba **Stats** (mapa de calor de commits de um ano, mais/menos ativo) e uma aba **Worklog** que copia um intervalo de datas como relatório semanal em Markdown.
- **Iniciar e mover repos** — **+ New** sugere o próximo projeto numerado, roda `git init`, escreve um README e o adota no painel; a exportação / importação de manifesto leva sua configuração entre máquinas.

A interface é antd 6 em um tema escuro de cockpit de instrumentos, localizada em 18 idiomas (correspondida automaticamente ao seu navegador na primeira visita, RTL para o árabe).

## Roda discretamente em segundo plano

Fechar a janela leva o repo-radar para a bandeja, então o monitoramento de arquivos, os fetches agendados e os alertas do GitHub continuam rodando — clique no ícone da bandeja para trazer o painel de volta, ou saia de verdade pelo menu da bandeja. (No Linux, onde as bandejas de desktop não são confiáveis, fechar sai em vez disso; use Iniciar ao fazer login para mantê-lo residente.)

Ative **Iniciar ao fazer login** em ⚙ Configurações e ele inicia sem interface com a sua sessão — sem janela até você pedir. As notificações de desktop opcionais disparam apenas quando algo *novo* chega à sua fila, mesmo com a janela fechada. As atualizações são manuais por design (sem atualização automática): execute o novo instalador sobre o antigo. Os logs vão para `<diretório de configuração>/logs/repo-radar.log`.

## Configuração

Tudo que a interface toca é salvo em `~/.repo-radar/config.json` — você raramente precisa abri-lo. Os campos que importam:

| Campo | O que faz |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | onde escanear (encontra `.git` até 6 níveis de profundidade), o que pular e repos adicionados fora das roots |
| `health` | `{ staleDays, disabledRules }` — ajuste o limite "stale" ou desative verificações individuais |
| `open` | modelos de comando para os botões editor / terminal / pasta (`{path}` = o caminho do repo) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | comportamento em segundo plano — tudo desligado por padrão |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organização por repo |

`REPO_RADAR_CONFIG` e `REPO_RADAR_PORT` (7420 por padrão) substituem o caminho de configuração e a porta — defina **ambas** para executar uma segunda instância totalmente independente. O servidor só escuta em `127.0.0.1` e valida o cabeçalho Origin em cada requisição de API e WebSocket.

## Desenvolvimento

```bash
npm run dev     # vite + a janela do app com hot reload
npm test        # suítes de teste de server + web + desktop e typechecks
npm run dist    # compila os instaladores em dist-electron/
```

Stack: shell Electron + Node + Hono (todo git via `spawn`, zero dependências nativas) + Vite / React 19 / antd 6, com chokidar + WebSocket para atualizações ao vivo. O servidor Hono roda dentro do processo principal do Electron e a janela o carrega via `127.0.0.1`, então a UI é HTTP + WebSocket comum — exatamente o que seria em um navegador.

## Sobre o Plano 365 Open Source

Projeto **#027** do [Plano 365 Open Source](https://github.com/rockbenben/365opensource) — uma pessoa + IA, mais de 300 projetos open-source em um ano. [Envie sua ideia →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)