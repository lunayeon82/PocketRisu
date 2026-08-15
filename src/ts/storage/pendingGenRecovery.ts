// Client-side counterpart to server.cjs's runDurableProxyPump /
// pendingGenApi.cjs. Recovers AI replies that finished generating on the
// server while this tab was backgrounded/killed/disconnected — see
// process/index.svelte.ts's sendChat() for where a generation opts into
// durable buffering (arg.durable) and acks it away on normal completion.
//
// Replay deliberately reuses the exact parsers already written for LIVE
// streaming (getTranStream, buildAnthropicSseStream, the adapter
// mapXxxSseToDeltas generators) instead of re-implementing SSE parsing here —
// see shared.ts's replayViaTransformStream and each parser's export comment.
import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { requestImmediateSave } from '../globalApi.svelte'
import { listPendingGenerations, getPendingGeneration, ackPendingGeneration } from './chatStorage'
import type { DurableGenerationParserKind } from '../process/request/request'
import { formatPresetReasoning, type RequestDataArgumentExtended } from '../process/request/request'
import { replayViaTransformStream } from '../process/request/shared'
import { getTranStream as getOpenAiTranStream } from '../process/request/openAI/requests'
import { getTranStream as getGoogleTranStream } from '../process/request/google'
import { buildAnthropicSseStream } from '../process/request/anthropic'
import { mapOpenAiSseToDeltas } from '../preset/adapter/openaiCompatible'
import { mapAnthropicSseToDeltas } from '../preset/adapter/anthropicMessages'
import { mapGeminiSseToDeltas } from '../preset/adapter/googleGemini'
import type { LLMModel } from '../model/modellist'

function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function oneShotByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes)
            controller.close()
        }
    })
}

// Mirrors pumpPresetStream's buildChunk() (presetStreamPump.ts) — the
// adapter-* parsers have no other dependency on the live request context, so
// replay is just: drain the generator, accumulate text/reasoning the same way.
async function replayAdapterDeltas(gen: AsyncGenerator<{ textDelta: string, reasoningDelta?: string }, void, void>): Promise<string> {
    let fullText = ''
    let reasoningText = ''
    for await (const delta of gen) {
        if (delta.reasoningDelta) {
            reasoningText += delta.reasoningDelta
        }
        fullText += delta.textDelta
    }
    return (reasoningText.length > 0 ? formatPresetReasoning([{ text: reasoningText }]) : '') + fullText
}

async function replayRawBody(
    parserKind: DurableGenerationParserKind,
    rawBytes: Uint8Array,
    replayMeta: Record<string, unknown> | null,
): Promise<string> {
    switch (parserKind) {
        case 'openai-legacy': {
            // getTranStream only reads modelInfo.flags/extractJson/schema/multiGen off
            // this — formated/bias are never touched, filled in only to satisfy the type.
            const replayArg = {
                formated: [],
                bias: {},
                extractJson: replayMeta?.extractJson as string | undefined,
                schema: replayMeta?.schema as string | undefined,
                multiGen: replayMeta?.multiGen as boolean | undefined,
                modelInfo: {
                    flags: (replayMeta?.modelFlags as LLMModel['flags']) ?? [],
                    internalID: replayMeta?.modelInternalID as string | undefined,
                    id: replayMeta?.modelId as string | undefined,
                    format: replayMeta?.modelFormat,
                } as LLMModel,
            } as RequestDataArgumentExtended
            return replayViaTransformStream(rawBytes, getOpenAiTranStream(replayArg))
        }
        case 'google-legacy': {
            const modelInfo = {
                internalID: replayMeta?.modelInternalID as string | undefined,
                id: replayMeta?.modelId as string | undefined,
                format: replayMeta?.modelFormat,
            } as LLMModel
            return replayViaTransformStream(rawBytes, getGoogleTranStream({
                modelInfo,
                saveSignature: (replayMeta?.saveSignatures as boolean) ?? false,
            }))
        }
        case 'anthropic-legacy': {
            const reader = oneShotByteStream(rawBytes).getReader()
            const stream = buildAnthropicSseStream(reader, { replayMode: true })
            const drainReader = stream.getReader()
            let lastChunk = ''
            while (true) {
                const { done, value } = await drainReader.read()
                if (value) {
                    lastChunk = value['0'] ?? lastChunk
                }
                if (done) break
            }
            return lastChunk
        }
        case 'adapter-openai':
            return replayAdapterDeltas(mapOpenAiSseToDeltas(oneShotByteStream(rawBytes)))
        case 'adapter-anthropic':
            return replayAdapterDeltas(mapAnthropicSseToDeltas(oneShotByteStream(rawBytes)))
        case 'adapter-google':
            return replayAdapterDeltas(mapGeminiSseToDeltas(oneShotByteStream(rawBytes)))
    }
}

// Debounce so opening several chats in quick succession (or a chat-open racing
// a visibilitychange) doesn't fire duplicate list calls for the same room.
const inFlight = new Set<string>()

