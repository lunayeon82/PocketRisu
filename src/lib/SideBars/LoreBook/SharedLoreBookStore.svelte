<script lang="ts">
    // Shared lorebook repository UI — pessimistic lock + personal copy, backed
    // by rl_lorebooks/rl_lorebook_versions/rl_lorebook_locks/rl_lorebook_drafts
    // (server/node/lorebookApi.cjs). Separate from character.globalLore.
    //
    // Two scopes:
    // - global: visible to everyone, edited under the lock/draft dance below,
    //   deletable only by admins. Per-viewer entry activation lives in
    //   rl_lorebook_overrides (see the override view further down) instead of
    //   the shared content's own alwaysActive/mode fields, so one person's
    //   "always active" choice can't leak into everyone else's chats.
    // - private: visible only to its owner, edited directly (no lock — a
    //   private lorebook has exactly one possible editor), deletable by the owner.
    import { XIcon, PlusIcon, LockIcon, HistoryIcon, RotateCcwIcon, RefreshCwIcon, SparklesIcon, GlobeIcon, LockKeyholeIcon, CopyIcon, TrashIcon, SlidersHorizontalIcon, ChevronRightIcon, ChevronDownIcon, FolderIcon, PencilIcon } from "@lucide/svelte";
    import {
        NodeStorage, SharedLorebookLockedError,
        type SharedLorebookSummary, type SharedLorebookDetail, type SharedLorebookVersion,
        type SharedLorebookOverrideMode, type SharedLorebookScope,
    } from "src/ts/storage/nodeStorage";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, alertInput, alertSelect, notifyError, notifySuccess } from "src/ts/alert";
    import { saveLorebookDraftLocal, loadLorebookDraftLocal, clearLorebookDraftLocal } from "src/ts/storage/lorebookDraftDb";
    import { onMount, onDestroy } from "svelte";

    interface Props {
        close?: () => void
        /** Render in the host's normal flow (no fixed backdrop/centering, no
         *  close button) — used when this is embedded as a tab in
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

    // Polling only runs while the list is visible — no point refreshing lock
    // state for a list the user isn't looking at, and it'd fight with the
    // in-progress edit below.
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

    // ── Inline expand — books render as folders in the same list as the
    // character's own lore entries, so their contents are visible without a
    // separate "수정" click first. Entries fetched lazily on first expand.
    let expanded = $state<Record<string, boolean>>({})
    let expandedDetail = $state<Record<string, SharedLorebookDetail>>({})
    let expandedLoading = $state<Record<string, boolean>>({})

    async function toggleExpand(book: SharedLorebookSummary) {
        if (expanded[book.id]) {
            expanded = { ...expanded, [book.id]: false }
            return
        }
        expanded = { ...expanded, [book.id]: true }
        if (expandedDetail[book.id]) return
        expandedLoading = { ...expandedLoading, [book.id]: true }
        try {
            const detail = await ns.getSharedLorebook(book.id)
            expandedDetail = { ...expandedDetail, [book.id]: detail }
        } catch (e) {
            alertError(String(e))
        } finally {
            expandedLoading = { ...expandedLoading, [book.id]: false }
        }
    }

    // Drops the cached preview — used after actions where the row either
    // disappears (delete) or its content didn't change (scope-only changes),
    // so a plain cache-clear is enough; the next manual expand refetches.
    function invalidateExpanded(id: string) {
        const { [id]: _removed, ...rest } = expandedDetail
        expandedDetail = rest
    }

    // Like invalidateExpanded, but also refetches immediately if the row is
    // currently expanded — used after save/restore, where leaving it expanded
    // with no content (loading=false, detail=undefined renders nothing) would
    // otherwise strand the user looking at an empty gap.
    async function refreshExpandedIfOpen(id: string) {
        invalidateExpanded(id)
        if (!expanded[id]) return
        expandedLoading = { ...expandedLoading, [id]: true }
        try {
            const detail = await ns.getSharedLorebook(id)
            expandedDetail = { ...expandedDetail, [id]: detail }
        } catch (e) {
            // Best-effort refresh — leave it collapsed-looking rather than erroring.
        } finally {
            expandedLoading = { ...expandedLoading, [id]: false }
        }
    }

    // ── Editing ──────────────────────────────────────────────────────────────
    let editing = $state<SharedLorebookDetail | null>(null)
    let draftContent = $state<loreBook[]>([])
    let draftTitle = $state('')
    let saving = $state(false)

    async function startEdit(book: SharedLorebookSummary) {
        try {
            if (book.scope === 'private') {
                // Single possible editor (the owner) — no lock, no server-side
                // draft, just edit the canonical content directly.
                const local = await loadLorebookDraftLocal(book.id)
                const detail = await ns.getSharedLorebook(book.id)
                editing = detail
                draftTitle = detail.title
                draftContent = local ?? detail.content
                markSeen(detail)
                stopPolling()
                return
            }
            // A locally-buffered draft (see lorebookDraftDb.ts) may hold edits
            // typed after the last lock/relock but never PUT back — prefer it
            // over the server-issued copy, which is only as fresh as the lock.
            const local = await loadLorebookDraftLocal(book.id)
            const lockRes = await ns.lockSharedLorebook(book.id)
            const detail = await ns.getSharedLorebook(book.id)
            editing = detail
            draftTitle = detail.title
            draftContent = local ?? lockRes.content
            markSeen(detail)
            stopPolling()
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
        if (!editing) return
        const id = editing.id
        const snapshot = draftContent
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
            saveLorebookDraftLocal(id, snapshot).catch(() => {})
        }, 500)
    })

    function exitEdit() {
        editing = null
        showVersions = false
        startPolling()
    }

    async function saveEdit() {
        if (!editing) return
        saving = true
        const id = editing.id
        try {
            const updated = await ns.saveSharedLorebook(id, draftContent, draftTitle)
            await clearLorebookDraftLocal(id)
            markSeen(updated)
            void refreshExpandedIfOpen(id)
            exitEdit()
            notifySuccess('저장했습니다')
            await refreshList()
        } catch (e) {
            alertError(String(e))
        } finally {
            saving = false
        }
    }

    async function cancelEdit() {
        if (!editing) return
        const id = editing.id
        if (editing.scope === 'global') {
            try {
                await ns.cancelSharedLorebookLock(id)
            } catch (e) {
                // Lock already gone (expired / taken elsewhere) — still fine to leave edit mode.
            }
        }
        await clearLorebookDraftLocal(id)
        exitEdit()
        await refreshList()
    }

    function addEntry() {
        draftContent = [...draftContent, {
            key: '',
            comment: `New Lore ${draftContent.length + 1}`,
            content: '',
            mode: 'normal',
            insertorder: 100,
            alwaysActive: false,
            secondkey: '',
            selective: false,
        }]
    }

    // ── Version history / restore (global-only in this UI) ─────────────────
    let showVersions = $state(false)
    let versions = $state<SharedLorebookVersion[]>([])
    let loadingVersions = $state(false)

    async function openVersions() {
        if (!editing) return
        loadingVersions = true
        showVersions = true
        try {
            versions = await ns.listSharedLorebookVersions(editing.id)
        } catch (e) {
            alertError(String(e))
        } finally {
            loadingVersions = false
        }
    }

    async function restore(versionId: string) {
        if (!editing) return
        const ok = await alertConfirm('이 버전으로 되돌리시겠습니까? 현재 내용은 버전 기록에 보관됩니다.')
        if (!ok) return
        const id = editing.id
        try {
            const updated = await ns.restoreSharedLorebookVersion(id, versionId)
            await clearLorebookDraftLocal(id)
            markSeen(updated)
            void refreshExpandedIfOpen(id)
            exitEdit()
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
</script>

{#snippet content()}
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
                                    <span class="text-textcolor truncate">{entry.comment || entry.key || '(이름 없음)'}</span>
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
        {:else if !editing}
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
                        {@const lockedByOther = !!book.lock && book.lock.locked_by !== myId}
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
                                <span class="grow truncate">{book.title || '(제목 없음)'}</span>
                                {#if hasUnseenUpdate(book)}
                                    <span class="text-xs px-1.5 py-0.5 rounded-full bg-green-700/60 text-green-200 flex items-center gap-1 shrink-0">
                                        <SparklesIcon size={12}/> 새 버전
                                    </span>
                                {/if}
                                {#if book.lock}
                                    <span
                                        class="text-amber-400 shrink-0"
                                        title={lockedByOther ? `${book.lock.locked_by_username ?? '다른 사용자'}가 수정 중` : '내가 수정 중 (이어서 편집 가능)'}
                                    >
                                        <LockIcon size={14}/>
                                    </span>
                                {/if}
                                <div class="flex items-center gap-1 shrink-0" role="presentation" onclick={(e) => e.stopPropagation()}>
                                    {#if book.scope === 'global'}
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
                            {#if expanded[book.id]}
                                <div class="flex flex-col" style="padding-left: 22px">
                                    {#if expandedLoading[book.id]}
                                        <span class="text-textcolor2 text-sm p-2">불러오는 중...</span>
                                    {:else if expandedDetail[book.id]}
                                        {@const entries = expandedDetail[book.id].content.filter((e) => e.mode !== 'folder')}
                                        {#if entries.length === 0}
                                            <div class="flex items-center gap-1.5 p-2">
                                                <span class="text-textcolor2 text-sm grow">항목이 없습니다</span>
                                                <button
                                                    class="text-textcolor2 hover:text-primary p-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                                                    disabled={lockedByOther}
                                                    onclick={() => startEdit(book)}
                                                    title="수정"
                                                >
                                                    <PencilIcon size={14}/>
                                                </button>
                                            </div>
                                        {:else}
                                            {#each entries as entry (entry.id)}
                                                <div class="flex items-center gap-1.5 p-2 rounded-md hover:bg-darkbutton">
                                                    <span class="grow truncate text-sm text-textcolor2">{entry.comment || entry.key || '(이름 없음)'}</span>
                                                    <button
                                                        class="text-textcolor2 hover:text-primary p-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                                                        disabled={lockedByOther}
                                                        onclick={() => startEdit(book)}
                                                        title="수정"
                                                    >
                                                        <PencilIcon size={14}/>
                                                    </button>
                                                </div>
                                            {/each}
                                        {/if}
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {:else}
            <div class="flex items-center text-textcolor mb-4 gap-2">
                <TextInput bind:value={draftTitle} placeholder="로어북 이름" fullwidth padding className="grow"/>
                {#if editing.scope === 'global'}
                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer shrink-0" onclick={openVersions} title="버전 기록">
                        <HistoryIcon size={20}/>
                    </button>
                {/if}
            </div>

            {#if showVersions}
                <div class="flex flex-col gap-2 mb-4 border border-selected rounded-md p-3">
                    <div class="flex items-center">
                        <span class="text-textcolor">최근 버전 (최대 3개)</span>
                        <button class="ml-auto text-textcolor2 hover:text-primary cursor-pointer" onclick={() => { showVersions = false }}>
                            <XIcon size={16}/>
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
                                    onclick={() => restore(version.id)}
                                >
                                    <RotateCcwIcon size={14}/> 이 버전으로 복원
                                </button>
                            </div>
                        {/each}
                    {/if}
                </div>
            {/if}

            <div class="overflow-y-auto grow">
                <LoreBookList bind:externalLoreBooks={draftContent}/>
            </div>

            <div class="text-textcolor2 mt-2 flex items-center">
                <button onclick={addEntry} class="hover:text-textcolor cursor-pointer">
                    <PlusIcon/>
                </button>
                <div class="grow"></div>
                <button
                    class="px-3 py-1.5 rounded-md text-textcolor2 hover:text-textcolor cursor-pointer mr-2"
                    onclick={cancelEdit}
                >
                    취소
                </button>
                <button
                    class="px-3 py-1.5 rounded-md bg-primary text-textcolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={saving}
                    onclick={saveEdit}
                >
                    저장
                </button>
            </div>
        {/if}
{/snippet}

{#if inline}
    <div class="flex flex-col">
        {@render content()}
    </div>
{:else}
    <div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center">
        <div class="bg-darkbg p-4 rounded-md flex flex-col max-w-3xl w-full mx-4 max-h-[85vh]">
            {@render content()}
        </div>
    </div>
{/if}
