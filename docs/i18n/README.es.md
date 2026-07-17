<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Plan 365 de código abierto #027 · Un panel local de repositorios Git — una cola de acciones entre repos que responde a qué necesita tu atención ahora mismo.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Un panel local de repositorios Git que escanea todos los repos de tu máquina y te pone al frente una sola pantalla: una **cola de acciones** entre repos que responde a *qué necesita tu atención ahora mismo* — haz clic en un elemento y actúa directamente sobre él. La interfaz está construida sobre antd 6 con una estética profunda de cabina de instrumentos.

## Inicio rápido

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

En el primer arranque se crea una configuración por defecto en `~/.repo-radar/config.json`. Edita `roots` para añadir los directorios que quieres escanear (por ejemplo `D:\Projects` — escapa las barras invertidas como `D:\\Projects` en JSON), y luego haz clic en **Rescan** en el panel.

## Needs you (la pantalla de entrada)

La cola **Needs you**, en la parte superior del tablero, es una cola de acciones entre repos: ordenada por urgencia, un elemento por repo — la cosa más urgente, no otro panel de vanidad de "cuántos commits".

- **Waiting on you**: PRs abiertas por otros, issues abiertas por otros, CI en rojo en la rama principal (agregado en segundo plano mediante un `gh` local ya autenticado, actualizado cada 12 minutos, o manualmente con ↻; tus propias PRs/issues abiertas cuentan como trabajo en curso y quedan excluidas) — haz clic en un elemento para ir directamente a la página de GitHub correspondiente
- **At risk of being lost**: conflictos / atrasado / sin confirmar / sin subir, cuanto más tiempo llevan así, más arriba se ordenan — el trabajo sin subir tiene un push de un clic, todo lo demás abre el panel de detalle
- **Overdue for release**: repos con hábito de etiquetar versiones que han acumulado ≥3 commits desde la última etiqueta sin publicar release — un empujón para lanzar (los repos que nunca etiquetan se dejan en paz; la etiqueta más reciente se elige por fecha de creación en todo el repo, sin importar la rama actual)
- **Forgotten stash**: un stash que lleva ≥7 días sin tocarse — haz clic para ir directo a la bandeja de stashes
- **Dismiss**: pulsa ✓ para descartar un elemento hasta que ocurra algo nuevo — los elementos basados en conteo necesitan que el número crezca, los basados en cambios necesitan otro commit; descartar un stash es un aplazamiento que reaparece a los 30 días, para que uno realmente olvidado nunca quede silenciado para siempre
- Expándelo más allá de 10 elementos para ver todo; muestra "all clear" cuando no queda nada. Se colapsa en un banner delgado en la parte superior

## Board

- **Cards**: una tarjeta por repo (hasta 4 por fila, misma altura). El color del borde izquierdo indica el estado de salud (verde = tranquilo / ámbar = atención / rojo = alerta). Muestra el nombre real · descripción · lenguaje · rama (marcada si no es main) · desglose del árbol de trabajo (`+staged ~modified`) · adelante/atrás · etiquetas de salud · último commit · enlace remoto · tags. El pie siempre tiene un acceso de un clic a **editor / terminal / carpeta**
- **Favorites row**: una fila dedicada "★ favorites" en la parte superior del tablero — haz clic para abrir en tu editor
- **Readout cluster**: indicadores FLEET / CRIT / WARN / CLEAN en la barra superior; los contadores de alerta se iluminan cuando son > 0
- **Click to filter**: haz clic en el lenguaje o el `#tag` de una tarjeta para colocarlo directamente en el cuadro de búsqueda
- **Sort**: última apertura / más recientemente activo (por hora del commit) / por nombre — los favoritos siempre flotan arriba
- **Attention lamps**: chips en la barra superior que resumen tipos de problemas (sin remoto / HEAD desacoplado / sin subir / sin confirmar / atrasado / stash); haz clic para filtrar. "Unpushed" y "behind" tienen cada uno un "push/pull all" de un clic
- **Grouping**: por carpeta / por lenguaje / sin agrupar (plano)
- **Command palette ⌘/Ctrl-K**: un lanzador — escribe un nombre, pulsa enter para abrir en tu editor (botones en línea para terminal / carpeta / copiar ruta / abrir remoto)
- **Tag filter**: selección múltiple de tags en la barra superior (Y lógico — debe llevar cada tag seleccionado); haz clic en el `#tag` de una tarjeta para añadirlo. Filtro + orden + agrupación se guardan juntos como una "vista" con nombre
- **Inline preview**: el "⋯" de una tarjeta muestra los commits recientes sin abrir el panel de detalle
- **Auto-scan (desactivado por defecto)**: un interruptor "manual ⟳ / auto ⟳" en la barra superior. Cuando está activado, un vigilante de archivos actualiza automáticamente las tarjetas afectadas (enfriamiento de 60 segundos; los cambios durante el enfriamiento se combinan, nunca se pierden). Cuando está desactivado, el estado solo se actualiza con Rescan. El tablero igualmente se puebla con un escaneo en el primer arranque
- **Scheduled fetch (desactivado por defecto)**: "fetch: off / every 5–60 min" en la barra superior — hace fetch periódicamente de cada remoto en segundo plano para mantener actualizado el estado adelante/atrás
- **18 idiomas**: cambia el idioma de la interfaz desde ⚙ Settings (chino simplificado/tradicional, inglés, japonés, coreano, español, francés, alemán, portugués, ruso, italiano, árabe, hindi, bengalí, tailandés, turco, vietnamita, indonesio). En la primera visita sin preferencia guardada, la interfaz coincide automáticamente con el idioma de tu navegador (recurriendo al inglés si no hay coincidencia); el árabe cambia automáticamente a RTL. Las horas relativas se localizan de forma nativa mediante `Intl`. Los nombres de repos, descripciones y mensajes de commit nunca se traducen