// Silent, automatic recovery — no confirmation prompt (see design discussion:
// this mirrors what would have happened had the tab stayed connected). Safe
// to call whenever a chat becomes the "current" one: chat-open (chatStorage.ts's
// ensureChatHydrated) and tab-foreground (globalApi.svelte.ts's visibilitychange).
export async function checkPendingGenerationsForChat(chaId: string, roomChatId: string): Promise<void> {
    if (!chaId || !roomChatId) return
    const key = `${chaId}/${roomChatId}`
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
        let rows: Awaited<ReturnType<typeof listPendingGenerations>>
        try {
            rows = await listPendingGenerations(roomChatId)
        } catch (e) {
            console.error('[PendingGen] list failed', e)
            return
        }
        if (rows.length === 0) return

        const charIndex = DBState.db.characters.findIndex(c => c.chaId === chaId)
        if (charIndex === -1) return
        const chatIndex = DBState.db.characters[charIndex].chats.findIndex(c => c.id === roomChatId)
        if (chatIndex === -1) return

        let appended = false
        for (const row of rows) {
            if (row.status === 'streaming') {
                // Still in progress server-side — picked up on the next check
                // once it finishes (chat-open / tab-foreground are frequent
                // enough that this isn't worth polling for here).
                continue
            }
            if (row.status === 'error') {
                // Nothing recoverable — if the tab was alive it already
                // surfaced its own failure; if not, there's nothing to show
                // (silent per design). Just ack so it stops showing up.
                void ackPendingGeneration(row.id).catch(() => {})
                continue
            }
            // status === 'done'. Dedup: the live path may have already
            // delivered and saved this exact generation before the server-side
            // ack landed (or before this poll ran) — message.chatId is stamped
            // with the same generationId either way. But sendChat() also
            // stamps that same chatId onto an *empty placeholder* message the
            // moment it starts streaming (index.svelte.ts), before any reply
            // text exists — matching on chatId alone treated that placeholder
            // as "already delivered" and silently ack'd the real reply away
            // without ever filling it in, whenever the original tab's own
            // stream reader stalled forever (fetchViaProxy2 has no client-side
            // read timeout) instead of erroring. chat.isStreaming is the
            // reliable signal: it's only ever false once the live path's own
            // stream loop actually finished (its `finally` ran), so a
            // matching message while isStreaming is still true means that
            // original call is stuck, not done — recover into it instead of
            // treating it as delivered.
            const chat = DBState.db.characters[charIndex].chats[chatIndex]
            const existingIndex = chat.message.findIndex(m => m.chatId === row.id)
            const existingMsg = existingIndex === -1 ? null : chat.message[existingIndex]
            const deliveredLive = !!existingMsg && !!existingMsg.data && chat.isStreaming === false
            if (deliveredLive) {
                void ackPendingGeneration(row.id).catch(() => {})
                continue
            }
            try {
                const full = await getPendingGeneration(row.id)
                if (!full || !full.parserKind) {
                    void ackPendingGeneration(row.id).catch(() => {})
                    continue
                }
                const rawBytes = base64ToUint8Array(full.rawBodyBase64)
                const finalText = await replayRawBody(
                    full.parserKind as DurableGenerationParserKind,
                    rawBytes,
                    full.replayMeta,
                )
                if (existingMsg) {
                    // Fill in the stalled placeholder in place rather than
                    // pushing a duplicate message.
                    existingMsg.data = finalText
                    existingMsg.time = full.completedAt ?? existingMsg.time
                } else {
                    DBState.db.characters[charIndex].chats[chatIndex].message.push({
                        role: 'char',
                        data: finalText,
                        saying: chaId,
                        time: full.completedAt ?? Date.now(),
                        chatId: row.id,
                    })
                }
                // The stalled original sendChat() call (if any) never reaches
                // its `finally` block on its own, so the "still generating"
                // flags it set never clear by themselves — clear them now
                // that we've delivered the content ourselves. Chat-local
                // isStreaming is always safe to clear here; the global
                // doingChat store is only cleared when this chat is the one
                // currently in view, so we don't stomp an unrelated
                // generation the user is actively watching elsewhere.
                DBState.db.characters[charIndex].chats[chatIndex].isStreaming = false
                if (get(selectedCharID) === charIndex && DBState.db.characters[charIndex].chatPage === chatIndex) {
                    const { doingChat } = await import('../process/index.svelte')
                    doingChat.set(false)
                }
                appended = true
            } catch (e) {
                console.error(`[PendingGen] replay failed for ${row.id}`, e)
            } finally {
                // Ack regardless of replay success — a row that fails to
                // replay cleanly shouldn't be retried forever.
                void ackPendingGeneration(row.id).catch(() => {})
            }
        }

        if (appended) {
            DBState.db.characters[charIndex].reloadKeys += 1
            requestImmediateSave()
        }
    } finally {
        inFlight.delete(key)
    }
}

// Convenience wrapper for hooks that only know "whatever chat is currently
// open" (visibilitychange) rather than a specific (chaId, roomChatId) pair.
export function checkPendingGenerationsForCurrentChat(): void {
    const charIndex = get(selectedCharID)
    if (charIndex === undefined || charIndex === null || charIndex < 0) return
    const char = DBState.db.characters[charIndex]
    if (!char) return
    const chat = char.chats[char.chatPage]
    if (!chat?.id || chat._placeholder) return
    void checkPendingGenerationsForChat(char.chaId, chat.id)
}
