<script lang="ts">
    // Shared lorebook repository UI — pessimistic lock + personal copy, backed
    // by rl_lorebooks/rl_lorebook_versions/rl_lorebook_locks/rl_lorebook_drafts
    // (server/node/lorebookApi.cjs). Separate from character.globalLore; this
    // is a standalone store of lorebooks any account can check out, edit, and
    // save back for everyone else to see.
    import { XIcon, PlusIcon, LockIcon, HistoryIcon, RotateCcwIcon, RefreshCwIcon, SparklesIcon } from "@lucide/svelte";
    import {
        NodeStorage, SharedLorebookLockedError,
        type SharedLorebookSummary, type SharedLorebookDetail, type SharedLorebookVersion,
    } from "src/ts/storage/nodeStorage";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, alertInput, notifyError, notifySuccess } from "src/ts/alert";
    import { saveLorebookDraftLocal, loadLorebookDraftLocal, clearLorebookDraftLocal } from "src/ts/storage/lorebookDraftDb";
    import { onMount, onDestroy } from "svelte";

    interface Props { close?: () => void }
    let { close = () => {} }: Props = $props();

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
    onMount(async () => {
        try {
            const res = await fetch('/api/auth/whoami')
            if (res.ok) myId = (await res.json()).id
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
        try {
            const created = await ns.createSharedLorebook(title, [])
            markSeen(created)
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    // ── Editing ──────────────────────────────────────────────────────────────
    let editing = $state<SharedLorebookDetail | null>(null)
    let draftContent = $state<loreBook[]>([])
    let draftTitle = $state('')
    let saving = $state(false)

    async function startEdit(book: SharedLorebookSummary) {
        try {
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
        try {
            await ns.cancelSharedLorebookLock(id)
        } catch (e) {
            // Lock already gone (expired / taken elsewhere) — still fine to leave edit mode.
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

    // ── Version history / restore ───────────────────────────────────────────
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
            exitEdit()
            notifySuccess('복원했습니다')
            await refreshList()
        } catch (e) {
            alertError(String(e))
        }
    }

    function formatTime(ts: number): string {
        return new Date(ts).toLocaleString('ko-KR')
    }
</script>

<div class="fixed inset-0 z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 rounded-md flex flex-col max-w-3xl w-full mx-4 max-h-[85vh]">
        {#if !editing}
            <div class="flex items-center text-textcolor mb-4">
                <h2 class="mt-0 mb-0">공유 로어북 저장소</h2>
                <div class="grow flex justify-end items-center gap-1">
                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={refreshList} title="새로고침">
                        <RefreshCwIcon size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={createNew} title="새 로어북">
                        <PlusIcon size={20}/>
                    </button>
                    <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer" onclick={close}>
                        <XIcon size={22}/>
                    </button>
                </div>
            </div>

            <div class="flex flex-col gap-2 overflow-y-auto">
                {#if loadingList}
                    <span class="text-textcolor2">불러오는 중...</span>
                {:else if listError}
                    <span class="text-red-400">{listError}</span>
                {:else if list.length === 0}
                    <span class="text-textcolor2">아직 등록된 로어북이 없습니다</span>
                {:else}
                    {#each list as book (book.id)}
                        {@const lockedByOther = !!book.lock && book.lock.locked_by !== myId}
                        <div class="flex items-center border border-selected rounded-md p-3 gap-3">
                            <div class="flex flex-col min-w-0 grow">
                                <div class="flex items-center gap-2">
                                    <span class="text-textcolor truncate">{book.title || '(제목 없음)'}</span>
                                    {#if hasUnseenUpdate(book)}
                                        <span class="text-xs px-1.5 py-0.5 rounded-full bg-green-700/60 text-green-200 flex items-center gap-1 shrink-0">
                                            <SparklesIcon size={12}/> 새 버전 있음
                                        </span>
                                    {/if}
                                </div>
                                <span class="text-textcolor2 text-xs">
                                    {book.updated_by_username ?? '알 수 없음'} · {formatTime(book.updated_at)}
                                </span>
                                {#if book.lock}
                                    <span class="text-amber-400 text-xs flex items-center gap-1 mt-1">
                                        <LockIcon size={12}/>
                                        {lockedByOther ? `${book.lock.locked_by_username ?? '다른 사용자'}가 수정 중` : '내가 수정 중 (이어서 편집 가능)'}
                                    </span>
                                {/if}
                            </div>
                            <button
                                class="px-3 py-1.5 rounded-md bg-selected text-textcolor shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                disabled={lockedByOther}
                                onclick={() => startEdit(book)}
                            >
                                수정
                            </button>
                        </div>
                    {/each}
                {/if}
            </div>
        {:else}
            <div class="flex items-center text-textcolor mb-4 gap-2">
                <TextInput bind:value={draftTitle} placeholder="로어북 이름" fullwidth padding className="grow"/>
                <button class="text-textcolor2 hover:text-primary p-1 cursor-pointer shrink-0" onclick={openVersions} title="버전 기록">
                    <HistoryIcon size={20}/>
                </button>
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
    </div>
</div>
