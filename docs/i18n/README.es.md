<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Tablero de repo·radar: indicadores de alerta arriba, cola «necesita acción» debajo y una tarjeta por repo con rama, estado del árbol de trabajo y editor / terminal / carpeta en un clic" />
</p>

# repo-radar

> Plan 365 de código abierto #027 · Un panel local que vigila todos tus repos Git y te muestra cuáles te necesitan.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[⬇ Descargar para Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Tienes más repos de Git de los que puedes seguir de memoria. repo-radar los vigila todos y te muestra los pocos que te necesitan ahora — el resto puede salir de tu cabeza.

Saca a la luz lo que si no se te olvidaría revisar:

- **Trabajo a medias** — cambios sin commit, sin push o en stash, señalados antes de que los pierdas.
- **GitHub esperándote** — PR abiertas, issues y CI en rojo, leídos con tu `gh` ya autenticado.
- **Proyectos que se enfrían** — sin tocar demasiado tiempo, o con una versión pendiente.
- **Repos que perdiste de vista** — todos en una pantalla, con búsqueda, a un clic de abrirse.

Lo que requiere acción sube arriba como una cola: una entrada por repo, por urgencia. Descártalo con ✓ y no vuelve hasta que algo cambie de verdad — con una excepción: un stash descartado reaparece a los 30 días, para que uno que de verdad olvidaste no desaparezca para siempre.

## Compatibilidad

| Aspecto | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Instalación | instalador `.exe` | `.dmg` | `.AppImage` |
| Cerrar la ventana | va a la bandeja | va a la bandeja | se cierra — usa **Iniciar al iniciar sesión** para mantenerlo |
| Vigilancia de cambios | todos los repos bajo un directorio de escaneo | igual | los primeros 200 repos (el tope se sube o se quita en ajustes) |

