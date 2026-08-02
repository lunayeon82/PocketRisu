<script lang="ts">
    import ShDialog from "../UI/GUI/ShDialog.svelte"
    import { FolderIcon, HouseIcon } from "@lucide/svelte"
    import type { ChatFolder } from "src/ts/storage/database.svelte"

    interface Props {
        open: boolean
        folders: ChatFolder[]
        /** Exclude this folder id and its direct children from the pick list — used when moving a folder itself, so it can't become its own descendant. */
        excludeFolderId?: string
        onSelect: (targetId: string | null) => void
        onClose: () => void
    }
    let { open = $bindable(), folders, excludeFolderId, onSelect, onClose }: Props = $props()

    const excludedIds = $derived.by(() => {
        if (!excludeFolderId) return new Set<string>()
        const ids = new Set<string>([excludeFolderId])
        for (const f of folders) {
            if ((f.parentId ?? null) === excludeFolderId) ids.add(f.id)
        }
        return ids
    })

    const rootFolders = $derived(folders.filter(f => !f.parentId && !excludedIds.has(f.id)))
    const childrenOf = (id: string) => folders.filter(f => f.parentId === id && !excludedIds.has(f.id))

    function pick(id: string | null) {
        onSelect(id)
        onClose()
    }
</script>

<ShDialog bind:open onOpenChange={(v) => { if (!v) onClose() }} tier="base" size="sm">
    {#snippet title()}폴더로 이동{/snippet}
    <div class="flex flex-col gap-1 max-h-96 overflow-y-auto">
        <button
            class="text-left px-3 py-2 rounded-md hover:bg-selected cursor-pointer flex items-center gap-2 text-textcolor"
            onclick={() => pick(null)}
        >
            <HouseIcon size={16}/> 최상위
        </button>
        {#each rootFolders as folder}
            <button
                class="text-left px-3 py-2 rounded-md hover:bg-selected cursor-pointer flex items-center gap-2 text-textcolor"
                onclick={() => pick(folder.id)}
            >
                <FolderIcon size={16}/> {folder.name}
            </button>
            {#each childrenOf(folder.id) as child}
                <button
                    class="text-left px-3 py-2 pl-8 rounded-md hover:bg-selected cursor-pointer flex items-center gap-2 text-textcolor"
                    onclick={() => pick(child.id)}
                >
                    <FolderIcon size={16}/> {child.name}
                </button>
            {/each}
        {/each}
        {#if rootFolders.length === 0}
            <div class="text-textcolor2 text-sm text-center py-4">이동할 수 있는 폴더가 없습니다</div>
        {/if}
    </div>
</ShDialog>
