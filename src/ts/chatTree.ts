import type { character, Chat, ChatFolder } from "./storage/database.svelte"

export type ChatTreeNode =
    | { kind: 'folder', folder: ChatFolder, children: ChatTreeNode[] }
    | { kind: 'chat', chat: Chat, index: number }

/**
 * Build a folders-on-top tree from the flat chatFolders (parentId) / chats
 * (folderId) arrays. Depth is bounded at 2 by the server (chatFolderApi.cjs),
 * so recursion here is naturally shallow.
 *
 * A chat whose folderId points at a folder that no longer exists is rescued
 * into the root level instead of becoming invisible — mirrors the old
 * isOrphanFolder safety net.
 */
export function buildChatTree(chara: character, parentId: string | null = null): ChatTreeNode[] {
    const validFolderIds = new Set((chara.chatFolders ?? []).map(f => f.id).filter(Boolean))

    const belongsHere = (folderId: string | null | undefined): boolean => {
        const fid = folderId ?? null
        if (fid === parentId) return true
        if (parentId === null && fid != null && !validFolderIds.has(fid)) return true
        return false
    }

    const folders: ChatTreeNode[] = (chara.chatFolders ?? [])
        .filter(f => (f.parentId ?? null) === parentId)
        .map(folder => ({
            kind: 'folder' as const,
            folder,
            children: buildChatTree(chara, folder.id),
        }))

    const chats: ChatTreeNode[] = []
    chara.chats.forEach((chat, index) => {
        if (belongsHere(chat.folderId)) chats.push({ kind: 'chat', chat, index })
    })

    return [...folders, ...chats]
}
