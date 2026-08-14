<script lang="ts">
    import { v4 } from "uuid";
    import { flip } from "svelte/animate";
    import { DownloadIcon, PencilIcon, HardDriveUploadIcon, SplitIcon, FolderPlusIcon, BookmarkCheckIcon, PackageIcon } from "@lucide/svelte";

    import type { character, Chat, ChatFolder } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { saveNewChatToServer, createChatFolder, updateChatMeta, updateChatFolder, reorderChats } from "src/ts/storage/chatStorage";
    import { DBState } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";

    import ChatTreeItem from "./ChatTreeItem.svelte";
    import MoveToFolderModal from "./MoveToFolderModal.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";

    import { exportAllChats, importChat } from "src/ts/characters";
    import { alertStore, notifyError } from "src/ts/alert";
    import { buildChatTree } from "src/ts/chatTree";

    import { bookmarkListOpen, openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import { changeChatTo, requestImmediateSave } from "src/ts/globalApi.svelte";

    interface Props {
        chara: character;
    }

    let { chara = $bindable() }: Props = $props();

    const tree = $derived(buildChatTree(chara))

    // Move-to-folder modal state, shared across every ChatTreeItem in the tree.
    let moveModalOpen = $state(false)
    let moveTarget: { kind: 'chat' | 'folder', id: string } | null = $state(null)

    function onMove(kind: 'chat' | 'folder', id: string) {
        moveTarget = { kind, id }
        moveModalOpen = true
    }

    async function handleMoveSelect(targetId: string | null) {
        const target = moveTarget
        moveTarget = null
        if (!target) return
        try {
            if (target.kind === 'chat') {
                const chat = chara.chats.find(c => c.id === target.id)
                if (!chat) return
                await updateChatMeta(chat.id, { folderId: targetId })
                chat.folderId = targetId
                chara.chats = chara.chats
            } else {
                const folder = chara.chatFolders.find(f => f.id === target.id)
                if (!folder) return
                await updateChatFolder(folder.id, { parentId: targetId })
                folder.parentId = targetId
                chara.chatFolders = chara.chatFolders
            }
        } catch (e) {
            notifyError('이동할 수 없습니다 (최대 깊이 제한을 확인하세요)')
        }
    }

    // ── Drag & drop ──────────────────────────────────────────────────────────
    // Plain (non-reactive) box threaded down through every ChatTreeItem so
    // dragover handlers can synchronously read what's currently being
    // dragged, mirroring Sidebar.svelte's `currentDrag` pattern.
    const dragState: { current: { kind: 'chat' | 'folder', id: string } | null } = { current: null }

    // Reactive mirror of dragState.current plus a human-readable description
    // of where the drop would land, shown as a status line above the tree.
    // Added because dropZone borders/rings alone left it unclear whether a
    // chat was landing inside a folder, being reordered next to a sibling, or
    // popping back out to the top level — the text spells it out explicitly.
    let isDragging = $state(false)
    let dragHoverLabel = $state('')

    // The id of whatever's currently being physically picked up — mirrors
    // dragState.current.id but reactively, purely so the dragged row itself
    // can dim (PC drag previously gave zero feedback that anything had
    // started; touch already had this via pointerDragActive, now both paths
    // share the same signal).
    let draggingId: string | null = $state(null)

    // Shared "what's currently hovered" state — the single source of truth
    // for per-row drop-zone highlighting (ChatTreeItem's `dropZone` is
    // derived from this instead of tracking it locally). Native `dragover`
    // and the touch pointer-drag hit-test both funnel through onHoverChange/
    // onHoverClear below, so both input paths drive the same highlight.
    let hoverTarget: { kind: 'chat' | 'folder', id: string, zone: 'before' | 'after' | 'into' } | null = $state(null)

    function onDragStart(kind: 'chat' | 'folder', id: string) {
        dragState.current = { kind, id }
        isDragging = true
        dragHoverLabel = ''
        draggingId = id
    }

    function onDragEnd() {
        dragState.current = null
        isDragging = false
        dragHoverLabel = ''
        hoverTarget = null
        dragOverRoot = false
        draggingId = null
    }

    function describeDrop(targetKind: 'chat' | 'folder', targetId: string, zone: 'before' | 'after' | 'into'): string {
        const dragging = dragState.current
        if (!dragging || !targetId) return ''
        const draggingLabel = dragging.kind === 'chat'
            ? (chara.chats.find(c => c.id === dragging.id)?.name ?? '채팅')
            : (chara.chatFolders.find(f => f.id === dragging.id)?.name ?? '폴더')

        if (targetKind === 'chat') {
            if (dragging.kind !== 'chat') return ''
            const target = chara.chats.find(c => c.id === targetId)
            if (!target) return ''
            const folder = target.folderId ? chara.chatFolders.find(f => f.id === target.folderId) : null
            const where = folder ? `"${folder.name}" 폴더` : '최상위'
            return `"${draggingLabel}" → ${where} · "${target.name}" ${zone === 'after' ? '아래' : '위'}`
        }

        const targetFolder = chara.chatFolders.find(f => f.id === targetId)
        if (!targetFolder) return ''

        if (dragging.kind === 'chat' || zone === 'into') {
            return `"${draggingLabel}" → "${targetFolder.name}" 폴더 안으로`
        }

        const where = targetFolder.parentId
            ? `"${chara.chatFolders.find(f => f.id === targetFolder.parentId)?.name ?? ''}" 폴더`
            : '최상위'
        return `"${draggingLabel}" → ${where} · "${targetFolder.name}" ${zone === 'after' ? '아래' : '위'}`
    }

    function onHoverChange(targetKind: 'chat' | 'folder', targetId: string, zone: 'before' | 'after' | 'into') {
        dragOverRoot = false
        hoverTarget = { kind: targetKind, id: targetId, zone }
        dragHoverLabel = describeDrop(targetKind, targetId, zone)
    }

    function onHoverClear() {
        hoverTarget = null
        dragOverRoot = false
        dragHoverLabel = ''
    }

    // Touch pointer-drag hit-testing — maps a screen coordinate to whatever
    // chat/folder row (or the root dropzone) is under it, using the same
    // 25/50/75% zone thresholds as the native dragover handlers in
    // ChatTreeItem. There's no native `dragover` event stream to piggyback
    // on for a manual pointer-events drag, so this re-derives the same
    // result from document.elementFromPoint instead.
    function resolveDropTargetAtPoint(x: number, y: number):
        { kind: 'chat' | 'folder', id: string, zone: 'before' | 'after' | 'into' } | { kind: 'root' } | null {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (!el) return null
        if (el.closest('[data-chat-tree-root-drop]')) return { kind: 'root' }
        const rowEl = el.closest('[data-chat-tree-row]') as HTMLElement | null
        if (!rowEl) return null
        const kind = rowEl.dataset.treeKind as 'chat' | 'folder' | undefined
        const id = rowEl.dataset.treeId
        const dragging = dragState.current
        if (!kind || !id || !dragging) return null
        const rect = rowEl.getBoundingClientRect()
        const relY = y - rect.top
        if (kind === 'chat') {
            if (dragging.kind !== 'chat') return null
            return { kind, id, zone: relY < rect.height / 2 ? 'before' : 'after' }
        }
        if (dragging.kind === 'chat') return { kind, id, zone: 'into' }
        if (relY < rect.height * 0.25) return { kind, id, zone: 'before' }
        if (relY > rect.height * 0.75) return { kind, id, zone: 'after' }
        return { kind, id, zone: 'into' }
    }

    function onPointerHoverRoot() {
        hoverTarget = null
        dragOverRoot = true
        onHoverRoot()
    }

    function isDescendantFolder(candidateId: string, ancestorId: string): boolean {
        let current = chara.chatFolders.find(f => f.id === candidateId)
        while (current?.parentId) {
            if (current.parentId === ancestorId) return true
            current = chara.chatFolders.find(f => f.id === current.parentId)
        }
        return false
    }

    function persistChatOrder(folderId: string | null) {
        const siblings = chara.chats.filter(c => (c.folderId ?? null) === folderId)
        const updates = siblings.map((c, i) => ({ id: c.id, position: i, folderId }))
        reorderChats(updates).catch(() => notifyError('순서를 저장하지 못했습니다'))
    }

    function moveChatToPosition(chatId: string, folderId: string | null, insertAt: (arr: Chat[]) => number) {
        const arr = chara.chats
        const fromIdx = arr.findIndex(c => c.id === chatId)
        if (fromIdx === -1) return
        const [item] = arr.splice(fromIdx, 1)
        item.folderId = folderId
        arr.splice(insertAt(arr), 0, item)
        chara.chats = arr
        void requestImmediateSave()
        persistChatOrder(folderId)
    }

    function persistFolderOrder(parentId: string | null) {
        const siblings = chara.chatFolders.filter(f => (f.parentId ?? null) === parentId)
        for (const f of siblings) {
            updateChatFolder(f.id, { parentId }).catch(() => {})
        }
    }

    function moveFolderToPosition(folderId: string, parentId: string | null, insertAt: (arr: ChatFolder[]) => number) {
        const arr = chara.chatFolders
        const fromIdx = arr.findIndex(f => f.id === folderId)
        if (fromIdx === -1) return
        const [item] = arr.splice(fromIdx, 1)
        item.parentId = parentId
        arr.splice(insertAt(arr), 0, item)
        chara.chatFolders = arr
    }

    async function onDropOn(targetKind: 'chat' | 'folder', targetId: string, zone: 'before' | 'after' | 'into') {
        const dragging = dragState.current
        dragState.current = null
        if (!dragging) return
        if (dragging.kind === targetKind && dragging.id === targetId) return

        if (targetKind === 'chat') {
            // Folders always render above chats — dropping a folder onto a
            // chat has no sensible position, so ignore it.
            if (dragging.kind !== 'chat') return
            const target = chara.chats.find(c => c.id === targetId)
            if (!target) return
            const folderId = target.folderId ?? null
            moveChatToPosition(dragging.id, folderId, (arr) => {
                let idx = arr.findIndex(c => c.id === targetId)
                if (zone === 'after') idx += 1
                return idx
            })
            return
        }

        // targetKind === 'folder'
        const targetFolder = chara.chatFolders.find(f => f.id === targetId)
        if (!targetFolder) return

        if (dragging.kind === 'chat') {
            // Chats can't reorder relative to a folder — any drop on a
            // folder row just moves the chat into it.
            moveChatToPosition(dragging.id, targetId, (arr) => {
                let insertAt = arr.length
                for (let i = arr.length - 1; i >= 0; i--) {
                    if ((arr[i].folderId ?? null) === targetId) { insertAt = i + 1; break }
                }
                return insertAt
            })
            return
        }

        // Dragging a folder onto/around another folder.
        if (isDescendantFolder(targetId, dragging.id)) {
            notifyError('폴더를 자기 자신의 하위로 옮길 수 없습니다')
            return
        }

        const newParentId = zone === 'into' ? targetId : (targetFolder.parentId ?? null)
        const draggingFolder = chara.chatFolders.find(f => f.id === dragging.id)
        const draggingHasChildren = chara.chatFolders.some(f => f.parentId === dragging.id)

        if (newParentId !== null) {
            const parentOfNewParent = chara.chatFolders.find(f => f.id === newParentId)
            if (parentOfNewParent?.parentId) {
                notifyError('이동할 수 없습니다 (최대 깊이 제한을 확인하세요)')
                return
            }
            if (draggingHasChildren) {
                notifyError('하위 폴더가 있는 폴더는 다른 폴더 안으로 이동할 수 없습니다')
                return
            }
        }

        if (newParentId !== (draggingFolder?.parentId ?? null)) {
            try {
                await updateChatFolder(dragging.id, { parentId: newParentId })
            } catch (e) {
                notifyError('이동할 수 없습니다 (최대 깊이 제한을 확인하세요)')
                return
            }
        }

        const insertAt = zone === 'into'
            ? (arr: ChatFolder[]) => {
                let idx = arr.length
                for (let i = arr.length - 1; i >= 0; i--) {
                    if ((arr[i].parentId ?? null) === targetId) { idx = i + 1; break }
                }
                return idx
            }
            : (arr: ChatFolder[]) => {
                let idx = arr.findIndex(f => f.id === targetId)
                if (zone === 'after') idx += 1
                return idx
            }

        moveFolderToPosition(dragging.id, newParentId, insertAt)
        persistFolderOrder(newParentId)
    }

    let dragOverRoot = $state(false)

    function onHoverRoot() {
        const dragging = dragState.current
        if (!dragging) { dragHoverLabel = ''; return }
        const draggingLabel = dragging.kind === 'chat'
            ? (chara.chats.find(c => c.id === dragging.id)?.name ?? '채팅')
            : (chara.chatFolders.find(f => f.id === dragging.id)?.name ?? '폴더')
        dragHoverLabel = `"${draggingLabel}" → 최상위로`
    }

    async function onDropRoot() {
        dragOverRoot = false
        const dragging = dragState.current
        dragState.current = null
        isDragging = false
        dragHoverLabel = ''
        if (!dragging) return

        if (dragging.kind === 'chat') {
            moveChatToPosition(dragging.id, null, (arr) => arr.length)
            return
        }

        const folder = chara.chatFolders.find(f => f.id === dragging.id)
        if (!folder) return
        if ((folder.parentId ?? null) !== null) {
            try {
                await updateChatFolder(dragging.id, { parentId: null })
            } catch (e) {
                notifyError('이동할 수 없습니다')
                return
            }
        }
        moveFolderToPosition(dragging.id, null, (arr) => arr.length)
        persistFolderOrder(null)
    }

    // ── Chat list / model-prompt-toggle panel resize ────────────────────────
    // Plain pointer-drag (not native HTML5 DnD, which is overkill for a
    // press-move-release gesture with no drop target) on a thin handle
    // between the two sections. Height is clamped so the list can't be
    // dragged down to nothing or up into an absurdly tall panel.
    const CHAT_LIST_MIN_HEIGHT = 120
    const CHAT_LIST_MAX_HEIGHT = 560
    let chatListHeight = $state(320)
    let resizingChatList = $state(false)
    let resizeStartY = 0
    let resizeStartHeight = 0

    function clampChatListHeight(h: number): number {
        return Math.min(CHAT_LIST_MAX_HEIGHT, Math.max(CHAT_LIST_MIN_HEIGHT, h))
    }

    function onResizeHandlePointerDown(e: PointerEvent) {
        resizingChatList = true
        resizeStartY = e.clientY
        resizeStartHeight = chatListHeight
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    }

    function onResizeHandlePointerMove(e: PointerEvent) {
        if (!resizingChatList) return
        chatListHeight = clampChatListHeight(resizeStartHeight + (e.clientY - resizeStartY))
    }

    function onResizeHandlePointerUp(e: PointerEvent) {
        resizingChatList = false
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
    }
</script>
<div class="flex flex-col w-full">
    <ShButton className="relative bottom-2 w-full" onclick={() => {
        const len = chara.chats.length
        let chats = chara.chats
        const newChat = {
            message:[] as any[], note:'', name:`New Chat ${len + 1}`, localLore:[] as any[], fmIndex: -1, id: v4(),
            ...newChatModelDefaults()
        }
        chats.unshift(newChat)
        chara.chats = chats
        changeChatTo(0)
        void requestImmediateSave()
        saveNewChatToServer(chara.chaId, 0, newChat.id, newChat as any).catch(() => {})
    }}>{language.newChat}</ShButton>

    <!-- Zero-height positioning anchor for the drag-hover banner below — it
         must never push the row list (native HTML5 DnD is spec'd to abort
         the in-progress drag if the source element's layout box moves
         between dragstart and the next dragover; mounting an in-flow banner
         here on `isDragging` shifted every row down a frame after dragstart
         and Chrome cancelled the drag before a single dragover could fire,
         which is invisible in devtools but shows up as "grab cursor, but
         nothing actually drags" — confirmed by logging dragstart/dragend
         timestamps + row rects: rows moved and dragend fired ~5ms later with
         zero dragover in between). Absolute-positioning the banner inside
         this zero-height wrapper keeps it visually in the same place without
         touching anything else's layout. -->
    <div class="relative">
        {#if isDragging}
            <!-- pointer-events-none: purely informational, must never be hit by
                 elementFromPoint — the touch drag path (resolveDropTargetAtPoint
                 above) hit-tests via document.elementFromPoint at the finger's
                 coordinates, and this banner sits (via z-10) visually on top of
                 the first row; without this it wins that hit-test and swallows
                 every drop aimed at the top of the list, silently no-op'ing
                 instead of reordering. -->
            <div class="absolute inset-x-0 top-1 z-10 text-xs text-center py-1 px-2 rounded-md bg-darkbutton text-textcolor2 truncate shadow-lg pointer-events-none">
                {dragHoverLabel || '이동할 위치 위로 드래그하세요'}
            </div>
        {/if}
    </div>
    <div class="flex flex-col mt-2 overflow-y-auto" style="height: {chatListHeight}px">
        {#each tree as node (node.kind === 'folder' ? node.folder.id : node.chat.id)}
            <div animate:flip={{ duration: 200 }}>
                <ChatTreeItem chara={chara} node={node} depth={0} onMove={onMove} dragState={dragState} draggingId={draggingId} onDragStart={onDragStart} onDragEnd={onDragEnd} onDropOn={onDropOn} onHoverChange={onHoverChange} onHoverClear={onHoverClear} hoverTarget={hoverTarget} resolveDropTargetAtPoint={resolveDropTargetAtPoint} onDropRoot={onDropRoot} onPointerHoverRoot={onPointerHoverRoot}/>
            </div>
        {/each}
        {#if isDragging}
            <div
                role="presentation"
                data-chat-tree-root-drop
                class={"flex items-center justify-center h-8 min-h-8 mx-1 mt-1 rounded-md border-2 border-dashed transition-colors text-xs " + (dragOverRoot ? "border-primary" : "border-textcolor2/30")}
                class:bg-selected={dragOverRoot}
                class:text-textcolor={dragOverRoot}
                class:text-textcolor2={!dragOverRoot}
                ondragover={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dragOverRoot = true; onHoverRoot() }}
                ondragleave={() => { dragOverRoot = false; onHoverClear() }}
                ondrop={(e) => { e.preventDefault(); void onDropRoot() }}
            >
                최상위로 이동
            </div>
        {/if}
    </div>

    <!-- Drag to resize the chat list vs. the model/prompt/toggle panel below.
         touch-none stops touch-scroll from hijacking the gesture; pointer
         capture (see onResizeHandlePointerDown) keeps move/up events routed
         here even once the finger/cursor leaves this thin strip. -->
    <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="채팅 목록 크기 조절"
        class="group flex items-center justify-center h-3 shrink-0 cursor-row-resize touch-none select-none"
        onpointerdown={onResizeHandlePointerDown}
        onpointermove={onResizeHandlePointerMove}
        onpointerup={onResizeHandlePointerUp}
        onpointercancel={onResizeHandlePointerUp}
    >
        <span
            class="w-8 h-1 rounded-full bg-textcolor2/30 group-hover:bg-primary transition-colors"
            class:bg-primary={resizingChatList}
        ></span>
    </div>

    <MoveToFolderModal
        bind:open={moveModalOpen}
        folders={chara.chatFolders ?? []}
        excludeFolderId={moveTarget?.kind === 'folder' ? moveTarget.id : undefined}
        onSelect={handleMoveSelect}
        onClose={() => { moveModalOpen = false; moveTarget = null }}
    />

    <div class="border-t border-selected mt-2">
        <div class="flex mt-2 ml-2 items-center">
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                exportAllChats()
            }}>
                <DownloadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                alertStore.set({
                  type: "branches",
                  msg: ""
                })
            }}>
                <SplitIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                $bookmarkListOpen = true;
            }}>
                <BookmarkCheckIcon size={18}/>
            </button>
            <button class="ml-auto text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={async () => {
                const length = (chara.chatFolders ?? []).length
                try {
                    const folder = await createChatFolder(chara.chaId, { name: `New Folder ${length + 1}` })
                    chara.chatFolders = [...(chara.chatFolders ?? []), folder]
                } catch (e) {
                    notifyError('폴더 생성에 실패했습니다')
                }
            }}>
                <FolderPlusIcon size={18}/>
            </button>
        </div>

        {#if DBState.db.characters[$selectedCharID]?.chaId !== '§playground' && !$chatDeselected}
            {#if DBState.db.showModelInSidebar}
                <ModelBind />
            {/if}
            {#if DBState.db.showPresetInSidebar}
                <PromptBind />
            {/if}
            {#if DBState.db.showPersonaInSidebar}
                <PersonaBind />
            {/if}
            <Toggles bind:chara={chara} noContainer />
            <ShButton className="w-full mt-2" onclick={() => {
                const char = DBState.db.characters[$selectedCharID]
                if (!char) return
                char.chats[char.chatPage].modules ??= []
                openModuleListStore.set(true)
            }}>
                <PackageIcon size={16} class="shrink-0" />
                <span class="truncate">{language.modules}</span>
            </ShButton>
        {/if}
    </div>
</div>
