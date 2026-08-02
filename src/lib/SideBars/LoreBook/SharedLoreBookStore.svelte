<script lang="ts">
    // Shared lorebook repository UI — folders of entries, backed by
    // rl_lorebooks/rl_lorebook_versions/rl_lorebook_locks/rl_lorebook_drafts
    // (server/node/lorebookApi.cjs). Separate from character.globalLore.
    //
    // Two scopes:
    // - global: visible to everyone, deletable only by admins. Per-viewer
    //   entry activation lives in rl_lorebook_overrides (see the override
    //   view further down) instead of the shared content's own
    //   alwaysActive/mode fields, so one person's "always active" choice
    //   can't leak into everyone else's chats.
    // - private: visible only to its owner, deletable by the owner.
    //
    // Locking is per ENTRY, not per book — a "lorebook" is just a named,
    // scoped grouping (a folder), the same as a folder in the character's own
    // lorebook list. Reading is always lock-free; only editing one entry's
    // content needs that entry's lock (global only — private has exactly one
    // possible editor, so no lock is needed there). Add/delete/reorder/rename
    // are structural, not content edits, so they're lock-free too.
    import { XIcon, PlusIcon, LockIcon, HistoryIcon, RotateCcwIcon, RefreshCwIcon, SparklesIcon, GlobeIcon, LockKeyholeIcon, CopyIcon, TrashIcon, SlidersHorizontalIcon, ChevronRightIcon, ChevronDownIcon, FolderIcon, PencilIcon, CheckIcon, DownloadIcon } from "@lucide/svelte";
    import {
        NodeStorage, SharedLorebookLockedError,
        type SharedLorebookSummary, type SharedLorebookDetail, type SharedLorebookVersion,
        type SharedLorebookOverrideMode, type SharedLorebookScope,
    } from "src/ts/storage/nodeStorage";
    import { getCurrentCharacter, type loreBook } from "src/ts/storage/database.svelte";
    import { syncEntriesFromSharedLorebook, isCharacterLinkedToBook } from "src/ts/process/sharedLorebookLink.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertInput, alertSelect, notifyError, notifySuccess } from "src/ts/alert";
    import { saveLorebookEntryDraftLocal, loadLorebookEntryDraftLocal, clearLorebookEntryDraftLocal } from "src/ts/storage/lorebookDraftDb";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import { onMount, onDestroy } from "svelte";

    interface Props {
        close?: () => void
        /** Render in the host's normal flow (no fixed backdrop/centering, no
         *  close button) — used when this is embedded inline in
         *  LoreBookSetting.svelte instead of opened as a standalone modal. */
        inline?: boolean
    }
    let { close = () => {}, inline = false }: Props = $props();

    const ns = new NodeStorage();

    // Which lorebook ids this browser has already opened, and at what
    // updated_at — purely local bookkeeping for the "새 버전 있음" badge.
    const SEEN_KEY = 'pocketrisu-lorebook-seen';
    function loadSeenMap(): Record<string, number> {
        try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') } catch { return {} }
    }
    function persistSeenMap(map: Record<string, number>) {
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)) } catch {}
    }
    let seenMap = $state(loadSeenMap())
    function markSeen(book: { id: string, updated_at: number }) {
        seenMap = { ...seenMap, [book.id]: book.updated_at }
        persistSeenMap(seenMap)
    }
    function hasUnseenUpdate(book: SharedLorebookSummary): boolean {
        const seenAt = seenMap[book.id]
        return seenAt !== undefined && book.updated_at > seenAt
    }
    function isUnseenBook(book: SharedLorebookSummary): boolean {
        return seenMap[book.id] === undefined
    }

    // "불러오기"와 "업데이트"는 같은 동작 — 이 책에 연결된 로컬 항목들을 최신 content로 교체.
    function isImportedIntoCharacter(book: SharedLorebookSummary): boolean {
        const char = getCurrentCharacter()
        return !!char && isCharacterLinkedToBook(char, book.id)
    }

    async function importOrUpdate(book: SharedLorebookSummary) {
        const char = getCurrentCharacter()
        if (!char) return
        try {
            const count = await syncEntriesFromSharedLorebook(char, book.id)
            markSeen(book)
            notifySuccess(`"${book.title}"의 항목 ${count}개를 반영했습니다`)
        } catch (e) {
            alertError(String(e))
        }
    }

    let myId = $state<number | null>(null)
    let myIsAdmin = $state(false)
    onMount(async () => {
        try {
            const res = await fetch('/api/auth/whoami')
            if (res.ok) {
                const data = await res.json()
                myId = data.id
                myIsAdmin = !!data.isAdmin
            }
        } catch {}
    })

    let list = $state<SharedLorebookSummary[]>([])
    let loadingList = $state(true)
    let listError = $state('')

    async function refreshList() {
        try {
            list = await ns.listSharedLorebooks()
            listError = ''
        } catch (e) {
            listError = String(e)
        } finally {
            loadingList = false
        }
    }

    // Polling only runs while the list is visible — no point refreshing while
    // the user isn't looking, and it'd fight with an in-progress entry edit.
    let pollTimer: ReturnType<typeof setInterval> | null = null
    function startPolling() {
        stopPolling()
        pollTimer = setInterval(refreshList, 15000)
    }
    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
    }

    onMount(() => {
        refreshList()
        startPolling()
    })
    onDestroy(stopPolling)

    async function createNew() {
        const title = await alertInput('새 로어북 이름')
        if (!title) return
        const sel = parseInt(await alertSelect(['개인', '글로벌']))
        if (isNaN(sel)) return
        const scope: SharedLorebookScope = sel === 1 ? 'global' : 'private'
        try {
            const created = await ns.createSharedLorebook(title, [], scope)
            markSeen(created)
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    async function shareToGlobal(book: SharedLorebookSummary) {
        const ok = await alertConfirm(`"${book.title}"를 글로벌로 공유하면 모든 사용자가 보고 편집할 수 있게 됩니다. 계속할까요?`)
        if (!ok) return
        try {
            await ns.convertSharedLorebookToGlobal(book.id)
            invalidateExpanded(book.id)
            notifySuccess('글로벌로 공유했습니다')
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    async function cloneToPrivate(book: SharedLorebookSummary) {
        try {
            await ns.cloneSharedLorebook(book.id)
            notifySuccess('내 사본을 만들었습니다')
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    async function deleteBook(book: SharedLorebookSummary) {
        const ok = await alertConfirm(`"${book.title}"를 삭제하시겠습니까? 되돌릴 수 없습니다.`)
        if (!ok) return
        try {
            await ns.deleteSharedLorebook(book.id)
            invalidateExpanded(book.id)
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    function canDelete(book: SharedLorebookSummary): boolean {
        return book.scope === 'global' ? myIsAdmin : book.owner_id === myId
    }

    function canEditStructure(book: SharedLorebookSummary): boolean {
        return book.scope === 'global' || book.owner_id === myId
    }

    // ── Rename ───────────────────────────────────────────────────────────────
    let renamingId = $state<string | null>(null)
    let renameValue = $state('')

    function startRename(book: SharedLorebookSummary) {
        renamingId = book.id
        renameValue = book.title
    }

    async function commitRename() {
        if (!renamingId) return
        const id = renamingId
        renamingId = null
        const trimmed = renameValue.trim()
        if (!trimmed) return
        try {
            await ns.renameSharedLorebook(id, trimmed)
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    // ── Inline expand — books render as folders in the same list as the
    // character's own lore entries, so their contents are visible without
    // any lock/edit step first. Entries fetched lazily on first expand.
    let expanded = $state<Record<string, boolean>>({})
    let expandedDetail = $state<Record<string, SharedLorebookDetail>>({})
    let expandedLoading = $state<Record<string, boolean>>({})

    async function fetchDetail(id: string) {
        expandedLoading = { ...expandedLoading, [id]: true }
        try {
            const detail = await ns.getSharedLorebook(id)
            expandedDetail = { ...expandedDetail, [id]: detail }
        } catch (e) {
            alertError(String(e))
        } finally {
            expandedLoading = { ...expandedLoading, [id]: false }
        }
    }

    async function toggleExpand(book: SharedLorebookSummary) {
        if (expanded[book.id]) {
            expanded = { ...expanded, [book.id]: false }
            return
        }
        expanded = { ...expanded, [book.id]: true }
        if (!expandedDetail[book.id]) await fetchDetail(book.id)
    }

    // Drops the cached preview — used after actions where the row either
    // disappears (delete) or its content didn't change (scope-only changes).
    function invalidateExpanded(id: string) {
        const { [id]: _removed, ...rest } = expandedDetail
        expandedDetail = rest
    }

    // Refetches immediately if the row is currently expanded — used after
    // anything that changes a book's entries, so the preview never strands
    // the user looking at stale or empty content.
    async function refreshExpandedIfOpen(id: string) {
        invalidateExpanded(id)
        if (expanded[id]) await fetchDetail(id)
    }

    // ── Entry editing (per entry, not per book) ─────────────────────────────
    let editing = $state<{ bookId: string, entryId: string, scope: SharedLorebookScope } | null>(null)
    let editDraft = $state<loreBook | null>(null)
    let savingEntry = $state(false)

    let editTokens = $state(0)
    let tokenTimer: ReturnType<typeof setTimeout> | null = null
    let tokenSeq = 0
    $effect(() => {
        if (!editing || !editDraft) return
        const content = editDraft.content
        const seq = ++tokenSeq
        if (tokenTimer) clearTimeout(tokenTimer)
        tokenTimer = setTimeout(() => {
            tokenizeAccurate(content).then((result) => { if (seq === tokenSeq) editTokens = result })
        }, 400)
    })

    function isEditing(bookId: string, entryId: string): boolean {
        return !!editing && editing.bookId === bookId && editing.entryId === entryId
    }

    async function startEditEntry(book: SharedLorebookSummary, entry: loreBook) {
        if (!entry.id) return
        try {
            const local = await loadLorebookEntryDraftLocal(book.id, entry.id)
            if (book.scope === 'private') {
                editing = { bookId: book.id, entryId: entry.id, scope: 'private' }
                editDraft = local ?? { ...entry }
                return
            }
            const lockRes = await ns.lockSharedLorebookEntry(book.id, entry.id)
            editing = { bookId: book.id, entryId: entry.id, scope: 'global' }
            editDraft = local ?? lockRes.entry
            await refreshExpandedIfOpen(book.id) // pick up the lock badge
        } catch (e) {
            if (e instanceof SharedLorebookLockedError) {
                notifyError(`${e.lockedByUsername ?? '다른 사용자'}가 수정 중입니다`)
            } else {
                alertError(String(e))
            }
        }
    }

    let autosaveTimer: ReturnType<typeof setTimeout> | null = null
    $effect(() => {
        if (!editing || !editDraft) return
        const { bookId, entryId } = editing
        const snapshot = editDraft
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
            saveLorebookEntryDraftLocal(bookId, entryId, snapshot).catch(() => {})
        }, 500)
    })

    async function saveEntryEdit() {
        if (!editing || !editDraft) return
        const { bookId, entryId } = editing
        savingEntry = true
        try {
            await ns.saveSharedLorebookEntry(bookId, entryId, editDraft)
            await clearLorebookEntryDraftLocal(bookId, entryId)
            editing = null
            editDraft = null
            notifySuccess('저장했습니다')
            await refreshExpandedIfOpen(bookId)
            await refreshList()
        } catch (e) {
            alertError(String(e))
        } finally {
            savingEntry = false
        }
    }

    async function cancelEntryEdit() {
        if (!editing) return
        const { bookId, entryId, scope } = editing
        if (scope === 'global') {
            try {
                await ns.cancelSharedLorebookEntryLock(bookId, entryId)
            } catch (e) {
                // Lock already gone (expired / taken elsewhere) — still fine to leave edit mode.
            }
        }
        await clearLorebookEntryDraftLocal(bookId, entryId)
        editing = null
        editDraft = null
        await refreshExpandedIfOpen(bookId)
    }

    async function addEntry(book: SharedLorebookSummary) {
        try {
            const detail = await ns.addSharedLorebookEntry(book.id, {
                key: '',
                comment: `New Lore ${(expandedDetail[book.id]?.content.length ?? 0) + 1}`,
                content: '',
                mode: 'normal',
                insertorder: 100,
                alwaysActive: false,
                secondkey: '',
                selective: false,
            })
            expandedDetail = { ...expandedDetail, [book.id]: detail }
            expanded = { ...expanded, [book.id]: true }
            await refreshList()
            const newEntry = detail.content[detail.content.length - 1]
            await startEditEntry(book, newEntry) // jump straight into editing it, like the character lorebook's own "+"
        } catch (e) {
            alertError(String(e))
        }
    }

    async function deleteEntry(book: SharedLorebookSummary, entry: loreBook) {
        if (!entry.id) return
        const ok = await alertConfirm(`${language.removeConfirm}${entry.comment || entry.key || 'Unnamed Lore'}`)
        if (!ok) return
        try {
            const detail = await ns.deleteSharedLorebookEntry(book.id, entry.id)
            expandedDetail = { ...expandedDetail, [book.id]: detail }
            await refreshList()
        } catch (e: any) {
            const msg = String(e?.message ?? e)
            if (msg.includes('409')) {
                notifyError('다른 사용자가 편집 중이라 삭제할 수 없습니다')
            } else {
                alertError(msg)
            }
        }
    }

    // ── Version history / restore (global-only in this UI) ─────────────────
    let versionsFor = $state<string | null>(null)
    let versions = $state<SharedLorebookVersion[]>([])
    let loadingVersions = $state(false)

    async function openVersions(book: SharedLorebookSummary) {
        versionsFor = book.id
        loadingVersions = true
        try {
            versions = await ns.listSharedLorebookVersions(book.id)
        } catch (e) {
            alertError(String(e))
        } finally {
            loadingVersions = false
        }
    }

    async function restore(book: SharedLorebookSummary, versionId: string) {
        const ok = await alertConfirm('이 버전으로 되돌리시겠습니까? 현재 내용은 버전 기록에 보관됩니다.')
        if (!ok) return
        try {
            const updated = await ns.restoreSharedLorebookVersion(book.id, versionId)
            markSeen(updated)
            versionsFor = null
            invalidateExpanded(book.id)
            notifySuccess('복원했습니다')
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    // ── Per-viewer activation overrides (global only, no lock needed) ──────
    const OVERRIDE_LABELS: Record<SharedLorebookOverrideMode, string> = {
        always: '상시',
        trigger: '트리거',
        disabled: '비활성',
    }
    let viewingOverrides = $state<SharedLorebookDetail | null>(null)
    let overridesMap = $state<Record<string, SharedLorebookOverrideMode>>({})
    let savingOverrides = $state(false)

    async function openOverrides(book: SharedLorebookSummary) {
        try {
            const detail = await ns.getSharedLorebook(book.id)
            viewingOverrides = detail
            const map: Record<string, SharedLorebookOverrideMode> = {}
            for (const entry of detail.content) {
                if (entry.id) map[entry.id] = 'trigger'
            }
            for (const o of detail.overrides ?? []) {
                map[o.entry_id] = o.mode
            }
            overridesMap = map
        } catch (e) {
            alertError(String(e))
        }
    }

    function closeOverrides() {
        viewingOverrides = null
        overridesMap = {}
    }

    async function setOverrideMode(entryId: string, mode: SharedLorebookOverrideMode) {
        if (!viewingOverrides) return
        const prev = overridesMap[entryId]
        overridesMap = { ...overridesMap, [entryId]: mode }
        savingOverrides = true
        try {
            const payload = Object.entries(overridesMap).map(([entry_id, m]) => ({ entry_id, mode: m }))
            await ns.saveSharedLorebookOverrides(viewingOverrides.id, payload)
        } catch (e) {
            overridesMap = { ...overridesMap, [entryId]: prev }
            alertError(String(e))
        } finally {
            savingOverrides = false
        }
    }

    function formatTime(ts: number): string {
        return new Date(ts).toLocaleString('ko-KR')
    }

    function entryLabel(entry: loreBook): string {
        return entry.comment || entry.key || '(이름 없음)'
    }
</script>

{#snippet entryEditor(book: SharedLorebookSummary)}
    {#if editDraft}
        <div class="border-0 outline-hidden w-full mt-1 mb-2 flex flex-col pl-2">
            <span class="text-textcolor mt-2">{language.name}</span>
            <TextInput bind:value={editDraft.comment}/>
            {#if !editDraft.alwaysActive}
                <span class="text-textcolor mt-4">{language.activationKeys}</span>
                <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                <TextInput bind:value={editDraft.key}/>
            {/if}
            <span class="text-textcolor mt-4">{language.insertOrder}</span>
            <NumberInput bind:value={editDraft.insertorder} min={0} max={1000}/>
            <span class="text-textcolor mt-4 mb-2">{language.prompt}</span>
            <TextAreaInput highlight autocomplete="off" bind:value={editDraft.content}/>
            <span class="text-textcolor2 mt-2 mb-2 text-sm">{editTokens} {language.tokens}</span>
            <div class="flex items-center mt-2">
                <Check bind:check={editDraft.alwaysActive} name={language.alwaysActive}/>
            </div>
            <div class="flex items-center mt-2">
                <Check bind:check={editDraft.selective} name={language.selective}/>
            </div>
            <div class="flex justify-end gap-2 mt-4">
                <button class="px-3 py-1.5 rounded-md text-textcolor2 hover:text-textcolor cursor-pointer" onclick={cancelEntryEdit}>
                    취소
                </button>
                <button
                    class="px-3 py-1.5 rounded-md bg-primary text-textcolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={savingEntry}
                    onclick={saveEntryEdit}
                >
                    저장
                </button>
            </div>
        </div>
    {/if}
{/snippet}

{#snippet body()}
    {#if viewingOverrides}
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0 truncate">{viewingOverrides.title} · 내 활성화 설정</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={closeOverrides}>
                    <XIcon size={22}/>
                </button>
            </div>
        </div>
        <span class="text-textcolor2 text-sm mb-3">여기서 고른 모드는 나에게만 적용되고 다른 사람에게는 영향을 주지 않습니다.</span>
        <div class="flex flex-col gap-2 overflow-y-auto">
            {#if viewingOverrides.content.length === 0}
                <span class="text-textcolor2">항목이 없습니다</span>
            {:else}
                {#each viewingOverrides.content as entry (entry.id)}
                    {#if entry.mode !== 'folder' && entry.id}
                        <div class="flex items-center border border-selected rounded-md p-3 gap-3">
                            <div class="flex flex-col min-w-0 grow">
                                <span class="text-textcolor truncate">{entryLabel(entry)}</span>
                                <span class="text-textcolor2 text-xs truncate">{entry.key}</span>
                            </div>
                            <div class="flex border border-selected rounded-md overflow-hidden shrink-0">
                                {#each (['always', 'trigger', 'disabled'] as const) as mode}
                                    <button
                                        class="px-2 py-1 text-xs cursor-pointer"
                                        class:bg-selected={(overridesMap[entry.id] ?? 'trigger') === mode}
                                        class:text-textcolor={(overridesMap[entry.id] ?? 'trigger') === mode}
                                        class:text-textcolor2={(overridesMap[entry.id] ?? 'trigger') !== mode}
                                        disabled={savingOverrides}
                                        onclick={() => entry.id && setOverrideMode(entry.id, mode)}
                                    >
                                        {OVERRIDE_LABELS[mode]}
                                    </button>
                                {/each}
                            </div>
                        </div>
                    {/if}
                {/each}
            {/if}
        </div>
    {:else}
        <div class="flex items-center justify-end gap-1 mb-1">
            <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={refreshList} title="새로고침">
                <RefreshCwIcon size={16}/>
            </button>
            <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={createNew} title="새 공유 로어북">
                <PlusIcon size={18}/>
            </button>
            {#if !inline}
                <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={close}>
                    <XIcon size={20}/>
                </button>
            {/if}
        </div>

        <div class="flex flex-col overflow-y-auto">
            {#if loadingList}
                <span class="text-textcolor2 p-2">불러오는 중...</span>
            {:else if listError}
                <span class="text-red-400 p-2">{listError}</span>
            {:else if list.length === 0}
                <span class="text-textcolor2 p-2">아직 등록된 로어북이 없습니다</span>
            {:else}
                {#each list as book (book.id)}
                    <div>
                        <div
                            role="button"
                            tabindex="0"
                            class="flex items-center gap-1.5 p-2 rounded-md cursor-pointer text-textcolor hover:bg-darkbutton"
                            onclick={() => toggleExpand(book)}
                            onkeydown={(e) => { if (e.key === 'Enter') toggleExpand(book) }}
                        >
                            {#if expanded[book.id]}<ChevronDownIcon size={16} class="shrink-0"/>{:else}<ChevronRightIcon size={16} class="shrink-0"/>{/if}
                            <FolderIcon size={16} class="shrink-0"/>
                            {#if book.scope === 'global'}
                                <span class="text-xs px-1.5 py-0.5 rounded-full bg-blue-700/50 text-blue-200 flex items-center gap-1 shrink-0">
                                    <GlobeIcon size={12}/> 글로벌
                                </span>
                            {:else}
                                <span class="text-xs px-1.5 py-0.5 rounded-full bg-selected text-textcolor2 flex items-center gap-1 shrink-0">
                                    <LockKeyholeIcon size={12}/> 개인
                                </span>
                            {/if}
                            {#if renamingId === book.id}
                                <div class="grow flex items-center gap-1" role="presentation" onclick={(e) => e.stopPropagation()}>
                                    <TextInput bind:value={renameValue} padding={false} className="grow"
                                        onkeydown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') renamingId = null }}/>
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer shrink-0" onclick={commitRename}>
                                        <CheckIcon size={14}/>
                                    </button>
                                </div>
                            {:else}
                                <span class="grow truncate">{book.title || '(제목 없음)'}</span>
                            {/if}
                            {#if book.scope === 'global' && isUnseenBook(book)}
                                <span class="text-xs px-1.5 py-0.5 rounded-full bg-amber-700/60 text-amber-200 flex items-center gap-1 shrink-0">
                                    <SparklesIcon size={12}/> NEW
                                </span>
                            {:else if hasUnseenUpdate(book)}
                                <span class="text-xs px-1.5 py-0.5 rounded-full bg-green-700/60 text-green-200 flex items-center gap-1 shrink-0">
                                    <SparklesIcon size={12}/> 새 버전
                                </span>
                            {/if}
                            <div class="flex items-center gap-1 shrink-0" role="presentation" onclick={(e) => e.stopPropagation()}>
                                <button
                                    class="text-textcolor2 hover:text-primary p-1 cursor-pointer"
                                    onclick={() => importOrUpdate(book)}
                                    title={isImportedIntoCharacter(book) ? '캐릭터 로어북에 최신으로 업데이트' : '캐릭터 로어북으로 불러오기'}
                                >
                                    <DownloadIcon size={14}/>
                                </button>
                                {#if canEditStructure(book) && renamingId !== book.id}
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={() => startRename(book)} title="이름 변경">
                                        <PencilIcon size={14}/>
                                    </button>
                                {/if}
                                {#if book.scope === 'global'}
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={() => openVersions(book)} title="버전 기록">
                                        <HistoryIcon size={14}/>
                                    </button>
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={() => openOverrides(book)} title="내 활성화 설정">
                                        <SlidersHorizontalIcon size={14}/>
                                    </button>
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={() => cloneToPrivate(book)} title="내 사본 만들기">
                                        <CopyIcon size={14}/>
                                    </button>
                                {:else}
                                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={() => shareToGlobal(book)} title="글로벌로 공유">
                                        <GlobeIcon size={14}/>
                                    </button>
                                {/if}
                                {#if canDelete(book)}
                                    <button class="text-textcolor2 hover:text-red-400 p-1 cursor-pointer" onclick={() => deleteBook(book)} title="삭제">
                                        <TrashIcon size={14}/>
                                    </button>
                                {/if}
                            </div>
                        </div>

                        {#if versionsFor === book.id}
                            <div class="flex flex-col gap-2 mb-2 ml-6 border border-selected rounded-md p-3">
                                <div class="flex items-center">
                                    <span class="text-textcolor text-sm">최근 버전 (최대 3개)</span>
                                    <button class="ml-auto text-textcolor2 hover:text-primary cursor-pointer" onclick={() => { versionsFor = null }}>
                                        <XIcon size={14}/>
                                    </button>
                                </div>
                                {#if loadingVersions}
                                    <span class="text-textcolor2 text-sm">불러오는 중...</span>
                                {:else if versions.length === 0}
                                    <span class="text-textcolor2 text-sm">저장된 버전이 없습니다</span>
                                {:else}
                                    {#each versions as version (version.id)}
                                        <div class="flex items-center gap-2 text-sm">
                                            <span class="text-textcolor2 grow">
                                                {version.saved_by_username ?? '알 수 없음'} · {formatTime(version.saved_at)}
                                            </span>
                                            <button
                                                class="px-2 py-1 rounded-md bg-selected text-textcolor flex items-center gap-1 cursor-pointer shrink-0"
                                                onclick={() => restore(book, version.id)}
                                            >
                                                <RotateCcwIcon size={14}/> 복원
                                            </button>
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        {/if}

                        {#if expanded[book.id]}
                            <div class="flex flex-col" style="padding-left: 22px">
                                {#if expandedLoading[book.id]}
                                    <span class="text-textcolor2 text-sm p-2">불러오는 중...</span>
                                {:else if expandedDetail[book.id]}
                                    {@const detail = expandedDetail[book.id]}
                                    {@const entries = detail.content.filter((e) => e.mode !== 'folder')}
                                    {#if entries.length === 0}
                                        <span class="text-textcolor2 text-sm p-2">항목이 없습니다</span>
                                    {:else}
                                        {#each entries as entry (entry.id)}
                                            {@const lock = entry.id ? detail.locks?.[entry.id] : undefined}
                                            {@const lockedByOther = !!lock && lock.locked_by !== myId}
                                            {#if isEditing(book.id, entry.id ?? '')}
                                                {@render entryEditor(book)}
                                            {:else}
                                                <div class="flex items-center gap-1.5 p-2 rounded-md hover:bg-darkbutton">
                                                    <span class="grow truncate text-sm text-textcolor2">{entryLabel(entry)}</span>
                                                    {#if lock}
                                                        <span class="text-amber-400 shrink-0" title={lockedByOther ? `${lock.locked_by_username ?? '다른 사용자'}가 수정 중` : '내가 수정 중'}>
                                                            <LockIcon size={12}/>
                                                        </span>
                                                    {/if}
                                                    <button
                                                        class="text-textcolor2 hover:text-primary p-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                                                        disabled={lockedByOther}
                                                        onclick={() => startEditEntry(book, entry)}
                                                        title="수정"
                                                    >
                                                        <PencilIcon size={14}/>
                                                    </button>
                                                    {#if canEditStructure(book)}
                                                        <button
                                                            class="text-textcolor2 hover:text-red-400 p-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                                                            disabled={lockedByOther}
                                                            onclick={() => deleteEntry(book, entry)}
                                                            title="삭제"
                                                        >
                                                            <XIcon size={14}/>
                                                        </button>
                                                    {/if}
                                                </div>
                                            {/if}
                                        {/each}
                                    {/if}
                                    {#if canEditStructure(book)}
                                        <button class="flex items-center gap-1 text-textcolor2 hover:text-textcolor p-2 cursor-pointer w-fit" onclick={() => addEntry(book)}>
                                            <PlusIcon size={16}/>
                                        </button>
                                    {/if}
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
            {/if}
        </div>
    {/if}
{/snippet}

{#if inline}
    <div class="flex flex-col">
        {@render body()}
    </div>
{:else}
    <div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center">
        <div class="bg-darkbg p-4 rounded-md flex flex-col max-w-3xl w-full mx-4 max-h-[85vh]">
            {@render body()}
        </div>
    </div>
{/if}
