<script lang="ts">
    import { v4 } from "uuid"
    import { ChevronRightIcon, ChevronDownIcon, FolderIcon, MoreVerticalIcon, PencilIcon, FolderInputIcon, TrashIcon, CopyIcon, DownloadIcon, PaletteIcon } from "@lucide/svelte"

    import type { character } from "src/ts/storage/database.svelte"
    import type { ChatTreeNode } from "src/ts/chatTree"
    import ShDropdownMenu from "../UI/GUI/ShDropdownMenu.svelte"
    import ShDropdownMenuTrigger from "../UI/GUI/ShDropdownMenuTrigger.svelte"
    import ShDropdownMenuContent from "../UI/GUI/ShDropdownMenuContent.svelte"
    import ShDropdownMenuItem from "../UI/GUI/ShDropdownMenuItem.svelte"
    import ShDropdownMenuSeparator from "../UI/GUI/ShDropdownMenuSeparator.svelte"
    import ShDialog from "../UI/GUI/ShDialog.svelte"
    import TextInput from "../UI/GUI/TextInput.svelte"
    import { chatDeselected } from "src/ts/stores.svelte"
    import { changeChatTo, createChatCopyName, requestImmediateSave } from "src/ts/globalApi.svelte"
    import { ensureChatHydrated, saveChatToServer, deleteChatFromServer, updateChatMeta, updateChatFolder, deleteChatFolder } from "src/ts/storage/chatStorage"
    import { alertConfirm, alertError, alertSelect, notifySuccess, notifyError } from "src/ts/alert"
    import { exportChat } from "src/ts/characters"
    import { language } from "src/lang"

    // Self-import for recursion — depth is bounded at 2 by the server, so this
    // never recurses more than one level deep.
    import ChatTreeItem from "./ChatTreeItem.svelte"

    interface Props {
        chara: character
        node: ChatTreeNode
        depth: number
        onMove: (kind: 'chat' | 'folder', id: string) => void
        dragState: { current: { kind: 'chat' | 'folder', id: string } | null }
        onDragStart: (kind: 'chat' | 'folder', id: string) => void
        onDragEnd: () => void
        onDropOn: (targetKind: 'chat' | 'folder', targetId: string, zone: 'before' | 'after' | 'into') => void
        onHoverChange: (targetKind: 'chat' | 'folder', targetId: string, zone: 'before' | 'after' | 'into') => void
        onHoverClear: () => void
    }
    let { chara = $bindable(), node, depth, onMove, dragState, onDragStart, onDragEnd, onDropOn, onHoverChange, onHoverClear }: Props = $props()

    // Native HTML5 drag & drop doesn't play well with touch scrolling — fall
    // back to the "이동" menu item on touch devices instead.
    const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

    // Renaming happens in a modal (ShDialog, portalled to <body>) instead of an
    // inline input inside the row. It used to be inline, but the row itself is
    // draggable=true — dragging across the input text (e.g. to select and
    // retype the name) got hijacked as an HTML5 row-drag instead of a text
    // selection. A portalled modal has no draggable ancestor, so that conflict
    // can't happen regardless of where the input lives on screen.
    let editingName = $state(false)
    let editValue = $state('')
    let dropZone: 'before' | 'after' | 'into' | null = $state(null)

    function handleDragStart(e: DragEvent) {
        if (isTouchDevice) { e.preventDefault(); return }
        e.dataTransfer?.setData('text/plain', '')
        onDragStart(node.kind, node.kind === 'folder' ? node.folder.id : node.chat.id)
    }

    // Always fires after handleDragStart, whether the drag ended in a drop or
    // was abandoned (dropped outside any valid target, Escape, etc.) — clears
    // state that dragleave/drop alone can't reliably reach in the abandoned case.
    function handleDragEnd() {
        dropZone = null
        onDragEnd()
    }

    function handleDragOverFolder(e: DragEvent) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const dragging = dragState.current
        if (!dragging) { dropZone = null; return }
        if (dragging.kind === 'chat') {
            dropZone = 'into'
            onHoverChange('folder', node.kind === 'folder' ? node.folder.id : '', 'into')
            return
        }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const y = e.clientY - rect.top
        if (y < rect.height * 0.25) dropZone = 'before'
        else if (y > rect.height * 0.75) dropZone = 'after'
        else dropZone = 'into'
        if (node.kind === 'folder') onHoverChange('folder', node.folder.id, dropZone)
    }

    function handleDropFolder(e: DragEvent) {
        e.preventDefault()
        const zone = dropZone ?? 'into'
        dropZone = null
        onHoverClear()
        if (node.kind === 'folder') onDropOn('folder', node.folder.id, zone)
    }

    function handleDragOverChat(e: DragEvent) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const dragging = dragState.current
        if (!dragging || dragging.kind !== 'chat') { dropZone = null; return }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const y = e.clientY - rect.top
        dropZone = y < rect.height / 2 ? 'before' : 'after'
        if (node.kind === 'chat') onHoverChange('chat', node.chat.id, dropZone)
    }

    function handleDropChat(e: DragEvent) {
        e.preventDefault()
        const zone = dropZone
        dropZone = null
        onHoverClear()
        if (!zone || node.kind !== 'chat') return
        onDropOn('chat', node.chat.id, zone)
    }

    function handleDragLeave() {
        dropZone = null
        onHoverClear()
    }

    function startRename(current: string) {
        editValue = current ?? ''
        editingName = true
    }

    function commitRename() {
        if (!editingName) return
        editingName = false
        const trimmed = editValue.trim()
        if (!trimmed) return
        if (node.kind === 'chat') {
            node.chat.name = trimmed
            void requestImmediateSave()
            updateChatMeta(node.chat.id, { title: trimmed }).catch(() => {})
        } else {
            node.folder.name = trimmed
            updateChatFolder(node.folder.id, { name: trimmed }).catch(() => {})
        }
    }

    function cancelRename() {
        editingName = false
    }

    function toggleFold() {
        if (node.kind !== 'folder') return
        node.folder.folded = !node.folder.folded
        updateChatFolder(node.folder.id, { folded: node.folder.folded }).catch(() => {})
    }

    async function changeFolderColor(folderId: string) {
        const sel = parseInt(await alertSelect([language.changeFolderColor, language.cancel]))
        if (sel !== 0) return
        const colors = ["red", "green", "blue", "yellow", "indigo", "purple", "pink", "default"]
        const colorSel = parseInt(await alertSelect(colors))
        const color = colors[colorSel]
        if (node.kind === 'folder') node.folder.color = color
        updateChatFolder(folderId, { color }).catch(() => {})
    }

    async function deleteFolder(folder: Extract<ChatTreeNode, { kind: 'folder' }>) {
        const confirmed = await alertConfirm(`${language.removeConfirm}${folder.folder.name}`)
        if (!confirmed) return
        try {
            await deleteChatFolder(folder.folder.id)
        } catch (e) {
            notifyError('폴더 삭제에 실패했습니다')
            return
        }
        // Server already promoted children to root + cleared chat.folderId in
        // the same transaction — mirror that locally instead of waiting for a reload.
        const deletedId = folder.folder.id
        chara.chatFolders = chara.chatFolders.filter(f => f.id !== deletedId)
        for (const f of chara.chatFolders) {
            if (f.parentId === deletedId) f.parentId = null
        }
        for (const c of chara.chats) {
            if (c.folderId === deletedId) c.folderId = null
        }
    }

    async function copyChat(chat: any) {
        const confirmed = await alertConfirm(`${language.copyChatConfirm}${chat.name}`)
        if (!confirmed) return
        const idx = chara.chats.indexOf(chat)
        if (chara.chats[idx]?._placeholder) {
            await ensureChatHydrated(chara.chats, idx, chara.chaId)
        }
        if (chara.chats[idx]?._placeholder) {
            alertError('Failed to load chat data.')
            return
        }
        const newChat = $state.snapshot(chara.chats[idx])
        newChat.name = createChatCopyName(newChat.name, 'Copy')
        newChat.id = v4()
        chara.chats.unshift(newChat)
        changeChatTo(0)
        chara.chats = chara.chats
        void requestImmediateSave()
        saveChatToServer(chara.chaId, 0, newChat.id, newChat as any).catch(() => {})
        notifySuccess(language.copyChatSuccess)
    }

    async function deleteChat(chat: any) {
        if (chara.chats.length === 1) {
            notifyError(language.errors.onlyOneChat)
            return
        }
        const confirmed = await alertConfirm(`${language.removeConfirm}${chat.name}`)
        if (!confirmed) return
        const idx = chara.chats.indexOf(chat)
        changeChatTo(0)
        chara.chats.splice(idx, 1)
        chara.chats = chara.chats
        void requestImmediateSave()
        deleteChatFromServer(chat.id).catch(() => {})
    }
