# Funciones de VaultAI

## Objetivo

VaultAI debe ser una aplicacion de escritorio local-first para trabajar sobre un vault real de archivos Markdown, con una experiencia base comparable a Obsidian y una capa de AI centrada en contexto, trazabilidad y control del usuario.

## 1. Funciones base tipo Obsidian

Estas son las capacidades que VaultAI deberia cubrir como base para que el producto se sienta util desde el primer dia.

### Gestion del vault

- Abrir uno o varios vaults locales.
- Leer y escribir archivos Markdown del usuario sin formato propietario.
- Escanear carpetas y subcarpetas automaticamente.
- Detectar cambios en el filesystem con watcher.
- Crear, renombrar, mover y borrar notas y carpetas.
- Mantener historial de vaults recientes.

### Exploracion y navegacion

- Explorador de archivos y carpetas.
- Cambio rapido entre notas.
- Notas recientes.
- Favoritos o bookmarks.
- Vista de outline por encabezados.
- Soporte para pestañas y paneles.
- Workspaces o layouts guardados.

### Editor Markdown

- Editor rapido y estable para Markdown.
- Resaltado de sintaxis.
- Soporte para wikilinks `[[...]]`.
- Soporte para headings, listas, quotes, tablas, code fences y checklists.
- Atajos de teclado y command palette.
- Vista previa o previsualizacion contextual.
- Conteo de palabras y caracteres.

### Conocimiento conectado

- Backlinks de la nota activa.
- Outgoing links.
- Tags en contenido y frontmatter.
- Propiedades o metadata en frontmatter YAML.
- Busqueda por titulo, contenido, path, tags y propiedades.
- Grafo de notas y relaciones.
- Deteccion de notas huerfanas y notas sin resolver.

### Herramientas de organizacion

- Templates de notas.
- Daily notes o notas por fecha.
- Creacion rapida de notas con nombre unico.
- Canvas o espacio visual para relacionar ideas.
- Busqueda guardada y accesos rapidos.
- Recuperacion basica ante cierres o errores.

## 2. Funciones diferenciales de VaultAI

Estas son las funciones que convierten a VaultAI en algo mas que un editor Markdown con chatbot.

### AI contextual sobre el vault

- Chat lateral con contexto de la nota activa.
- Respuestas apoyadas en titulo, contenido, backlinks, links salientes, tags y notas relacionadas.
- Capacidad de consultar varias notas del vault para responder con contexto real.
- Seleccion explicita del alcance de contexto antes de enviar informacion al modelo.

### Edicion asistida

- Reescritura de una seleccion.
- Resumen de una nota.
- Expansion de borradores.
- Cambio de tono, claridad o estructura.
- Conversion de bullets en texto desarrollado.
- Generacion de titulos alternativos.
- Sugerencia de estructura para notas largas.

### Acciones de conocimiento

- Crear nota nueva a partir de prompt, seleccion o conversacion.
- Sugerir enlaces internos relevantes.
- Detectar notas relacionadas no enlazadas.
- Proponer fusionar notas duplicadas o fragmentadas.
- Proponer dividir una nota grande en varias notas.
- Generar resumen ejecutivo de varias notas.
- Planes de accion sobre varias notas del vault.

### Sistema de diffs y control de cambios

- Toda edicion AI debe volver como propuesta revisable.
- Vista previa de cambios inline en el editor.
- Diff por hunks con inserciones, reemplazos y eliminaciones.
- Aceptar o rechazar cada hunk individualmente.
- Persistir cambios solo despues de confirmar.
- Revertir cambios aplicados recientemente.
- Mantener trazabilidad entre prompt, respuesta y cambio aplicado.

### Seguridad y confianza

- AI asistida, no autonoma.
- El usuario decide siempre que se escribe en disco.
- El contenido fuente sigue viviendo en Markdown.
- Transparencia sobre que contexto se uso para responder o proponer cambios.
- Modo local-first con configuracion clara del provider y modelo.

## 3. Funciones tecnicas de soporte

Estas funciones no siempre son visibles, pero son necesarias para que la experiencia sea solida.

### Indexado y metadata

- Parseo de wikilinks, tags y frontmatter.
- Indice de busqueda full text.
- Indice de backlinks y grafo de relaciones.
- Cache de notas recientes y notas relacionadas.
- Reindexado incremental cuando cambia una nota.

### Persistencia auxiliar

- Settings de aplicacion.
- Configuracion de provider y modelo AI.
- Historial de chat por vault o por nota.
- Sesiones de trabajo.
- Diffs pendientes.
- Snapshots temporales para recuperacion.

### Arquitectura esperada

- Frontend de escritorio ligero con panel izquierdo, editor central y panel AI derecho.
- Backend responsable de diff, indexado, acceso a archivos y orquestacion AI.
- El frontend renderiza y controla la experiencia, pero no define la verdad del diff ni de la persistencia.

## 4. MVP recomendado

Para validar el producto, el MVP deberia incluir:

- Abrir vault local.
- Navegacion basica por archivos.
- Editor Markdown.
- Soporte para wikilinks.
- Backlinks basicos.
- Busqueda simple.
- Chat lateral contextual sobre la nota activa.
- Reescritura de seleccion.
- Resumen de nota.
- Diff inline con accept y reject.
- Guardado seguro del archivo tras confirmacion.

## 5. Fase siguiente

Despues del MVP, las siguientes funciones aportan mas valor:

- Full text search mas potente.
- Tags y propiedades completas.
- Notas relacionadas.
- Crear nota desde chat.
- Renombrado y move seguro con actualizacion de links.
- Graph view.
- Canvas.
- Templates y daily notes.
- Workspaces.
- Bookmarks.

## 6. Lo que no deberia ser al inicio

Para mantener foco, VaultAI no deberia arrancar como:

- suite colaborativa tipo Notion
- red social de notas
- sistema enterprise con permisos complejos
- editor WYSIWYG pesado
- agente autonomo que modifica el vault sin confirmacion

## Referencia de producto

La base tipo Obsidian de este documento toma como referencia funciones nucleares actuales documentadas por Obsidian Help, como File explorer, Search, Backlinks, Graph view, Canvas, Properties, Bookmarks, Command palette, Templates y Workspaces.
