<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — un panel local que vigila todos tus repos Git y señala los que te necesitan" />
</p>

# repo-radar

> Plan 365 de código abierto #027 · Un panel local que vigila todos tus repos Git y te muestra cuáles te necesitan.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Tienes más repos Git de los que puedes seguir a mano. repo-radar vigila todos ellos y te muestra los pocos que te necesitan ahora — para que el resto no ocupe tu mente.

Saca a la luz lo que de otro modo olvidarías comprobar:

- **Repos que has perdido de vista** — todos los repos que posees en una sola pantalla, con búsqueda, abre cualquiera de ellos con un clic.
- **Trabajo sin terminar** — cambios sin confirmar, sin subir o en stash, señalados antes de que los pierdas.
- **GitHub esperándote** — PRs abiertas, issues y CI fallando en todos tus repos, recopilados a través de tu `gh` local ya autenticado.
- **Proyectos que se quedan obsoletos** — los que llevas demasiado tiempo sin tocar, o con release pendiente.

Los que necesitan acción suben a lo alto del tablero como una cola, ordenados por urgencia, un elemento por repo — haz clic para actuar directamente. Descártalo con ✓ y se queda fuera hasta que algo cambie de verdad; cuando no hay nada esperando, dice "all clear". El resto de tus repos están siempre a una búsqueda de distancia.

## Instalación

