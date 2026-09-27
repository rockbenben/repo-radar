<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Painel do repo·radar: luzes de alerta no topo, fila «precisa de você» abaixo e um cartão por repo com branch, estado da árvore de trabalho e editor / terminal / pasta em um clique" />
</p>

# repo-radar

> Plano 365 Open Source #027 · Um painel local que fica de olho em todos os seus repos Git e mostra quais precisam de você.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[⬇ Baixar para Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Você tem mais repos Git do que consegue acompanhar de cabeça. O repo-radar vigia todos e mostra os poucos que precisam de você agora — o resto pode sair da sua mente.

Ele traz à tona o que você esqueceria de conferir:

- **Trabalho pela metade** — mudanças sem commit, sem push ou no stash, sinalizadas antes que você as perca.
- **GitHub esperando por você** — PRs abertos, issues e CI vermelho, lidos pelo seu `gh` já autenticado.
- **Projetos esfriando** — sem toque há tempo demais, ou com release atrasado.
- **Repos que você perdeu de vista** — todos em uma tela, pesquisáveis, abertos em um clique.

O que precisa de ação sobe como uma fila: um item por repo, por urgência. Dispense com ✓ e ele fica fora até algo mudar de verdade — com uma exceção: um stash dispensado volta depois de 30 dias, para que um que você esqueceu de verdade não suma para sempre.

## Compatibilidade

| Aspecto | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Instalação | instalador `.exe` | `.dmg` | `.AppImage` |
| Fechar a janela | vai para a bandeja | vai para a bandeja | encerra — use **Iniciar ao fazer login** para mantê-lo |
| Monitorar mudanças | todos os repos sob um diretório de varredura | idem | os primeiros 200 repos (o limite sobe ou sai nas configurações) |