Todo corre en tu máquina y usa el `git` que ya tienes — sin cuenta, sin telemetría, no se sube nada. La columna de GitHub (PR, issues, CI) es opcional y lee con la [CLI `gh`](https://cli.github.com/) donde ya estás autenticado; sin ella, el resto sigue funcionando.

## Instalación

Descarga el archivo de tu plataforma desde [Releases](https://github.com/rockbenben/repo-radar/releases) — no hace falta Node.js. La app no está firmada, así que cada sistema avisa en el primer arranque:

- **Windows** — en el aviso de SmartScreen, *Más información → Ejecutar de todas formas*.
- **macOS** — clic derecho → Abrir la primera vez. Si macOS la da por dañada: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — primero `chmod +x repo-radar-*.AppImage`.

¿Prefieres no fiarte de un binario? [Compílalo tú](../development.md) — es `npm install && npm start`.

En el primer arranque pulsa **Añadir directorios de escaneo** y apunta a la carpeta que *contiene* tus repos — un `~/Proyectos`, no cada repo uno a uno. Baja hasta 6 niveles buscando cualquier cosa con un `.git`, y el tablero se llena. Sin JSON, sin reiniciar.

## El tablero

Una tarjeta por repo — color de salud, rama, desglose del árbol de trabajo, ahead/behind, último commit, etiquetas — con **editor / terminal / carpeta** en un clic.

- **Encontrarlo** — busca, o filtra por lenguaje, `#tag` o indicador. ⌘/Ctrl-K abre un lanzador.
- **Guardar una vista** — cualquier filtro + orden + agrupación, con nombre y reutilizable.
- **Actuar en lote** — fetch / pull / push sobre los repos seleccionados, o un mismo comando de shell en todos. Que uno falle nunca detiene al resto.
- **Trabajar en el sitio** — el panel de detalle hace commit con diff en vivo, cambia de rama, descarta cambios, limpia ramas fusionadas y trae PR y CI de GitHub bajo demanda.
- **Crear y mover repos** — **+ Nuevo** crea un repo y lo pone directamente en el tablero; exportar / importar el manifiesto lleva la lista de repos — rutas, remotos, grupos, etiquetas — a otra máquina.

Los indicadores de arriba son los tipos de alerta — sin remoto, HEAD desvinculado, sin push, sin commit, detrás del remoto, stash pendiente. Apaga los que no te importen en ⚙ Ajustes.

Dos pestañas más: **Estadísticas** (heatmap de commits de un año, repos más y menos activos) y **Registro de trabajo** (copiar un rango de fechas como informe semanal en Markdown).

Tema oscuro de cabina de instrumentos, localizado a 18 idiomas, con el contraste del texto ajustado a WCAG AA en claro y en oscuro.

## Mantenerse al día

Por defecto: un reescaneo de respaldo cada 30 minutos más el reescaneo manual de la barra. Un reescaneo solo lee el estado local de git — nunca contacta un remoto para descubrir qué cambió.

El escaneo automático por vigilancia de archivos está **desactivado por defecto** y se activa en ajustes. También es local, pero con varios proyectos compilando a la vez el búfer de notificaciones del kernel se desborda sin parar, y un desbordamiento significa eventos perdidos en los que ya no se puede confiar — la única respuesta segura es otro reescaneo, limitado con backoff exponencial a uno cada 30 minutos como máximo. Aun así, un precio fijo demasiado alto para una herramienta de echar un vistazo. Activado, los repos nuevos, borrados o renombrados aparecen en segundos.

Renombra o mueve un repo y conserva etiquetas, favorito, estado de archivo y notas. repo-radar reconoce un repo por lo que hay dentro, no por dónde está, así que una carpeta movida sigue siendo el mismo proyecto y no uno nuevo.

El fetch programado en segundo plano es opcional y es lo único que habla con tus remotos por su cuenta. La columna de GitHub es lo único que sale a la red por calendario sin que se lo pidas: mientras la CLI `gh` esté instalada, PR, issues y CI se refrescan por ella cada 12 minutos y tras cada reescaneo. Sin `gh`, o sin remotos de GitHub, la app es totalmente local.

## Corre en segundo plano sin molestar

Cerrar la ventana deja repo-radar en la bandeja **en Windows y macOS**, así que reescaneos, vigilancia y avisos de GitHub siguen; en Linux la ventana cierra la app, porque allí no hay bandeja fiable. En Windows y Linux un clic en el icono recupera el tablero; en macOS el icono abre su menú, donde esa acción es la primera entrada — y donde vive Salir en todas las plataformas.

Al salir espera hasta 10 segundos por el trabajo de git en curso — un pull en lote, un stash descartado — para que nada se corte a mitad de escritura y deje un `.git/index.lock` obsoleto. Si no basta, sale igualmente y lo deja dicho en el registro.

Activa **Iniciar al iniciar sesión** y arranca sin ventana con tu sesión. Las notificaciones de escritorio son opcionales y solo saltan cuando algo *nuevo* llega a tu «por resolver» de GitHub — un PR, un issue o una CI fallida; nunca en la primera carga.

## Configuración

Directorios de escaneo, carpetas excluidas y comandos de apertura se editan en ⚙ Ajustes → Escaneo y comandos de apertura. Lo demás vive en `~/.repo-radar/config.json`, que rara vez necesitas abrir; lo puramente visual (vistas guardadas, tema, idioma, registro de actividad) vive en el almacenamiento del navegador. La lista completa de campos, los archivos de caché a su lado y las variables de entorno para una segunda instancia están en la [referencia de configuración](../configuration.md).

## Limitaciones conocidas

- **Las actualizaciones son manuales a propósito.** Sin auto-update: pasa el nuevo instalador por encima del anterior.
- **Moverse y que el escaneo no te reconozca deja una pista, no una pérdida silenciosa.** Cuando la coincidencia automática falla, la tarjeta nueva ofrece *«probablemente una copia movida de la ruta antigua»* — pulsa **Migrar** y las etiquetas, la estrella y las notas siguen al repo. Solo aparece en repos escaneados al menos una vez en esta instalación (el registro necesita haber visto su remoto) y nunca en un destino que no hayas añadido como directorio de escaneo.
- **Linux no tiene una bandeja fiable**, así que cerrar la ventana cierra la app.
- **Los repos añadidos uno a uno, fuera de un directorio de escaneo, no se reconocen así** — si mueves uno, apuntas tú mismo a la nueva ruta.
- **Descartar cambios no toca submódulos ni repos git anidados**, y lo dice en vez de dar por hecho que limpió todo.

## Sobre el Plan 365 de código abierto

Proyecto **#027** del [Plan 365 de código abierto](https://github.com/rockbenben/365opensource) — una persona + IA, más de 300 proyectos de código abierto en un año.

[Envía tu idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
