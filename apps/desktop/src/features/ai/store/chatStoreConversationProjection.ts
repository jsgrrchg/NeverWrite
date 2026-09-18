import {
  projectLegacySessionToCanonical,
  updateConversationBindingsFromLegacySession,
} from "../conversationModel";
import type {
  AcpConversationBinding,
  AIChatSession,
  AIConversation,
} from "../types";

export interface CanonicalChatStoreProjection {
  conversationsById: Record<string, AIConversation>;
  bindingsById: Record<string, AcpConversationBinding>;
  conversationOrder: string[];
  activeConversationId: string | null;
  conversationIdBySessionRef: Record<string, string>;
  sessionIdByConversationId: Record<string, string>;
}

export interface LegacyChatProjectionSource {
  sessionsById: Record<string, AIChatSession>;
  sessionOrder: string[];
  activeSessionId: string | null;
}

function addSessionRef(
  refs: Record<string, string>,
  ref: string | null | undefined,
  conversationId: string,
) {
  const normalized = ref?.trim();
  if (!normalized) return;
  const existingConversationId = refs[normalized];
  if (
    existingConversationId &&
    existingConversationId !== conversationId
  ) {
    return;
  }
  refs[normalized] = conversationId;
}

function orderedSessionIds(source: LegacyChatProjectionSource) {
  const known = new Set<string>();
  const ordered: string[] = [];
  const add = (sessionId: string | null | undefined) => {
    if (!sessionId || known.has(sessionId) || !source.sessionsById[sessionId]) {
      return;
    }
    known.add(sessionId);
    ordered.push(sessionId);
  };

  // The active local session is the compatibility projection that should win
  // if a native resume briefly leaves both the old and new ids in memory.
  add(source.activeSessionId);
  source.sessionOrder.forEach(add);
  Object.keys(source.sessionsById).forEach(add);
    return ordered;
}

function isProjectableSession(session: AIChatSession) {
    return (
        typeof session.sessionId === "string" &&
        typeof session.runtimeId === "string" &&
        typeof session.modelId === "string" &&
        typeof session.modeId === "string" &&
        Array.isArray(session.models) &&
        Array.isArray(session.modes) &&
        Array.isArray(session.configOptions) &&
        Array.isArray(session.messages) &&
        Array.isArray(session.attachments)
    );
}

/**
 * Content-only session updates may be projected without rebuilding bindings
 * or the session-ref indices. Any field that can change conversation identity,
 * routing, or the provider binding belongs in this topology comparison.
 */
export function hasSameCanonicalSessionTopology(
  previous: AIChatSession,
  next: AIChatSession,
) {
  return (
    previous.sessionId === next.sessionId &&
    previous.historySessionId === next.historySessionId &&
    previous.parentSessionId === next.parentSessionId &&
    previous.vaultPath === next.vaultPath &&
    previous.runtimeSessionId === next.runtimeSessionId &&
    previous.runtimeId === next.runtimeId &&
    previous.runtimeDisplayName === next.runtimeDisplayName &&
    previous.runtimeRevision === next.runtimeRevision &&
    previous.runtimeLaunchFingerprint === next.runtimeLaunchFingerprint &&
    previous.continuationStrategy === next.continuationStrategy &&
    previous.modelId === next.modelId &&
    previous.modeId === next.modeId &&
    previous.models === next.models &&
    previous.modes === next.modes &&
    previous.configOptions === next.configOptions &&
    previous.availableCommands === next.availableCommands &&
    previous.effortsByModel === next.effortsByModel &&
    previous.runtimeState === next.runtimeState &&
    previous.conversationBindings === next.conversationBindings
  );
}

