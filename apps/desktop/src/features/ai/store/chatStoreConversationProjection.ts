import {
  projectCanonicalConversationToLegacy,
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
  if (normalized) refs[normalized] = conversationId;
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
    "conversationIdBySessionRef" | "conversationsById"
  >,
): Record<string, T> {
  const valuesByConversationId: Record<string, T> = {};
  for (const [sessionRef, value] of Object.entries(valuesBySessionId)) {
    const conversationId = resolveConversationId(projection, sessionRef);
    if (conversationId) valuesByConversationId[conversationId] = value;
  }
  return valuesByConversationId;
}

/** Returns the temporary AIChatSession view used by legacy UI consumers. */
export function selectLegacySessionForConversation(
  state: CanonicalChatStoreProjection & {
    sessionsById: Record<string, AIChatSession>;
  },
  conversationId: string,
) {
  const conversation = state.conversationsById[conversationId];
  const sessionId = state.sessionIdByConversationId[conversationId];
  const template = sessionId ? state.sessionsById[sessionId] : null;
  const binding = conversation?.activeBindingId
    ? state.bindingsById[conversation.activeBindingId]
    : null;
  if (!conversation || !template || !binding) return null;
  return projectCanonicalConversationToLegacy(conversation, binding, template);
}
