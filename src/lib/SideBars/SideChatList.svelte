<script lang="ts">
    import { v4 } from "uuid";
    import { DownloadIcon, PencilIcon, HardDriveUploadIcon, SplitIcon, FolderPlusIcon, BookmarkCheckIcon, PackageIcon } from "@lucide/svelte";

    import type { character, Chat, ChatFolder } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { saveChatToServer, createChatFolder, updateChatMeta, updateChatFolder, reorderChats } from "src/ts/storage/chatStorage";
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

    function onDragStart(kind: 'chat' | 'folder', id: string) {
        dragState.current = { kind, id }
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

    async function onDropRoot() {
        const dragging = dragState.current
        dragState.current = null
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
        saveChatToServer(chara.chaId, 0, newChat.id, newChat as any).catch(() => {})
    }}>{language.newChat}</ShButton>

    <div class="flex flex-col mt-2 overflow-y-auto max-h-80">
        {#each tree as node (node.kind === 'folder' ? node.folder.id : node.chat.id)}
            <ChatTreeItem chara={chara} node={node} depth={0} onMove={onMove} dragState={dragState} onDragStart={onDragStart} onDropOn={onDropOn}/>
        {/each}
        <div
            role="presentation"
            class="h-3 min-h-3 mx-1 mt-1 rounded-md transition-colors"
            class:bg-selected={dragOverRoot}
            ondragover={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dragOverRoot = true }}
            ondragleave={() => { dragOverRoot = false }}
            ondrop={(e) => { e.preventDefault(); dragOverRoot = false; void onDropRoot() }}
        ></div>
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