</script>

{#snippet indentGuide()}
    {#if depth > 0}
        <!-- Vertical guide line marking folder membership — indentation alone
             (padding-left) reads as "slightly shifted text", not "belongs to
             the folder above it". The line makes that relationship explicit. -->
        <span class="self-stretch border-l-2 border-textcolor2/25 shrink-0" style="width: {depth * 20}px; margin-left: {(depth - 1) * 20 + 8}px"></span>
    {/if}
{/snippet}

{#if node.kind === 'folder'}
<div>
    <div
        role="button"
        tabindex="0"
        draggable={!isTouchDevice}
        class="flex items-center gap-1.5 p-2 rounded-md cursor-pointer text-textcolor hover:bg-darkbutton"
        class:bg-red-900={node.folder.color === 'red'}
        class:bg-yellow-900={node.folder.color === 'yellow'}
        class:bg-green-900={node.folder.color === 'green'}
        class:bg-blue-900={node.folder.color === 'blue'}
        class:bg-indigo-900={node.folder.color === 'indigo'}
        class:bg-purple-900={node.folder.color === 'purple'}
        class:bg-pink-900={node.folder.color === 'pink'}
        class:ring-2={dropZone === 'into'}
        class:ring-primary={dropZone === 'into'}
        class:bg-selected={dropZone === 'into'}
        class:border-t-4={dropZone === 'before'}
        class:border-b-4={dropZone === 'after'}
        class:border-primary={dropZone === 'before' || dropZone === 'after'}
        onclick={toggleFold}
        onkeydown={(e) => { if (e.key === 'Enter') toggleFold() }}
        ondblclick={(e) => { e.stopPropagation(); startRename(node.folder.name ?? '') }}
        ondragstart={handleDragStart}
        ondragend={handleDragEnd}
        ondragover={handleDragOverFolder}
        ondragleave={handleDragLeave}
        ondrop={handleDropFolder}
    >
        {@render indentGuide()}
        {#if node.folder.folded}<ChevronRightIcon size={16} class="shrink-0"/>{:else}<ChevronDownIcon size={16} class="shrink-0"/>{/if}
        <FolderIcon size={16} class="shrink-0"/>
        <span class="grow truncate">{node.folder.name}</span>
        <ShDropdownMenu>
            <ShDropdownMenuTrigger>
                {#snippet child({ props })}
                    <button {...props} class="text-textcolor2 hover:text-primary cursor-pointer" onclick={(e) => e.stopPropagation()}>
                        <MoreVerticalIcon size={16}/>
                    </button>
                {/snippet}
            </ShDropdownMenuTrigger>
            <ShDropdownMenuContent>
                <ShDropdownMenuItem onSelect={() => startRename(node.kind === 'folder' ? node.folder.name ?? '' : '')}>
                    <PencilIcon/><span>이름 변경</span>
                </ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => node.kind === 'folder' && onMove('folder', node.folder.id)}>
                    <FolderInputIcon/><span>이동</span>
                </ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => node.kind === 'folder' && changeFolderColor(node.folder.id)}>
                    <PaletteIcon/><span>{language.changeFolderColor}</span>
                </ShDropdownMenuItem>
                <ShDropdownMenuSeparator/>
                <ShDropdownMenuItem class="text-red-400" onSelect={() => node.kind === 'folder' && deleteFolder(node)}>
                    <TrashIcon/><span>삭제</span>
                </ShDropdownMenuItem>
            </ShDropdownMenuContent>
        </ShDropdownMenu>
    </div>
    {#if !node.folder.folded}
        {#each node.children as child (child.kind === 'folder' ? child.folder.id : child.chat.id)}
            <ChatTreeItem chara={chara} node={child} depth={depth + 1} onMove={onMove} dragState={dragState} onDragStart={onDragStart} onDragEnd={onDragEnd} onDropOn={onDropOn} onHoverChange={onHoverChange} onHoverClear={onHoverClear}/>
        {/each}
    {/if}
</div>
{:else}
<div
    role="button"
    tabindex="0"
    draggable={!isTouchDevice}
    class="flex items-center gap-1.5 p-2 rounded-md cursor-pointer text-textcolor hover:bg-darkbutton"
    class:bg-selected={node.index === chara.chatPage && !$chatDeselected}
    class:border-t-4={dropZone === 'before'}
    class:border-b-4={dropZone === 'after'}
    class:border-primary={dropZone === 'before' || dropZone === 'after'}
    onclick={() => changeChatTo(node.index)}
    onkeydown={(e) => { if (e.key === 'Enter') changeChatTo(node.index) }}
    ondblclick={(e) => { e.stopPropagation(); startRename(node.chat.name) }}
    ondragstart={handleDragStart}
    ondragend={handleDragEnd}
    ondragover={handleDragOverChat}
    ondragleave={handleDragLeave}
    ondrop={handleDropChat}
>
    {@render indentGuide()}
    <span class="grow truncate">{node.chat.name}</span>
    <ShDropdownMenu>
        <ShDropdownMenuTrigger>
            {#snippet child({ props })}
                <button {...props} class="text-textcolor2 hover:text-primary cursor-pointer" onclick={(e) => e.stopPropagation()}>
                    <MoreVerticalIcon size={16}/>
                </button>
            {/snippet}
        </ShDropdownMenuTrigger>
        <ShDropdownMenuContent>
            <ShDropdownMenuItem onSelect={() => startRename(node.kind === 'chat' ? node.chat.name : '')}>
                <PencilIcon/><span>이름 변경</span>
            </ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => node.kind === 'chat' && onMove('chat', node.chat.id)}>
                <FolderInputIcon/><span>이동</span>
            </ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => node.kind === 'chat' && copyChat(node.chat)}>
                <CopyIcon/><span>복사</span>
            </ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => node.kind === 'chat' && exportChat(node.index)}>
                <DownloadIcon/><span>내보내기</span>
            </ShDropdownMenuItem>
            <ShDropdownMenuSeparator/>
            <ShDropdownMenuItem class="text-red-400" onSelect={() => node.kind === 'chat' && deleteChat(node.chat)}>
                <TrashIcon/><span>삭제</span>
            </ShDropdownMenuItem>
        </ShDropdownMenuContent>
    </ShDropdownMenu>
</div>
{/if}

<ShDialog bind:open={editingName} tier="base" size="sm" closeOnEscape ariaLabel="이름 변경">
    {#snippet title()}이름 변경{/snippet}
    <TextInput
        bind:value={editValue}
        fullwidth
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } }}
    />
    {#snippet footer()}
        <button class="px-3 py-1.5 rounded-md text-textcolor2 hover:text-textcolor cursor-pointer" onclick={cancelRename}>취소</button>
        <button class="px-3 py-1.5 rounded-md bg-primary text-textcolor cursor-pointer" onclick={commitRename}>저장</button>
    {/snippet}
</ShDialog>
