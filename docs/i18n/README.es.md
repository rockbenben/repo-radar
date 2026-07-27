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
- **Profundizar en un repo** — el panel de detalle ofrece un desglose completo de salud, cambiar / crear / descartar ramas, **hacer commit in situ** con un diff en vivo, PR y CI de GitHub a demanda, commits recientes, stashes, un mapa de calor de 12 semanas y una limpieza segura de un clic de ramas ya fusionadas.
- **Mantente al día** — el escaneo automático por vigilancia de archivos viene activado por defecto (solo local, sin red), respaldado por un reescaneo cada 30 minutos para los eventos que se pierdan y por un indicador de «último escaneo» en la barra; por encima del límite de vigilancia (200 repos por defecto, ajustable hasta sin límite) se vigilan primero los favoritos y los de commit reciente, y el resto va por el reescaneo — el panel de ajustes muestra la cobertura real («vigilando M de N»). El fetch programado en segundo plano es opcional. Una pestaña **Stats** (mapa de calor de commits de un año, más/menos activo) y una pestaña **Worklog** que copia un rango de fechas como informe semanal en Markdown.
- **Inicia y mueve repos** — **+ New** sugiere el siguiente proyecto numerado, ejecuta `git init`, escribe un README y lo adopta en el tablero; la exportación / importación de manifiesto lleva tu configuración entre máquinas.

La interfaz es antd 6 en un tema oscuro de cabina de instrumentos, localizada a 18 idiomas (coincide automáticamente con tu navegador en la primera visita, RTL para el árabe).

## Funciona silenciosamente en segundo plano

Cerrar la ventana deja repo-radar en la bandeja, así que la vigilancia de archivos, los fetch programados y las alertas de GitHub siguen funcionando — haz clic en el icono de la bandeja para recuperar el tablero, o sal de verdad desde el menú de la bandeja. (En Linux, donde las bandejas de escritorio no son fiables, cerrar sale en su lugar; usa Iniciar al iniciar sesión para mantenerlo residente.)

Activa **Iniciar al iniciar sesión** en ⚙ Ajustes y arranca sin interfaz con tu sesión — sin ventana hasta que la pidas. Las notificaciones de escritorio opcionales se disparan solo cuando algo *nuevo* llega a tu cola, incluso con la ventana cerrada. Las actualizaciones son manuales por diseño (sin actualización automática): ejecuta el nuevo instalador sobre el anterior. Los logs van a `<directorio de configuración>/logs/repo-radar.log`.

## Configuración

Todo lo que la interfaz toca se guarda en `~/.repo-radar/config.json` — rara vez necesitas abrirlo. Los campos que importan:

| Campo | Qué hace |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | dónde escanear (encuentra `.git` hasta 6 niveles), qué omitir y repos añadidos fuera de los roots |
| `health` | `{ staleDays, disabledRules }` — ajusta el umbral "stale" o desactiva comprobaciones individuales |
| `open` | plantillas de comando para los botones editor / terminal / carpeta (`{path}` = la ruta del repo) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | comportamiento en segundo plano — `autoWatch` activado, `autoScanMinutes` en 30 y `watchLimit` en 200 por defecto (0 = sin límite), los otros dos desactivados |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organización por repo |

`REPO_RADAR_CONFIG` y `REPO_RADAR_PORT` (7420 por defecto) anulan la ruta de configuración y el puerto — configura **ambos** para ejecutar una segunda instancia completamente independiente. El servidor solo escucha en `127.0.0.1` y valida el encabezado Origin en cada petición de API y WebSocket.

## Desarrollo

```bash
npm run dev     # vite + la ventana de la app con hot reload
npm test        # suites de test de server + web + desktop y typechecks
npm run dist    # compila los instaladores en dist-electron/
```

Stack: shell de Electron + Node + Hono (todo git vía `spawn`, cero dependencias nativas) + Vite / React 19 / antd 6, con chokidar + WebSocket para actualizaciones en vivo. El servidor Hono corre dentro del proceso principal de Electron y la ventana lo carga por `127.0.0.1`, así que la UI es HTTP + WebSocket normal — exactamente lo que sería en un navegador.

## Sobre el Plan 365 de código abierto

Proyecto **#027** del [Plan 365 de código abierto](https://github.com/rockbenben/365opensource) — una persona + IA, más de 300 proyectos de código abierto en un año. [Envía tu idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)