Tudo roda na sua máquina e usa o `git` que você já tem — sem conta, sem telemetria, nada é enviado. A coluna do GitHub (PRs, issues, CI) é opcional e lê pela [CLI `gh`](https://cli.github.com/) onde você já está autenticado; sem ela, o resto continua funcionando.

## Instalação

Pegue o arquivo da sua plataforma em [Releases](https://github.com/rockbenben/repo-radar/releases) — sem Node.js. O app não é assinado, então cada sistema avisa na primeira execução:

- **Windows** — no aviso do SmartScreen, *Mais informações → Executar assim mesmo*.
- **macOS** — clique com o botão direito → Abrir na primeira vez. Se o macOS disser que está danificado: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — primeiro `chmod +x repo-radar-*.AppImage`.

Prefere não confiar em um binário? [Compile você mesmo](../development.md) — é `npm install && npm start`.

Na primeira execução clique em **Adicionar diretórios de varredura** e aponte para a pasta que *contém* seus repos — um `~/Projetos`, não cada repo um a um. Ele desce até 6 níveis procurando qualquer coisa com um `.git`, e o painel se preenche. Sem JSON, sem reiniciar.

## O painel

Um cartão por repo — cor de saúde, branch, detalhe da árvore de trabalho, ahead/behind, último commit, tags — com **editor / terminal / pasta** em um clique.

- **Encontrar** — busque, ou filtre por linguagem, `#tag` ou luz de alerta. ⌘/Ctrl-K abre um lançador.
- **Salvar uma visão** — qualquer filtro + ordenação + agrupamento, nomeado e reutilizável.
- **Agir em lote** — fetch / pull / push nos repos selecionados, ou um mesmo comando de shell em todos. Um repo falhando nunca para os demais.
- **Trabalhar no lugar** — o painel de detalhes faz commit com diff ao vivo, troca de branch, descarta mudanças, limpa branches mesclados e busca PR e CI do GitHub sob demanda.
- **Criar e mover repos** — **+ Novo** cria um repo e o coloca direto no painel; exportar / importar o manifesto leva a lista de repos — caminhos, remotos, grupos, tags — para outra máquina.

As luzes no topo são os tipos de alerta — sem remoto, HEAD desanexado, sem push, sem commit, atrás do remoto, stash pendente. Desligue as que não interessam em ⚙ Configurações.

Mais duas abas: **Estatísticas** (heatmap de commits de um ano, repos mais e menos ativos) e **Registro de trabalho** (copiar um intervalo de datas como relatório semanal em Markdown).

Tema escuro de cockpit de instrumentos, localizado em 18 idiomas, com contraste de texto ajustado ao WCAG AA nos dois temas.

## Mantendo-se atualizado

O padrão é uma revarredura de reserva a cada 30 minutos mais a revarredura manual da barra. Uma revarredura só lê o estado local do git — ela nunca contata um remoto para descobrir o que mudou.

A varredura automática por monitoramento de arquivos vem **desligada por padrão** e é opcional nas configurações. Ela também é local, mas com vários projetos compilando ao mesmo tempo o buffer de notificações do kernel transborda o tempo todo, e transbordar significa eventos perdidos em que não dá mais para confiar — a única resposta segura é outra revarredura, limitada com backoff exponencial a no máximo uma a cada 30 minutos. Mesmo assim, preço fixo alto demais para uma ferramenta de dar uma olhada no que mudou. Ligada, repos novos, apagados ou renomeados aparecem em segundos.

Renomeie ou mova um repo e ele mantém tags, favorito, estado de arquivo e notas. O repo-radar reconhece um repo pelo que há dentro dele, não por onde ele está — uma pasta movida continua sendo o mesmo projeto, não um novo.

O fetch agendado em segundo plano é opcional e é o único recurso que fala com seus remotos sozinho. A coluna do GitHub é a única coisa que sai para a rede por cronômetro sem você pedir: enquanto a CLI `gh` estiver instalada, PRs, issues e CI são atualizados por ela a cada 12 minutos e depois de cada revarredura. Sem `gh`, ou sem remotos do GitHub, o app é totalmente local.

## Roda quieto em segundo plano

Fechar a janela recolhe o repo-radar para a bandeja **no Windows e no macOS**, então revarreduras, monitoramento e alertas do GitHub seguem rodando; no Linux a janela fecha o app, porque lá não há bandeja confiável. No Windows e Linux um clique no ícone traz o painel de volta; no macOS o ícone abre o menu, onde essa é a primeira opção — e onde fica Sair em todas as plataformas.

Ao sair, ele espera até 10 segundos pelo trabalho git em andamento — um pull em lote, um stash descartado — para que nada seja cortado no meio da escrita e deixe um `.git/index.lock` velho. Se não bastar, sai mesmo assim e registra isso no log.

Ative **Iniciar ao fazer login** e ele sobe sem janela junto com sua sessão. Notificações de desktop são opcionais e só disparam quando algo *novo* chega à lista do GitHub que está esperando por você — um PR, uma issue ou um CI quebrado; nunca no primeiro carregamento.

## Configuração

Diretórios de varredura, pastas excluídas e os comandos de abertura são editáveis em ⚙ Configurações → Varredura e comandos de abertura. O resto fica em `~/.repo-radar/config.json`, que você raramente precisa abrir; escolhas puramente de exibição (vistas salvas, tema, idioma, registro de atividade) ficam no armazenamento do navegador. A lista completa de campos, os arquivos de cache ao lado e as variáveis de ambiente para rodar uma segunda instância estão na [referência de configuração](../configuration.md).

## Limitações conhecidas

- **Atualizações são manuais por escolha.** Sem auto-update: rode o novo instalador por cima do antigo.
- **Mover um repo e a varredura não reconhecer deixa uma dica, não um sumiço silencioso.** Quando o casamento automático falha, o cartão novo oferece *«provavelmente uma cópia movida do caminho antigo»* — clique em **Migrar** e tags, estrela e notas vão junto. Só dispara em repos varridos pelo menos uma vez nesta instalação (o registro precisa ter visto o remoto deles) e nunca num destino que você ainda não adicionou como diretório de varredura.
- **Linux não tem bandeja confiável**, então fechar a janela encerra o app.
- **Repos adicionados um a um, fora de um diretório de varredura, não são reconhecidos assim** — se mover um, você mesmo aponta o novo caminho.
- **Descartar mudanças não mexe em submódulos nem em repos git aninhados**, e diz isso em vez de relatar limpeza total.

## Sobre o Plano 365 Open Source

Projeto **#027** do [Plano 365 Open Source](https://github.com/rockbenben/365opensource) — uma pessoa + IA, mais de 300 projetos open-source em um ano.

[Envie sua ideia →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
