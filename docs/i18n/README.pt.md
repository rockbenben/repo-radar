<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Plano 365 Open Source #027 · Um painel local para repositórios Git — uma fila de ações entre repositórios que responde o que precisa de você agora.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Um painel local para seus repositórios Git que escaneia todos os repositórios da sua máquina e coloca uma única tela na sua frente antes de tudo: uma **fila de ações** entre repositórios que responde *o que precisa de você agora* — clique em um item e resolva diretamente. A interface é construída sobre o antd 6, com um tema profundo de cockpit de instrumentos.

## Início rápido

```bash
npm install
npm run build   # compila o frontend
npm start       # http://localhost:7420
```

No primeiro lançamento, uma configuração padrão é criada em `~/.repo-radar/config.json`. Edite `roots` para adicionar os diretórios que deseja escanear (por exemplo, `D:\Projects` — escape as barras invertidas como `D:\\Projects` no JSON) e clique em **Rescan** no painel.

## Precisa de você (a tela de entrada)

A fila **Precisa de você**, no topo do painel, é uma fila de ações entre repositórios: classificada por urgência, um item por repositório — a única coisa mais urgente, não mais um painel de vaidade de "quantos commits".

- **Esperando por você**: PRs abertos por outras pessoas, issues abertas por outras pessoas, CI vermelho no branch padrão (agregado em segundo plano via um `gh` local já autenticado, atualizado a cada 12 minutos, ou ↻ manualmente; seus próprios PRs/issues abertos contam como trabalho em andamento e são excluídos) — clique em um item para ir direto à página correspondente do GitHub
- **Em risco de ser perdido**: conflitos / atrás / não commitado / não enviado — quanto mais tempo parado, mais alto na classificação — trabalho não enviado ganha um push de um clique, todo o resto abre o painel de detalhes
- **Atrasado para release**: repositórios com hábito de criar tags que acumularam ≥3 commits desde a última tag sem lançamento — um empurrão para publicar (repositórios que nunca criam tags são deixados em paz; a última tag é escolhida pelo horário de criação em todo o repositório, independente do branch atual)
- **Stash esquecido**: um stash parado sem uso há ≥7 dias — clique para ir direto à caixa de entrada de stashes
- **Dispensar**: toque em ✓ para limpar um item até que algo novo aconteça — itens baseados em contagem precisam que a contagem cresça, itens baseados em mudança precisam de outro commit; dispensar um stash é um soneca que reaparece depois de 30 dias, para que um stash verdadeiramente esquecido nunca seja silenciado para sempre
- Expanda além de 10 itens para ver tudo; mostra "tudo limpo" quando não sobra nada. Recolhe para um banner fino no topo

## Painel

- **Cartões**: um cartão por repositório (até 4 por linha, mesma altura). A cor da borda esquerda indica a saúde (verde = tranquilo / âmbar = atenção / vermelho = alerta). Mostra o nome real · descrição · linguagem · branch (sinalizado se não for o main) · resumo da árvore de trabalho (`+staged ~modified`) · à frente/atrás · tags de saúde · último commit · link do remoto · tags. O rodapé sempre tem **editor / terminal / pasta** com um clique
- **Linha de favoritos**: uma linha dedicada "★ favoritos" no topo do painel — clique para abrir no seu editor
- **Conjunto de indicadores**: medidores FLEET / CRIT / WARN / CLEAN na barra superior; contagens de alerta acendem quando > 0
- **Clique para filtrar**: clique na linguagem ou na `#tag` de um cartão para colocá-la direto na caixa de busca
- **Ordenar**: última abertura / mais ativo recentemente (por horário de commit) / por nome — favoritos sempre flutuam para o topo
- **Lâmpadas de atenção**: chips na barra superior resumindo tipos de problema (sem remoto / HEAD desanexado / não enviado / não commitado / atrás / stash); clique para filtrar. "Não enviado" e "atrás" têm cada um um "push/pull em todos" de um clique
- **Agrupamento**: por pasta / por linguagem / sem agrupar (plano)
- **Paleta de comandos ⌘/Ctrl-K**: um lançador — digite um nome, pressione enter para abrir no seu editor (botões inline para terminal / pasta / copiar caminho / abrir remoto)
- **Filtro de tags**: seleção múltipla de tags na barra superior (E — precisa carregar todas as tags selecionadas); clique na `#tag` de um cartão para adicioná-la. Filtro + ordenação + agrupamento são salvos juntos como uma "visão" nomeada
- **Pré-visualização inline**: o "⋯" em um cartão exibe os commits recentes sem abrir o painel de detalhes
- **Escaneamento automático (desativado por padrão)**: um alternador "manual ⟳ / automático ⟳" na barra superior. Quando ativado, um observador de arquivos atualiza automaticamente os cartões afetados (período de espera de 60 segundos; mudanças durante a espera são mescladas, nunca descartadas). Quando desativado, o estado só é atualizado ao clicar em Rescan. O painel ainda é preenchido por um escaneamento no primeiro lançamento
- **Busca agendada (desativada por padrão)**: "fetch: desligado / a cada 5–60 min" na barra superior — busca periodicamente em cada remoto em segundo plano para manter à frente/atrás atualizado
- **18 idiomas**: troque o idioma da interface em ⚙ Configurações (chinês simplificado/tradicional, inglês, japonês, coreano, espanhol, francês, alemão, português, russo, italiano, árabe, hindi, bengali, tailandês, turco, vietnamita, indonésio). Na primeira visita, sem preferência salva, a interface corresponde automaticamente ao idioma do seu navegador (revertendo para o inglês se nada corresponder); o árabe muda automaticamente para RTL. Horários relativos são localizados nativamente via `Intl`. Nomes de repositórios, descrições e mensagens de commit nunca são traduzidos