function hasSameCanonicalConversationContent(
  previous: AIConversation,
  next: AIConversation,
) {
  return (
    previous.conversationId === next.conversationId &&
    previous.parentConversationId === next.parentConversationId &&
    previous.vaultPath === next.vaultPath &&
    previous.closedAt === next.closedAt &&
    previous.status === next.status &&
    previous.activeWorkCycleId === next.activeWorkCycleId &&
    previous.visibleWorkCycleId === next.visibleWorkCycleId &&
    previous.actionLog === next.actionLog &&
    previous.messages === next.messages &&
    previous.attachments === next.attachments &&
    previous.preferredSelection === next.preferredSelection &&
    previous.activeBindingId === next.activeBindingId &&
    previous.persistedCreatedAt === next.persistedCreatedAt &&
    previous.persistedUpdatedAt === next.persistedUpdatedAt &&
    previous.persistedTitle === next.persistedTitle &&
    previous.customTitle === next.customTitle &&
    previous.persistedPreview === next.persistedPreview &&
    previous.persistedMessageCount === next.persistedMessageCount &&
    previous.loadedPersistedMessageStart ===
      next.loadedPersistedMessageStart &&
    previous.isLoadingPersistedMessages ===
      next.isLoadingPersistedMessages &&
    previous.isPersistedSession === next.isPersistedSession &&
    previous.isPendingSessionCreation === next.isPendingSessionCreation &&
    previous.isResumingSession === next.isResumingSession
  );
}

/**
 * Refreshes the mutable conversation payload for one legacy session while
 * preserving canonical identity, normalized parent refs, and staged routing.
 */
export function projectCanonicalConversationContentUpdate(
  previous: AIConversation,
  session: AIChatSession,
) {
  const next: AIConversation = {
    ...previous,
    closedAt: session.closedAt ?? null,
    status: session.status,
    activeWorkCycleId: session.activeWorkCycleId ?? null,
    visibleWorkCycleId: session.visibleWorkCycleId ?? null,
    actionLog: session.actionLog,
    messages: session.messages,
    attachments: session.attachments,
    persistedCreatedAt: session.persistedCreatedAt ?? null,
    persistedUpdatedAt: session.persistedUpdatedAt ?? null,
    persistedTitle: session.persistedTitle ?? null,
    customTitle: session.customTitle ?? null,
    persistedPreview: session.persistedPreview ?? null,
    persistedMessageCount: session.persistedMessageCount,
    loadedPersistedMessageStart:
      session.loadedPersistedMessageStart ?? null,
    isLoadingPersistedMessages: session.isLoadingPersistedMessages,
    isPersistedSession: session.isPersistedSession ?? false,
    isPendingSessionCreation: session.isPendingSessionCreation ?? false,
    isResumingSession: session.isResumingSession ?? false,
  };

  return hasSameCanonicalConversationContent(previous, next)
    ? previous
    : next;
}

/**
 * Builds the canonical store projection from the transitional session store.
 * One conversation is emitted per durable history id even if multiple local or
 * native session ids temporarily refer to it.
 */
export function projectChatStoreToCanonical(
  source: LegacyChatProjectionSource,
): CanonicalChatStoreProjection {
  const conversationsById: Record<string, AIConversation> = {};
  const bindingsById: Record<string, AcpConversationBinding> = {};
  const conversationIdBySessionRef: Record<string, string> = {};
  const sessionIdByConversationId: Record<string, string> = {};
  const conversationOrder: string[] = [];

  for (const sessionId of orderedSessionIds(source)) {
        const session = source.sessionsById[sessionId];
        if (!session || !isProjectableSession(session)) continue;

    const projected = projectLegacySessionToCanonical(session);
    const bindingState = updateConversationBindingsFromLegacySession(session);
    const conversationId = bindingState.conversationId;

    addSessionRef(
      conversationIdBySessionRef,
      session.sessionId,
      conversationId,
    );
    addSessionRef(
      conversationIdBySessionRef,
      session.historySessionId,
      conversationId,
    );
    addSessionRef(
      conversationIdBySessionRef,
      session.runtimeSessionId,
      conversationId,
    );
    addSessionRef(conversationIdBySessionRef, conversationId, conversationId);

    for (const binding of bindingState.providerBindings) {
      if (!bindingsById[binding.bindingId]) {
        bindingsById[binding.bindingId] = binding;
      }
      addSessionRef(
        conversationIdBySessionRef,
        binding.bindingId,
        conversationId,
      );
      addSessionRef(
        conversationIdBySessionRef,
        binding.runtimeSessionId,
        conversationId,
      );
    }

    if (conversationsById[conversationId]) continue;

    conversationsById[conversationId] = {
      ...projected.conversation,
      conversationId,
      preferredSelection: bindingState.preferredSelection,
      activeBindingId: bindingState.activeBindingId,
    };
    sessionIdByConversationId[conversationId] = session.sessionId;
    conversationOrder.push(conversationId);
  }

  // Parent refs from legacy payloads can be local, native, or durable ids.
  // Normalize them only after every ref has been indexed.
  for (const [conversationId, conversation] of Object.entries(
    conversationsById,
  )) {
    const parentRef = conversation.parentConversationId;
    if (!parentRef) continue;
    const parentConversationId =
      conversationIdBySessionRef[parentRef] ?? parentRef;
    if (parentConversationId !== parentRef) {
      conversationsById[conversationId] = {
        ...conversation,
        parentConversationId,
      };
    }
  }

  const activeConversationId = source.activeSessionId
    ? (conversationIdBySessionRef[source.activeSessionId] ?? null)
    : null;

  return {
    conversationsById,
    bindingsById,
    conversationOrder,
    activeConversationId,
    conversationIdBySessionRef,
    sessionIdByConversationId,
  };
}

