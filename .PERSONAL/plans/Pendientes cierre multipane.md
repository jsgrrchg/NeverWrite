# Pendientes cierre multipane

Fecha: 2026-04-10
Branch: `feature/multi-pane-workspace`
Estado: Pendiente después del commit de implementación

## Contexto

La implementación multipane quedó desarrollada localmente y este plan resume lo que sigue antes de considerar la rama lista para merge.

El objetivo de este documento no es volver a planificar la feature, sino listar el trabajo de cierre que todavía conviene ejecutar después de dejar el estado actual comiteado.

## Pendientes reales

### 1. QA manual multipane

- abrir `1`, `2` y `3` panes y verificar resize continuo
- validar foco visual por pane y sincronía del panel derecho
- abrir la misma nota en panes distintos y editar sin ambigüedad
- validar `Add to New Pane`, mover tabs entre panes y `Close Pane`
- probar pane vacío y reapertura desde file tree/search/wikilinks

### 2. QA manual de review y cambios del agente

- probar `note + review + note` en panes distintos
- validar aceptación y rechazo de cambios con foco alternando entre panes
- revisar panel de cambios del agente mientras cambia el pane enfocado
- verificar que no se aplique una review sobre el pane incorrecto

### 3. Validación ampliada automatizada

- correr una pasada más amplia de tests de integración relacionados con editor, links, file tree, search y chat
- decidir si vale la pena correr la suite completa de `apps/desktop` antes del merge

### 4. Limpieza final

- revisar si conviene eliminar o resolver los warnings existentes de `act(...)` en `AIReviewView.test.tsx`
- hacer una pasada visual final de copy y affordances del estado vacío
- preparar el diff para revisión o PR

## Criterio de salida

La rama puede considerarse lista para merge cuando:

- el flujo multipane se sienta estable en QA manual
- review inline y cambios del agente no presenten ambigüedad operativa
- no queden regresiones detectadas en los flujos críticos de editor
- el diff esté listo para revisión externa