## Ações

- O rodapé do cartão sempre mostra botões de editor / terminal / pasta / copiar caminho; abrir um deles registra um horário de "última abertura" usado para ordenação
- Fetch / pull (`--ff-only`) / push rodam em lotes: selecione vários cartões → ação em lote na barra superior, ou clique uma vez em toda uma lâmpada de atenção "não enviado" / "atrás". O progresso é mostrado ao vivo; a falha de um repositório não impede os demais
- **Execute um comando em vários repositórios**: selecione cartões, digite um comando na barra de ferramentas (por exemplo, `npm install`), e ele roda em paralelo dentro do diretório de cada repositório selecionado. "Dry run" mostra antes quais repositórios seriam afetados; "ver saída" mostra o resultado por repositório depois
- **Caixa de entrada de stashes**: com qualquer stash por aí, um link "stash inbox (N)" aparece na barra superior — lista cada mudança guardada em stash em todos os repositórios, com diff por item, `apply` / `pop` / `drop`
- Selecionar vários cartões também permite aplicar tags em lote
- **Exportar/importar manifesto**: exporte o manifesto completo de repositórios (caminho + remotos + grupo + tags) em **+ new** para backup ou troca de máquina; a importação readota repositórios que já existem localmente e lista os que faltam para clonagem
- O comando de abertura é configurável por destino em `open` no config.json; `{path}` é substituído pelo caminho do repositório
- **+ New**: sugere o próximo número de sequência (por exemplo, `028-`) e o diretório pai dos seus projetos numerados existentes, depois cria a pasta, roda `git init`, escreve um README e reescaneia para incluí-lo no painel

## Verificações de saúde e estatísticas

- As regras (conflitado / sem remoto / HEAD desanexado / não commitado / não enviado / não rastreado / atrás / stash / obsoleto) podem ser desativadas individualmente via `health.disabledRules`; `staleDays` define o limite de "obsoleto"
- **Branches mesclável**: os cartões sinalizam quantos branches locais já foram mesclados na HEAD (excluindo o branch atual e main/master); o painel de detalhes oferece uma limpeza `git branch -d` de um clique (só apaga branches que já estão mesclados — seguro)
- **GitHub (opcional, via um `gh` local já autenticado)**: a fila "precisa de você" agrega PRs / issues abertos / CI do branch padrão para cada remoto `github.com` em segundo plano (sondagem limitada por taxa, persistida em disco, instantânea ao reiniciar). O painel de detalhes também pode consultar detalhes de PR aberto e a última execução de CI sob demanda; descrições de repositório são preenchidas retroativamente a partir do GitHub quando disponíveis
- Aba **Estatísticas**: um mapa de calor de commits entre repositórios ao longo de um ano (apenas branches locais), mais ativo recentemente e os 10 repositórios não tocados há mais tempo
- Aba **Worklog**: escolha um intervalo de datas para ver uma linha do tempo de commits entre repositórios (filtrável por autor — o padrão é "só eu", detectando automaticamente sua identidade do git), com cópia de um clique como relatório semanal em Markdown
- Clique em um cartão para abrir o painel de detalhes: resumo completo de saúde, branches mescláveis, **trocar / criar / descartar branches locais**, **commit no local** (digite uma mensagem, ele commita) com um diff ao vivo das mudanças pendentes, PR/CI do GitHub, um mini mapa de calor de 12 semanas, commits recentes, stashes e remotos

## Organizando repositórios

- Marque um cartão com ★ para favoritá-lo (flutua para o topo); adicione/remova tags no painel de detalhes (autocompleta a partir das tags que você já usou) e mude seu grupo ("auto" restaura o agrupamento derivado da pasta)
- **Notas / a fazer**: anote "o que vem a seguir" no painel de detalhes — aparece no cartão
- **Excluir**: oculte repositórios que você não quer ver; repositórios excluídos ficam ocultos do painel, dos alertas e da paleta de comandos por padrão. "Excluídos (N)" na barra superior permite visualizá-los/gerenciá-los separadamente (remover exclusão no painel de detalhes)
- As mudanças se aplicam instantaneamente e são gravadas no config.json sem disparar um rescan do Git

## Desenvolvimento

```bash
npm run dev     # roda o server(7420) + vite(5173) juntos, o frontend faz proxy de /api
npm test        # suíte completa de testes de server + web e ambas as verificações de tipo
```

Stack: Node + Hono (todo acesso ao git via `spawn`, zero dependências nativas), Vite + React 19 + antd 6 (profundamente customizado via variáveis CSS), chokidar + WebSocket para atualizações ao vivo.

## Configuração (config.json)

| Campo | Descrição |
| --- | --- |
| `roots` | Diretórios raiz a escanear; descobre recursivamente diretórios contendo `.git` (profundidade ≤ 6) |
| `excludes` | Nomes de diretórios a ignorar (o padrão inclui node_modules) |
| `manualRepos` | Caminhos de repositórios adicionados manualmente, fora das raízes configuradas |
| `tags` / `favorites` / `groupOverrides` | Substituições de tag / favorito / grupo por repositório |
| `notes` / `archived` | Notas / sinalizador de arquivado por repositório |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Modelos de comando para os destinos de abertura de um clique (editor / terminal / explorador) |

A variável de ambiente `REPO_RADAR_CONFIG` substitui o caminho do arquivo de configuração. O servidor só escuta em `127.0.0.1` e valida o cabeçalho Origin tanto na API quanto no WebSocket.

## Sobre o Plano 365 Open Source

Este é o projeto **#027** do [Plano 365 Open Source](https://github.com/rockbenben/365opensource).

Uma pessoa + IA, mais de 300 projetos open-source em um ano. [Envie sua ideia →](https://365.aishort.top/)

## Licença

[MIT](../../LICENSE)
