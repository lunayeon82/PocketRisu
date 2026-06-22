<script lang="ts">
    import { v4 } from "uuid";
    import { PlusIcon } from "@lucide/svelte";
    import { DBState, selectedCharID, chatDeselected, ReloadGUIPointer } from "src/ts/stores.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { changeChatTo, requestImmediateSave } from "src/ts/globalApi.svelte";

    let chara = $derived(DBState.db.characters[$selectedCharID]);

    function addChat() {
        const len = chara.chats.length;
        let chats = chara.chats;
        const newChat = {
            message: [] as any[], note: '', name: `New Chat ${len + 1}`, localLore: [] as any[], fmIndex: -1, id: v4(),
            ...newChatModelDefaults()
        };
        chats.unshift(newChat);
        chara.chats = chats;
        changeChatTo(0);
        void requestImmediateSave();
        $ReloadGUIPointer += 1;
    }
</script>

{#if chara}
    <div class="flex items-center h-8 min-h-8 w-full bg-darkbg border-t border-selected overflow-x-auto text-xs select-none">
        {#each chara.chats as chat, i}
            <button
                class="flex items-center h-full px-3 border-r border-selected/50 whitespace-nowrap rounded-t-sm transition-colors"
                class:bg-bgcolor={i === chara.chatPage && !$chatDeselected}
                class:text-textcolor={i === chara.chatPage && !$chatDeselected}
                class:border-b-2={i === chara.chatPage && !$chatDeselected}
                class:border-b-[#1c7a43]={i === chara.chatPage && !$chatDeselected}
                class:text-textcolor2={!(i === chara.chatPage && !$chatDeselected)}
                class:hover:bg-selected={!(i === chara.chatPage && !$chatDeselected)}
                onclick={() => changeChatTo(i)}
            >
                {chat.name}
            </button>
        {/each}
        <button
            class="flex items-center justify-center h-full w-8 min-w-8 text-textcolor2 hover:bg-selected hover:text-textcolor transition-colors"
            onclick={addChat}
            aria-label="New chat"
        >
            <PlusIcon size={16} />
        </button>
    </div>
{/if}
