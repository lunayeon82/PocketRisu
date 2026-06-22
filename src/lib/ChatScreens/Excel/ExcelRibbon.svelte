<script lang="ts">
    import { DBState, selectedCharID, settingsOpen, CharEmotion, PlaygroundStore, OpenRealmStore, botMakerMode } from "src/ts/stores.svelte";
    import { HomeIcon, Settings, User2Icon, ShellIcon, WrenchIcon, UserCircleIcon, BotIcon, SlidersHorizontalIcon, ToggleLeftIcon, ChevronDownIcon, Table2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import PersonaBind from "../../SideBars/PersonaBind.svelte";
    import ModelBind from "../../SideBars/ModelBind.svelte";
    import PromptBind from "../../SideBars/PromptBind.svelte";
    import Toggles from "../../SideBars/Toggles.svelte";

    interface Props {
        openGrid: () => void;
        devTool: boolean;
        onToggleDevTool: () => void;
    }

    let { openGrid, devTool, onToggleDevTool }: Props = $props();

    let fileMenuOpen = $state(false);
    let openPanel: '' | 'persona' | 'model' | 'prompt' | 'toggles' = $state('');

    function reseter() {
        settingsOpen.set(false);
        CharEmotion.set({});
        fileMenuOpen = false;
        openPanel = '';
    }

    function togglePanel(name: typeof openPanel) {
        openPanel = openPanel === name ? '' : name;
    }

    let chara = $derived(DBState.db.characters[$selectedCharID]);
    let hasCharacter = $derived($selectedCharID >= 0 && chara?.chaId !== '§playground');

    const ribbonBtn = "flex flex-col items-center justify-center h-full px-3 gap-0.5 border-r border-gray-300 text-xs text-gray-700 hover:bg-gray-200 transition-colors";
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative w-full select-none text-sm">
    <!-- Title bar -->
    <div class="flex items-center gap-1.5 h-7 min-h-7 w-full bg-[#107c41] px-2 text-white">
        <Table2Icon size={14} />
        <span class="text-xs font-medium tracking-wide">PocketRisu</span>
    </div>

    <!-- Ribbon -->
    <div class="flex items-center h-10 min-h-10 w-full bg-[#f3f2f1] border-b border-gray-300">
        <button
            class="flex items-center gap-1.5 h-full px-3 bg-[#107c41] text-white font-semibold hover:bg-[#0e6e39] transition-colors shrink-0"
            onclick={() => { fileMenuOpen = !fileMenuOpen; openPanel = ''; }}
        >
            <span>{language.menu}</span>
            <ChevronDownIcon size={14} />
        </button>

        {#if hasCharacter}
            <div class="flex items-center h-full ml-1 overflow-x-auto">
                <button class={ribbonBtn} class:bg-green-100={openPanel === 'persona'} class:text-green-900={openPanel === 'persona'} onclick={() => togglePanel('persona')}>
                    <UserCircleIcon size={16} />
                    <span>{language.persona}</span>
                </button>
                <button class={ribbonBtn} class:bg-green-100={openPanel === 'model'} class:text-green-900={openPanel === 'model'} onclick={() => togglePanel('model')}>
                    <BotIcon size={16} />
                    <span>{language.model}</span>
                </button>
                <button class={ribbonBtn} class:bg-green-100={openPanel === 'prompt'} class:text-green-900={openPanel === 'prompt'} onclick={() => togglePanel('prompt')}>
                    <SlidersHorizontalIcon size={16} />
                    <span>{language.prompt}</span>
                </button>
                <button class={ribbonBtn} class:bg-green-100={openPanel === 'toggles'} class:text-green-900={openPanel === 'toggles'} onclick={() => togglePanel('toggles')}>
                    <ToggleLeftIcon size={16} />
                    <span>Toggles</span>
                </button>
                <button class={ribbonBtn} class:bg-green-100={$botMakerMode} class:text-green-900={$botMakerMode} onclick={() => { botMakerMode.set(!$botMakerMode); openPanel = ''; }}>
                    <User2Icon size={16} />
                    <span>{language.character}</span>
                </button>
                {#if DBState.db.enableDevTools}
                    <button class={ribbonBtn} class:bg-green-100={devTool} class:text-green-900={devTool} onclick={() => { onToggleDevTool(); openPanel = ''; }}>
                        <WrenchIcon size={16} />
                        <span>Dev</span>
                    </button>
                {/if}
            </div>
        {/if}
    </div>

    {#if fileMenuOpen}
        <div class="absolute top-full left-0 z-30 flex flex-col bg-white border border-gray-300 rounded-b-md shadow-lg min-w-44 py-1 text-gray-800">
            <button class="flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100" onclick={() => {
                reseter();
                selectedCharID.set(-1);
                PlaygroundStore.set(0);
                OpenRealmStore.set(false);
            }}>
                <HomeIcon size={16} /> {language.home}
            </button>
            <button class="flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100" onclick={() => {
                reseter();
                window.location.href = '/settings';
            }}>
                <Settings size={16} /> {language.settings}
            </button>
            <button class="flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100" onclick={() => {
                reseter();
                openGrid();
            }}>
                <User2Icon size={16} /> {language.character}
            </button>
            <button class="flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100" onclick={() => {
                reseter();
                selectedCharID.set(-1);
                PlaygroundStore.set(1);
            }}>
                <ShellIcon size={16} /> {language.playground.playground}
            </button>
        </div>
    {/if}

    {#if hasCharacter && openPanel}
        <div class="absolute top-full left-0 right-0 z-20 bg-bgcolor text-textcolor border-b border-gray-300 shadow-lg px-4 py-2 max-h-72 overflow-y-auto">
            {#if openPanel === 'persona'}
                <PersonaBind />
            {:else if openPanel === 'model'}
                <ModelBind />
            {:else if openPanel === 'prompt'}
                <PromptBind />
            {:else if openPanel === 'toggles'}
                <Toggles chara={chara} />
            {/if}
        </div>
    {/if}
</div>
