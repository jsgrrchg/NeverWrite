# Implementación tabs de chat por vault

## Objetivo

Implementar ==pestañas de chat por vault== en VaultAI, manteniendo el runtime AI actual y resolviendo el feature en frontend + persistencia UI.

## Decisión de producto

- **Sí implementar**
- **Arquitectura elegida:** tabs de chat dentro del panel derecho
- **No mezclar en MVP** tabs de chat con tabs de notas
- **Fuente de verdad de conversación:** `chatStore` + `.vaultai/sessions`
- **Fuente de verdad de tabs abiertas:** persistencia UI por vault

## Razón técnica

La base ya existe:

- `chatStore` ya soporta múltiples sesiones en memoria con `sessionsById`, `sessionOrder` y `activeSessionId`
- los eventos AI ya llegan por `session_id`
- el historial ya se persiste por vault en `.vaultai/sessions/*.json`
- `AiManager::list_sessions()` ya filtra por `vault_root`

Conclusión: el feature es de ==workspace/UI/estado==, no de ACP.

## Alcance MVP

### Incluye

- abrir chat en nueva pestaña del panel derecho
- cambiar entre tabs de chat
- cerrar tab sin borrar la sesión
- reabrir el vault y restaurar tabs de chat
- mantener draft por sesión
- mostrar actividad de streaming en tabs no activas

### No incluye

- tabs de chat mezcladas con tabs de notas
- drag & drop de tabs de chat
- múltiples paneles AI simultáneos
- desacoplar chats en ventanas
- refactor de `editorStore`

## Arquitectura propuesta

### Capa de sesiones

Se mantiene intacta:

- `useChatStore`
- `AIChatSession`
- Tauri commands AI actuales
- persistencia de historial en `.vaultai/sessions`

### Nueva capa: tabs visibles

Agregar un store específico para tabs de chat del panel derecho.

```ts
type ChatWorkspaceTab = {
  id: string;
  sessionId: string;
  pinned?: boolean;
};

type PersistedChatWorkspace = {
  version: 1;
  tabs: ChatWorkspaceTab[];
  activeTabId: string | null;
};
```

### Principio

- la tab referencia una `sessionId`
- la sesión sigue siendo la fuente de verdad del contenido
- cerrar una tab != borrar una sesión
- borrar una sesión => cerrar cualquier tab que la referencie

## Store nuevo

### Nombre sugerido

- `apps/desktop/src/features/ai/store/chatTabsStore.ts`

### Responsabilidades

- abrir tab para `sessionId`
- activar tab
- cerrar tab
- cerrar tabs huérfanas
- persistir por vault
- rehidratar al abrir vault
- exponer orden + activa para la UI

### API mínima

```ts
interface ChatTabsStore {
  tabs: ChatWorkspaceTab[];
  activeTabId: string | null;
  openSessionTab: (sessionId: string, options?: { activate?: boolean }) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  ensureSessionTab: (sessionId: string) => string;
  removeTabsForSession: (sessionId: string) => void;
  pruneInvalidTabs: (validSessionIds: string[]) => void;
  hydrateForVault: (payload: PersistedChatWorkspace | null) => void;
  reset: () => void;
}
```

## Persistencia

### Key propuesta

- `vaultai.chat.tabs:<vaultPath>`

### Persistir

- `tabs[]`
- `activeTabId`

### No persistir

- mensajes
- adjuntos
- config options
- drafts serializados fuera de `chatStore`

### Estrategia de restauración

- restaurar tabs solo cuando hay `vaultPath`
- validar que `sessionId` exista en `chatStore`
- si la sesión viene solo como historial persistido, permitir tab y hacer `resumeSession` al activarla o al enviar
- si `sessionId` ya no existe, eliminar tab huérfana

### Regla

- restauración **lazy**

## Cambios de UI

### `AIChatHeader`

Reemplazar el selector actual de “Recent chats” como punto principal de navegación por:

- strip horizontal de tabs de chat
- botón `+` para nuevo chat
- menú secundario para listar sesiones no abiertas o recientes

### `AIChatSessionList`

Cambiar de rol:

- hoy funciona como selector principal de sesiones
- en MVP pasa a ser menú auxiliar de “abrir sesión en tab”

### `AIChatPanel`

Cambios:

- leer `chatTabsStore`
- derivar `currentSession` desde `activeTabId -> sessionId -> sessionsById`
- cuando se crea nueva sesión, abrir tab automáticamente
- cuando se selecciona una sesión desde lista, abrir/activar tab en vez de solo cambiar `activeSessionId`
- sincronizar `activeSessionId` con la tab activa

## Reglas de comportamiento

### Abrir nuevo chat

- `newSession()`
- `openSessionTab(session.sessionId, { activate: true })`
- `setActiveSession(session.sessionId)`

### Abrir sesión existente

- si ya hay tab para esa sesión, activarla
- si no existe, crear tab y activarla
- luego `loadSession(sessionId)`

### Cerrar tab

- cerrar solo la tab
- no borrar historial ni sesión
- si era la activa, activar la vecina más cercana
- sincronizar `activeSessionId` con la nueva tab activa

### Borrar sesión

- borrar historial como hoy
- sacar sesión de `chatStore`
- cerrar tabs asociadas en `chatTabsStore`
- si no quedan sesiones, crear una nueva como hoy

### Cambiar de vault

- reset de `chatTabsStore`
- rehidratar tabs desde `vaultai.chat.tabs:<vaultPath>`
- prune de tabs cuya sesión no exista