Toma el archivo de tu plataforma desde [Releases](https://github.com/rockbenben/repo-radar/releases) — sin necesidad de Node.js. La app no está firmada digitalmente, así que cada sistema operativo avisa en el primer arranque:

- **Windows** — ejecuta `repo-radar-<version>-x64-setup.exe`; en el aviso de SmartScreen haz clic en *Más información → Ejecutar de todas formas*.
- **macOS** — abre `repo-radar-<version>-arm64.dmg` y arrastra la app a Applications. Clic derecho → Abrir la primera vez; si macOS dice que está dañada, borra la marca de cuarentena una vez con `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

O ejecuta desde el código fuente:

```bash
npm install
npm start
```

En el primer arranque, haz clic en **Añadir directorios de escaneo** (o ⚙ Ajustes → Directorios de escaneo) y apúntalo a las carpetas que contienen tus repos — sin JSON, sin reiniciar; vuelve a escanear en cuanto guardas. La configuración vive en `~/.repo-radar/config.json` si prefieres editarla a mano.

## El tablero

Una tarjeta por repo — color de salud, rama, desglose del árbol de trabajo, adelante/atrás, último commit, tags — con **editor / terminal / carpeta** de un clic en cada tarjeta. Desde aquí puedes:

- **Encontrar** — busca, haz clic en un lenguaje / `#tag` / lámpara de atención para filtrar, ordena y agrupa por carpeta o lenguaje; guarda cualquier filtro + orden + agrupación como una vista con nombre. ⌘/Ctrl-K abre un lanzador.
- **Actuar por lotes** — selecciona repos para fetch / pull (`--ff-only`) / push, o ejecuta un comando de shell en paralelo sobre ellos (con vista previa de dry-run y salida por repo). Que un repo falle nunca detiene el resto.
- **Profundizar en un repo** — el panel de detalle ofrece un desglose completo de salud, cambiar / crear / descartar ramas, **hacer commit in situ** con un diff en vivo, PR y CI de GitHub a demanda, commits recientes, stashes, un mapa de calor de 12 semanas y una limpieza de un clic de ramas ya fusionadas — ofrecida solo mientras estás en `main`/`master`, la única posición donde «ya fusionada» significa fusionada en el tronco. Descartar cambios revierte los archivos rastreados y elimina los no rastreados, pero deja intactos el contenido de los submódulos y los repos git anidados sin rastrear; si queda algo sin descartar te lo dice en lugar de informar de un éxito.
- **Mantente al día** — la vía de actualización por defecto es un reescaneo cada 30 minutos más el reescaneo manual de la barra. El escaneo automático por vigilancia de archivos viene **desactivado por defecto** y se activa a voluntad en el panel de ajustes: es solo local y nunca toca la red, pero con varios proyectos compilando a la vez el búfer de notificaciones del kernel se desborda sin parar, y cada desbordamiento cuesta un reescaneo — un precio permanente demasiado alto para una herramienta que sirve para echar un vistazo a lo que cambió. Con la vigilancia activada, en Windows y macOS, una única vigilancia recursiva por directorio de escaneo cubre todos los repos que contiene, así que añadir, borrar o renombrar un repo aparece en segundos; en Linux los repos se vigilan individualmente y `watchLimit` (200 por defecto, 0 = sin límite) limita cuántos, con prioridad para los favoritos y los de commit reciente. Si los desbordamientos se repiten, los reescaneos de recuperación se espacian de forma exponencial (como mucho cada 30 minutos) y ya no reconstruyen las vigilancias — eso solo ocurre cuando un objetivo vigilado desaparece de verdad. Un reescaneo cada 30 minutos recoge lo que la vigilancia se pierda, la barra muestra «último escaneo» y el panel de ajustes muestra la cobertura en vivo («vigilando M de N»). Renombrar o mover un repo conserva sus etiquetas, su estrella, su estado de archivo y sus notas — repo-radar sigue la identidad, no solo la ruta. El emparejamiento ocurre en la ronda de escaneo **inmediatamente posterior** al movimiento, lo que deja dos huecos: un movimiento lento entre volúmenes que abarca dos rondas de escaneo, con el alta/baja de otro repo o el reescaneo periódico cayendo en medio; y un movimiento cuyo destino no se escanea en esa ronda — sacar un repo de tus directorios de escaneo y añadir su nueva ubicación como directorio de escaneo solo más tarde es la forma habitual de caer en él. Ambos vuelven a la identidad por ruta: el repo reaparece como una tarjeta nueva y sus etiquetas/estrella/archivo/notas quedan bajo el id que ya no tiene. El fetch programado en segundo plano es opcional. Una pestaña **Stats** (mapa de calor de commits de un año, más/menos activo) y una pestaña **Worklog** que copia un rango de fechas como informe semanal en Markdown.
- **Inicia y mueve repos** — **+ New** sugiere el siguiente proyecto numerado, ejecuta `git init`, escribe un README y lo adopta en el tablero; la exportación / importación de manifiesto lleva tu configuración entre máquinas.

La interfaz es antd 6 en un tema oscuro de cabina de instrumentos, localizada a 18 idiomas (coincide automáticamente con tu navegador en la primera visita, RTL para el árabe).

## Funciona silenciosamente en segundo plano

Cerrar la ventana deja repo-radar en la bandeja, así que el reescaneo periódico, la vigilancia de archivos (si la activaste), los fetch programados y las alertas de GitHub siguen funcionando — haz clic en el icono de la bandeja para recuperar el tablero, o sal de verdad desde el menú de la bandeja. (En Linux, donde las bandejas de escritorio no son fiables, cerrar sale en su lugar; usa Iniciar al iniciar sesión para mantenerlo residente.)

Al salir, repo-radar espera hasta 10 segundos a que termine el trabajo git ya en curso — un pull por lotes, un stash descartado, un fetch programado — para que nada se corte a mitad de escritura y deje un `.git/index.lock` obsoleto. Si ese tiempo no basta, sale igualmente y lo deja dicho en el log: es el único sitio que explica un `index.lock` que encuentres más tarde.

Activa **Iniciar al iniciar sesión** en ⚙ Ajustes y arranca sin interfaz con tu sesión — sin ventana hasta que la pidas. Las notificaciones de escritorio opcionales se disparan solo cuando algo *nuevo* llega a tu cola, incluso con la ventana cerrada. Las actualizaciones son manuales por diseño (sin actualización automática): ejecuta el nuevo instalador sobre el anterior. Los logs van a `<directorio de configuración>/logs/repo-radar.log`.

## Configuración

Todo lo que la interfaz toca se guarda en `~/.repo-radar/config.json` — rara vez necesitas abrirlo. Los campos que importan:

| Campo | Qué hace |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | dónde escanear (encuentra `.git` hasta 6 niveles, sin seguir enlaces simbólicos), qué omitir y repos añadidos fuera de los roots — una entrada de `manualRepos` que se renombra o se mueve no se sigue por identidad como sí ocurre con un repo escaneado; la tarjeta queda en error hasta que actualices su ruta aquí, y si el movimiento ocurrió hace más de una ronda de escaneo, esa actualización devuelve la tarjeta pero no sus etiquetas/estrella/archivo/notas |
| `health` | `{ staleDays, disabledRules }` — ajusta el umbral "stale" o desactiva comprobaciones individuales |
| `open` | plantillas de comando para los botones editor / terminal / carpeta (`{path}` = la ruta del repo) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | comportamiento en segundo plano — por defecto solo `autoScanMinutes` (30) está activado; los otros tres, incluido `autoWatch`, están desactivados. `watchLimit` (200, 0 = sin límite) solo se aplica **en Linux**, donde los repos se vigilan individualmente; Windows y macOS usan una vigilancia recursiva por directorio de escaneo y siempre cubren todos los repos |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organización por repo |

Junto a `config.json` viven dos archivos más, ambos seguros de borrar — repo-radar los reconstruye, con costes distintos. `repo-cache.json` recuerda los campos git «pesados» de cada repo (stashes, tags, remotos, ramas fusionadas…) indexados por una huella de `.git`, de modo que un repo sin cambios se salta esas llamadas a git en el siguiente reescaneo; borrarlo solo hace que el próximo reescaneo sea más lento, una vez. `repo-identity.json` es el libro de identidad que permite a un repo renombrado o movido conservar sus etiquetas, su estrella, su estado de archivo y sus notas en lugar de ser tratado como un repo nuevo. Aquí la pérdida es inmediata, no diferida: cualquier repo que ya se hubiera renombrado o movido **antes** de perderse el archivo recibe un id nuevo en el siguiente escaneo, y sus etiquetas/estrella/archivo/notas quedan varadas bajo el id que ya no tiene. Los repos que nunca se renombraron no se ven afectados, y desde el momento en que el libro se reconstruye, los renombrados vuelven a estar protegidos.

`REPO_RADAR_CONFIG` y `REPO_RADAR_PORT` (17420 por defecto) anulan la ruta de configuración y el puerto — configura **ambos** para ejecutar una segunda instancia completamente independiente. El servidor solo escucha en `127.0.0.1` y valida el encabezado Origin en cada petición de API y WebSocket.

El puerto por defecto está deliberadamente por encima del rango de puertos dinámicos del sistema: Windows usa 49152–65535 por defecto, pero 1024–15000 en cuanto se instala Hyper-V/WSL2, y el sistema reserva bloques enteros del rango activo — un puerto dentro de él falla al enlazar con `EACCES`, y los bloques cambian entre reinicios.

Si el puerto **por defecto** aún no se puede enlazar, repo-radar recurre al siguiente candidato (`+1000`, `+2000`, `+3000`, y luego un puerto asignado por el sistema) en lugar de negarse a arrancar, recuerda el puerto en el que acabó y lo reutiliza en arranques posteriores, y lo muestra junto a la versión en ⚙ Ajustes. Reutilizarlo importa porque el puerto forma parte del origen de la página, y el tablero guarda las vistas guardadas, el registro de actividad, el tema y el idioma en almacenamiento del navegador ligado al origen: dejar que el puerto vaya y venga haría que esos datos parecieran desaparecer y reaparecer. Borra `<directorio de configuración>/port-state.json` para volver al puerto por defecto.

Un puerto que fijes tú con `REPO_RADAR_PORT` nunca se sustituye — es una promesa a tus marcadores, upstreams de proxy inverso y scripts, así que si no se puede enlazar falla de forma ruidosa. Lo mismo en `npm run dev`, donde el destino del proxy de vite queda fijado al cargar la configuración.

## Desarrollo

```bash
npm run dev     # vite + la ventana de la app con hot reload
npm test        # suites de test de server + web + desktop y typechecks
npm run dist    # compila los instaladores en dist-electron/
```

Stack: shell de Electron + Node + Hono (todo git vía `spawn`, cero dependencias nativas) + Vite / React 19 / antd 6, con chokidar + WebSocket para actualizaciones en vivo. El servidor Hono corre dentro del proceso principal de Electron y la ventana lo carga por `127.0.0.1`, así que la UI es HTTP + WebSocket normal — exactamente lo que sería en un navegador.

## Sobre el Plan 365 de código abierto

Proyecto **#027** del [Plan 365 de código abierto](https://github.com/rockbenben/365opensource) — una persona + IA, más de 300 proyectos de código abierto en un año. [Envía tu idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)