## Actions

- El pie de la tarjeta siempre muestra botones de editor / terminal / carpeta / copiar ruta; abrir uno registra una marca de tiempo de "última apertura" usada para el orden
- Fetch / pull (`--ff-only`) / push se ejecutan por lotes: selecciona varias tarjetas → acción por lotes desde la barra superior, o un clic sobre toda una lámpara de atención "unpushed" / "behind". El progreso se muestra en vivo; que un repo falle no detiene el resto
- **Run a command across repos**: selecciona tarjetas, escribe un comando en la barra de herramientas (por ejemplo `npm install`), se ejecuta en paralelo dentro del directorio de cada repo seleccionado. "Dry run" muestra antes qué repos se verían afectados; "view output" muestra después el resultado por repo
- **Stash inbox**: si hay algún stash pendiente, aparece un enlace "stash inbox (N)" en la barra superior — lista cada cambio guardado en stash en todos los repos, con diff por elemento, `apply` / `pop` / `drop`
- Seleccionar varias tarjetas también permite aplicar tags en bloque
- **Manifest export / import**: exporta el manifiesto completo de repos (ruta + remotos + grupo + tags) desde **+ new** para respaldo o cambio de máquina; al importar se readoptan los repos que ya existen localmente y se listan los que faltan para clonarlos
- El comando de apertura es configurable por destino bajo `open` en config.json; `{path}` se sustituye por la ruta del repo
- **+ New**: sugiere el siguiente número de secuencia (por ejemplo `028-`) y el directorio padre de tus proyectos numerados existentes, luego crea la carpeta, ejecuta `git init`, escribe un README y lo vuelve a escanear en el tablero

## Health checks & stats

- Las reglas (conflicted / no remote / detached HEAD / uncommitted / unpushed / untracked / behind / stash / stale) pueden desactivarse individualmente mediante `health.disabledRules`; `staleDays` define el umbral de "stale"
- **Mergeable branches**: las tarjetas marcan cuántas ramas locales ya están fusionadas en HEAD (excluyendo la rama actual y main/master); el panel de detalle ofrece una limpieza de un clic con `git branch -d` (solo borra ramas que ya están fusionadas — es seguro)
- **GitHub (opcional, vía un `gh` local ya autenticado)**: la cola "needs you" agrega en segundo plano las PRs abiertas / issues / CI de la rama principal para cada remoto de `github.com` (sondeo con límite de tasa, persistido en disco, instantáneo al reiniciar). El panel de detalle también puede consultar el detalle de PRs abiertas y la última ejecución de CI a pedido; las descripciones de los repos se completan desde GitHub cuando están disponibles
- Pestaña **Stats**: un mapa de calor de commits entre repos de un año (solo ramas locales), lo más recientemente activo, y los 10 repos sin tocar desde hace más tiempo
- Pestaña **Worklog**: elige un rango de fechas para ver una línea de tiempo de commits entre repos (filtrable por autor — por defecto "solo yo", detectando automáticamente tu identidad de git), con copia de un clic como informe semanal en Markdown
- Haz clic en una tarjeta para abrir el panel de detalle: desglose completo de salud, ramas fusionables, **cambiar / crear / descartar ramas locales**, **hacer commit in situ** (escribe un mensaje, se confirma) con un diff en vivo de los cambios pendientes, PR/CI de GitHub, un mini mapa de calor de 12 semanas, commits recientes, stashes y remotos

## Organizing repos

- Marca con ★ una tarjeta para añadirla a favoritos (flota hacia arriba); añade/quita tags en el panel de detalle (autocompleta desde tags que ya has usado) y cambia su grupo ("auto" restaura la agrupación derivada de la carpeta)
- **Notes / to-dos**: anota "qué sigue" en el panel de detalle — se muestra en la tarjeta
- **Exclude**: oculta los repos que no quieres ver; los repos excluidos se ocultan del tablero, las alertas y la paleta de comandos por defecto. "Excluded (N)" en la barra superior te permite verlos/gestionarlos por separado (quitar la exclusión desde el panel de detalle)
- Los cambios se aplican al instante y se escriben en config.json sin disparar un rescaneo de Git

## Development

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

Stack: Node + Hono (todo el acceso a git vía `spawn`, cero dependencias nativas), Vite + React 19 + antd 6 (profundamente personalizado mediante variables CSS), chokidar + WebSocket para actualizaciones en vivo.

## Configuration (config.json)

| Field | Description |
| --- | --- |
| `roots` | Directorios raíz a escanear; descubre recursivamente directorios que contienen `.git` (profundidad ≤ 6) |
| `excludes` | Nombres de directorios a omitir (por defecto incluye node_modules) |
| `manualRepos` | Rutas de repos añadidas manualmente, fuera de los roots configurados |
| `tags` / `favorites` / `groupOverrides` | Anulaciones de tag / favorito / grupo por id de repo |
| `notes` / `archived` | Notas / marca de archivado por id de repo |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Plantillas de comando para los destinos de apertura de un clic (editor / terminal / explorador) |

La variable de entorno `REPO_RADAR_CONFIG` anula la ruta del archivo de configuración. El servidor solo escucha en `127.0.0.1` y valida el encabezado Origin tanto en la API como en el WebSocket.

## Sobre el Plan 365 de código abierto

Este es el proyecto **#027** del [Plan 365 de código abierto](https://github.com/rockbenben/365opensource).

Una persona + IA, más de 300 proyectos de código abierto en un año. [Envía tu idea →](https://365.aishort.top/)

## Licencia

[MIT](../../LICENSE)