## Drafts y composer

### Decisión

No mover drafts fuera de `chatStore`.

### Motivo

`composerPartsBySessionId` ya resuelve el draft por sesión.

### Regla operativa

- la tab activa siempre determina `activeSessionId`
- el composer sigue leyendo/escribiendo sobre la sesión activa
- al cambiar de tab no se toca el draft; solo cambia la sesión activa

## Streaming y estado visual

### Requisito

Una tab no activa debe mostrar si su sesión:

- está `streaming`
- está `waiting_permission`
- está en `error`

### Solución

Derivar badges desde `sessionsById[sessionId].status`.

### UI mínima sugerida

- punto azul: `streaming`
- punto ámbar: `waiting_permission`
- punto rojo: `error`

## Archivos a tocar

### Nuevos

- `apps/desktop/src/features/ai/store/chatTabsStore.ts`
- `apps/desktop/src/features/ai/components/AIChatTabs.tsx`

### Modificados

- `apps/desktop/src/features/ai/AIChatPanel.tsx`
- `apps/desktop/src/features/ai/components/AIChatHeader.tsx`
- `apps/desktop/src/features/ai/components/AIChatSessionList.tsx`
- `apps/desktop/src/features/ai/store/chatStore.ts`
- `apps/desktop/src/App.tsx`

### No deberían requerir cambios

- `vendor/codex-acp/**`
- `apps/desktop/src-tauri/src/ai/manager.rs`
- `apps/desktop/src-tauri/src/ai/persistence.rs`

## Plan de implementación

### Fase 1. Crear store de tabs ==(En implementación)==

- crear `chatTabsStore.ts`
- definir tipos de tab y persistencia
- implementar persistencia por vault
- implementar `openSessionTab`, `closeTab`, `setActiveTab`, `pruneInvalidTabs`

**Salida**

- store funcional sin UI

### Fase 2. Integrar ciclo de vida con `chatStore` (en implementación)

- abrir tab al crear nueva sesión
- abrir/activar tab al seleccionar sesión desde lista
- cerrar tabs al borrar sesión
- sincronizar `activeTabId` -> `activeSessionId`
- resolver restauración inicial al cambiar/abrir vault

**Salida**

- navegación lógica funcionando aunque la UI todavía sea mínima

### Fase 3. Construir UI de tabs

- crear `AIChatTabs.tsx`
- agregar strip horizontal con scroll
- marcar tab activa
- agregar botón cerrar
- agregar badge por estado de sesión
- mantener menú “Recent chats” como entrada secundaria

**Salida**

- UI operativa de tabs en panel derecho

### Fase 4. Restauración por vault

- al abrir vault: cargar sesiones como hoy
- luego rehidratar tabs persistidas
- podar tabs inválidas
- si no hay tabs restaurables pero sí hay sesión activa, abrir una tab por defecto

**Salida**

- persistencia del workspace de chat por vault

### Fase 5. Hardening

- cubrir casos de `persisted:*`
- revisar sesiones resueltas por `resumeSession`
- asegurar que cambiar de tab no rompa composer, adjuntos ni permisos
- asegurar que cerrar tab no cambie historial

**Salida**

- feature lista para QA manual

## Casos borde

- tab apunta a sesión borrada
- vault cambia mientras hay tabs activas
- sesión persistida se migra de `persisted:...` a sesión live nueva tras `resumeSession`
- una sesión recibe eventos mientras su tab no está activa
- usuario cierra la única tab abierta

## Regla especial para `resumeSession`

Cuando una sesión persistida se reanuda, `chatStore.resumeSession()` cambia el `sessionId`.

Por eso `chatTabsStore` debe exponer una operación tipo:

```ts
replaceSessionId(oldSessionId: string, newSessionId: string): void
```

Esto es obligatorio para que las tabs no queden apuntando a `persisted:...`.

## Testing

### Unit tests

- abrir tab nueva para sesión existente
- no duplicar tab para misma sesión
- cerrar tab activa y elegir nueva activa
- persistir y rehidratar por vault
- prune de tabs inválidas
- reemplazo `persisted:* -> liveSessionId`

### Integration/UI tests

- crear nuevo chat y ver nueva tab
- cambiar entre tabs preservando drafts
- cerrar tab sin borrar sesión
- borrar sesión y remover tab asociada
- reabrir vault y restaurar tabs
- tab no activa muestra streaming

## Criterios de aceptación

- el usuario puede tener múltiples chats visibles como tabs dentro del panel derecho
- cambiar de tab cambia correctamente la sesión activa
- el draft de cada sesión se conserva
- cerrar una tab no elimina la sesión ni su historial
- al reabrir el vault se restauran las tabs válidas
- no hay cambios en `vendor/codex-acp`

## Orden recomendado de ejecución

1. `chatTabsStore`
2. integración `chatStore` <-> `chatTabsStore`
3. UI `AIChatTabs`
4. restauración por vault
5. tests

## Checklist

- [ ] Crear `chatTabsStore`
- [ ] Persistir tabs por vault
- [ ] Abrir tab al crear sesión
- [ ] Activar tab al cargar sesión
- [ ] Cerrar tabs al borrar sesión
- [ ] Resolver `replaceSessionId()` al reanudar sesiones persistidas
- [ ] Implementar strip visual de tabs
- [ ] Mostrar badges por estado
- [ ] Restaurar tabs al abrir vault
- [ ] Agregar tests unitarios
- [ ] Agregar tests de interacción