export function resolveConversationId(
  state: Pick<
    CanonicalChatStoreProjection,
    "conversationIdBySessionRef" | "conversationsById"
  >,
  ref: string | null | undefined,
) {
  if (!ref) return null;
  const indexed = state.conversationIdBySessionRef[ref];
  if (indexed) return indexed;
  return state.conversationsById[ref] ? ref : null;
}

export function resolveLegacySessionId(
  state: Pick<
    CanonicalChatStoreProjection,
    | "conversationIdBySessionRef"
    | "conversationsById"
    | "sessionIdByConversationId"
  >,
  ref: string | null | undefined,
) {
  const conversationId = resolveConversationId(state, ref);
  return conversationId
    ? (state.sessionIdByConversationId[conversationId] ?? null)
    : null;
}

export function projectSessionMapToConversations<T>(
  valuesBySessionId: Readonly<Record<string, T>>,
  projection: Pick<
    CanonicalChatStoreProjection,
    | "conversationIdBySessionRef"
    | "conversationsById"
    | "sessionIdByConversationId"
  >,
): Record<string, T> {
  const valuesByConversationId: Record<string, T> = {};
  const resolveValue = createConversationScopedValueResolver(
    valuesBySessionId,
    projection,
  );
  for (const conversationId of Object.keys(projection.conversationsById)) {
    const resolved = resolveValue(conversationId);
    if (resolved.hasValue) {
      valuesByConversationId[conversationId] = resolved.value;
    }
  }
  return valuesByConversationId;
}

export function createConversationScopedValueResolver<T>(
  valuesBySessionId: Readonly<Record<string, T>>,
  projection: Pick<
    CanonicalChatStoreProjection,
    "conversationIdBySessionRef" | "sessionIdByConversationId"
  >,
): (
  conversationId: string,
) => { hasValue: false } | { hasValue: true; value: T } {
  let aliasValuesByConversationId: Record<string, T> | null = null;

  return (conversationId) => {
    const canonicalSessionId =
      projection.sessionIdByConversationId[conversationId];
    if (
      canonicalSessionId &&
      Object.hasOwn(valuesBySessionId, canonicalSessionId)
    ) {
      return {
        hasValue: true,
        value: valuesBySessionId[canonicalSessionId],
      };
    }
    if (Object.hasOwn(valuesBySessionId, conversationId)) {
      return { hasValue: true, value: valuesBySessionId[conversationId] };
    }

    if (!aliasValuesByConversationId) {
      aliasValuesByConversationId = {};
      // Legacy values can still be keyed by a native session or binding id.
      // Build fallbacks from the canonical ref index so precedence does not
      // depend on insertion order in the session-scoped value map.
      for (const [sessionRef, mappedConversationId] of Object.entries(
        projection.conversationIdBySessionRef,
      )) {
        if (
          !Object.hasOwn(
            aliasValuesByConversationId,
            mappedConversationId,
          ) &&
          Object.hasOwn(valuesBySessionId, sessionRef)
        ) {
          aliasValuesByConversationId[mappedConversationId] =
            valuesBySessionId[sessionRef];
        }
      }
    }
    return Object.hasOwn(aliasValuesByConversationId, conversationId)
      ? {
          hasValue: true,
          value: aliasValuesByConversationId[conversationId],
        }
      : { hasValue: false };
  };
}
