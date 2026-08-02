<script lang="ts">
    import { XIcon, LinkIcon, SunIcon, BanIcon, HistoryIcon, RotateCcwIcon, BookCopyIcon, FolderIcon, FolderOpen, PlusIcon, UploadIcon, SparklesIcon, PencilIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { language } from "../../../lang";
    import { getCurrentCharacter, getCurrentChat, type loreBook } from "../../../ts/storage/database.svelte";
    import { alertConfirm, alertMd, alertError, notifySuccess, notifyError } from "../../../ts/alert";
    import { NodeStorage, SharedLorebookLockedError, type SharedLorebookVersion } from "../../../ts/storage/nodeStorage";
    import { checkUploadTarget, uploadEntryToSharedLorebook, syncEntriesFromSharedLorebook, linkedBookIndex } from "../../../ts/process/sharedLorebookLink.svelte";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import Help from "../../Others/Help.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import { DBState } from "src/ts/stores.svelte";
    import LoreBookList from "./LoreBookList.svelte";

    interface Props {
        value: loreBook;
        onRemove?: () => void;
        onClose?: (isDetail?: boolean) => void;
        onOpen?: (isDetail?: boolean) => void;
        idx: number;
        externalLoreBooks?: loreBook[];
        idgroup: string;
        isOpen?: boolean;
        openFolders?: number;
        isLastInContainer?: boolean;
    }

    let {
        value = $bindable(),
        onRemove = () => {},
        onClose = (isDetail = true) => {},
        onOpen = (isDetail = true) => {},
        idx,
        externalLoreBooks = $bindable(),
        idgroup,
        isOpen = false,
        openFolders = 0,
        isLastInContainer = false
    }: Props = $props();
    
    let open = $derived(isOpen)

    // Shared entries can't be typed into directly — the fields below are
    // read-only until "수정" acquires the server-side lock. editDraft is the
    // locked personal copy being edited; contentTarget is whichever object
    // the form fields should actually bind to right now.
    let editingShared = $state(false)
    let editDraft = $state<loreBook | null>(null)
    let savingSharedEdit = $state(false)
    let contentTarget = $derived(editingShared && editDraft ? editDraft : value)
    let locked = $derived(!!value.source_lorebook_id && !editingShared)

    let tokens = $state(0)
    let tokenTimer: ReturnType<typeof setTimeout> | null = null
    let tokenSeq = 0
    // Re-count tokens on a debounce instead of on every content change — the
    // tokenizer runs a full CBS parse + encode, which is too heavy to do live.
    // Only when this entry is open: the token count UI renders only while open,
    // so closed entries (a big lorebook can have hundreds) must not tokenize.
    // The generation is bumped here (on content change), not in the timer, so an
    // in-flight tokenize is invalidated the moment the input changes — not only
    // once the next debounce fires 400ms later.
    $effect(() => {
        if (!open) return
        const content = contentTarget.content
        const seq = ++tokenSeq
        if (tokenTimer) clearTimeout(tokenTimer)
        tokenTimer = setTimeout(() => {
            tokenizeAccurate(content).then(result => { if (seq === tokenSeq) tokens = result })
        }, 400)
        return () => { if (tokenTimer) clearTimeout(tokenTimer) }
    })

    function isLocallyActivated(book: loreBook){
        return book.id ? getCurrentChat()?.localLore.some(e => e.id === book.id) : false
    }
    function activateLocally(book: loreBook){
        if(!book.id){
            book.id = v4()
        }
        
        const childLore: loreBook = {
            key: '',
            comment: '',
            content: '',
            mode: 'child',
            insertorder: 100,
            alwaysActive: true,
            secondkey: '',
            selective: false,
            id: book.id,
        }
        getCurrentChat().localLore.push(childLore)
    }
    function deactivateLocally(book: loreBook){
        if(!book.id) return
        const chat = getCurrentChat()
        const childLore = chat?.localLore?.find(e => e.id === book.id)
        if(childLore){
            chat.localLore = chat.localLore.filter(e => e.id !== book.id)
        }
    }
    function toggleLocalActive(check: boolean, book: loreBook){
        if(check){
            activateLocally(book)
        }else{
            deactivateLocally(book)
        }
    }
    function getParentLoreName(book: loreBook){
        if(book.mode === 'child'){
            const value = getCurrentCharacter()?.globalLore.find(e => e.id === book.id)
            if(value){
                return value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment
            }
        }
    }

    function hasSharedUpdate(book: loreBook): boolean {
        if(!book.source_lorebook_id) return false
        const linked = linkedBookIndex[book.source_lorebook_id]
        return !!linked && linked.updated_at > (book.source_updated_at ?? 0)
    }

    async function uploadEntry(book: loreBook){
        const existing = await checkUploadTarget(book)
        const ok = await alertConfirm(existing
            ? `기존 공유 로어북 "${existing.title}"을 덮어씁니다. 계속할까요?`
            : '새 공유 로어북으로 등록됩니다. 계속할까요?')
        if(!ok) return
        try {
            await uploadEntryToSharedLorebook(book, existing)
            notifySuccess('공유 로어북에 업로드했습니다')
        } catch(e){
            if(e instanceof SharedLorebookLockedError){
                notifyError(`${e.lockedByUsername ?? '다른 사용자'}가 수정 중입니다`)
            } else {
                alertError(String(e))
            }
        }
    }

    async function syncFromShared(book: loreBook){
        if(!book.source_lorebook_id) return
        try {
            await syncEntriesFromSharedLorebook(getCurrentCharacter(), book.source_lorebook_id)
            notifySuccess('최신 버전으로 업데이트했습니다')
        } catch(e){
            alertError(String(e))
        }
    }

    // Three-way activation: alwaysActive/disabled are two independent booleans
    // on loreBook, but only three combinations are meaningful — disabled wins
    // over alwaysActive if both were ever somehow set.
    type ActivationMode = 'always'|'trigger'|'disabled'
    function getActivationMode(book: loreBook): ActivationMode {
        if(book.disabled) return 'disabled'
        return book.alwaysActive ? 'always' : 'trigger'
    }
    function setActivationMode(book: loreBook, mode: ActivationMode){
        book.disabled = mode === 'disabled'
        book.alwaysActive = mode === 'always'
    }
    function cycleActivationMode(book: loreBook){
        const order: ActivationMode[] = ['trigger', 'always', 'disabled']
        const next = order[(order.indexOf(getActivationMode(book)) + 1) % order.length]
        setActivationMode(book, next)
    }

    const ns = new NodeStorage()
    let showVersions = $state(false)
    let versions = $state<SharedLorebookVersion[]>([])
    let loadingVersions = $state(false)

    async function openVersions(book: loreBook){
        if(!book.source_lorebook_id) return
        showVersions = true
        loadingVersions = true
        try {
            versions = await ns.listSharedLorebookVersions(book.source_lorebook_id)
        } catch(e){
            alertError(String(e))
        } finally {
            loadingVersions = false
        }
    }

    async function restoreVersion(book: loreBook, versionId: string){
        if(!book.source_lorebook_id) return
        const ok = await alertConfirm('이 버전으로 되돌리시겠습니까? 현재 공유 로어북 내용은 버전 기록에 보관됩니다.')
        if(!ok) return
        try {
            await ns.restoreSharedLorebookVersion(book.source_lorebook_id, versionId)
            await syncEntriesFromSharedLorebook(getCurrentCharacter(), book.source_lorebook_id)
            showVersions = false
            notifySuccess('복원했습니다')
        } catch(e){
            alertError(String(e))
        }
    }

    function formatVersionTime(ts: number): string {
        return new Date(ts).toLocaleString('ko-KR')
    }

    // Shared entries are read-only until this acquires the server-side lock —
    // mirrors the old SharedLoreBookStore edit flow, just scoped to the
    // character's own entry instead of a separate browsable list.
    async function startEditShared(book: loreBook){
        if(!book.source_lorebook_id || !book.id) return
        showVersions = false
        try {
            const lockRes = await ns.lockSharedLorebookEntry(book.source_lorebook_id, book.id)
            editDraft = lockRes.entry
            editingShared = true
            if(!open){
                open = true
                onOpen(true)
            }
        } catch(e){
            if(e instanceof SharedLorebookLockedError){
                notifyError(`${e.lockedByUsername ?? '다른 사용자'}가 수정 중입니다`)
            } else {
                alertError(String(e))
            }
        }
    }

    async function saveSharedEdit(book: loreBook){
        if(!book.source_lorebook_id || !book.id || !editDraft) return
        savingSharedEdit = true
        try {
            const detail = await ns.saveSharedLorebookEntry(book.source_lorebook_id, book.id, editDraft)
            const saved = detail.content.find(e => e.id === book.id) ?? editDraft
            // Content fields only — alwaysActive/disabled are personal and stay untouched.
            book.comment = saved.comment
            book.key = saved.key
            book.secondkey = saved.secondkey
            book.content = saved.content
            book.insertorder = saved.insertorder
            book.selective = saved.selective
            book.useRegex = saved.useRegex
            book.activationPercent = saved.activationPercent
            book.source_updated_at = detail.updated_at
            editingShared = false
            editDraft = null
            notifySuccess('공유 로어북에 저장했습니다')
        } catch(e){
            alertError(String(e))
        } finally {
            savingSharedEdit = false
        }
    }

    async function cancelSharedEdit(book: loreBook){
        if(book.source_lorebook_id && book.id){
            try {
                await ns.cancelSharedLorebookEntryLock(book.source_lorebook_id, book.id)
            } catch(e){
                // Lock already gone (expired / taken elsewhere) — still fine to leave edit mode.
            }
        }
        editingShared = false
        editDraft = null
    }

</script>
<div class={"w-full flex flex-col " + (
    isLastInContainer ? 
        'pb-0 mb-0 border-0' : // Last item in container: no border
        'pb-2 mb-2 border-b border-b-selected last:pb-0 last:mb-0 last:border-0'
)}
    class:no-sort={value.mode === 'folder' && openFolders > 0}
    data-risu-idx={idx} data-risu-idgroup={idgroup}
>
    <div class="flex items-center transition-colors w-full p-1">

    {#if value.mode !== 'child'}
        <button class="endflex valuer border-darkborderc flex items-center" onclick={() => {
            value.secondkey = value.secondkey ?? ''
            if(!open){
                open = true
                onOpen(value.mode !== 'folder') // If not a folder, pass true
            }
            else{
                open = false
                onClose(value.mode !== 'folder') // If not a folder, pass true
            }
        }}>
            {#if value.mode === 'folder'}
                {#if open}
                    <FolderOpen size={20} class="mr-1" />
                {:else}
                    <FolderIcon size={20} class="mr-1" />
                {/if}
            {/if}
            {#if value.mode === 'folder'}
                <span>{value.comment.length === 0 ? "Unnamed Folder" : value.comment}</span>
            {:else}
                <span>{value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment}</span>
                {#if value.source_lorebook_id}
                    <span class="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-700/50 text-blue-200 shrink-0">공유</span>
                {/if}
            {/if}
        </button>
        {#if value.mode === 'folder'}
            <button
                class="mr-1"
                class:text-textcolor2={!value.alwaysActive}
                class:text-textcolor={value.alwaysActive}
                onclick={async () => {
                    for(let i = 0; i < externalLoreBooks.length; i++){
                        if(externalLoreBooks[i].folder === value.key){
                            externalLoreBooks[i].alwaysActive = !value.alwaysActive
                        }
                    }
                    value.alwaysActive = !value.alwaysActive
                }}
            >
                {#if value.alwaysActive}
                    <SunIcon size={20} />
                {:else}
                    <LinkIcon size={20} />
                {/if}
            </button>
        {:else}
            <button
                class="mr-1"
                class:text-textcolor2={getActivationMode(value) !== 'always'}
                class:text-textcolor={getActivationMode(value) === 'always'}
                title={getActivationMode(value) === 'always' ? '상시 활성화' : getActivationMode(value) === 'trigger' ? '키워드 트리거' : '비활성화'}
                onclick={() => cycleActivationMode(value)}
            >
                {#if getActivationMode(value) === 'always'}
                    <SunIcon size={20} />
                {:else if getActivationMode(value) === 'trigger'}
                    <LinkIcon size={20} />
                {:else}
                    <BanIcon size={20} />
                {/if}
            </button>
            {#if hasSharedUpdate(value)}
                <button class="mr-1 text-green-400 hover:text-green-300" title="공유 로어북에 새 버전이 있습니다 — 최신으로 교체" onclick={() => syncFromShared(value)}>
                    <SparklesIcon size={20} />
                </button>
            {/if}
            {#if value.source_lorebook_id}
                <button class="mr-1 valuer" title="버전 기록" onclick={() => openVersions(value)}>
                    <HistoryIcon size={20} />
                </button>
                {#if editingShared}
                    <button class="mr-1 text-amber-400" title="편집 중 — 잠금 보유">
                        <PencilIcon size={20} />
                    </button>
                {:else}
                    <button class="mr-1 valuer" title="수정" onclick={() => startEditShared(value)}>
                        <PencilIcon size={20} />
                    </button>
                {/if}
            {:else}
                <button class="mr-1 valuer" title="공유 로어북에 업로드" onclick={() => uploadEntry(value)}>
                    <UploadIcon size={20} />
                </button>
            {/if}
        {/if}
        <button class="valuer" onclick={async () => {
            let shouldRemove = true;
            if (value.mode === 'folder' && externalLoreBooks.some(e => e.folder === value.key)) {
                const firstConfirm = await alertConfirm(language.folderRemoveConfirm);
                if (!firstConfirm) {
                    shouldRemove = false;
                }
            }

            if (shouldRemove) {
                const secondConfirm = await alertConfirm(language.removeConfirm + (value.comment || 'Unnamed Folder'));
                if (secondConfirm) {
                    if (!open) {
                        onClose();
                    }
                    deactivateLocally(value);
                    onRemove();
                }
            }
        }}>
            <XIcon size={20} />
        </button>
    {:else}
        <button class="endflex valuer border-darkborderc" onclick={() => alertMd(language.childLoreDesc)}>
            <BookCopyIcon size={20} class="mr-1" />
            <span>{getParentLoreName(value)}</span>
        </button>
        <button class="valuer" onclick={async () => {
            const d = await alertConfirm(language.removeConfirm + getParentLoreName(value))
            if(d){
                if(!open){
                    onClose()
                }
                onRemove()
            }
        }}>
            <XIcon size={20} />
        </button>
    {/if}
    </div>
    {#if showVersions}
        <div class="flex flex-col gap-2 mb-2 ml-6 border border-selected rounded-md p-3">
            <div class="flex items-center">
                <span class="text-textcolor text-sm">최근 버전 (최대 3개)</span>
                <button class="ml-auto text-textcolor2 hover:text-primary cursor-pointer" onclick={() => { showVersions = false }}>
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
                            {version.saved_by_username ?? '알 수 없음'} · {formatVersionTime(version.saved_at)}
                        </span>
                        <button
                            class="px-2 py-1 rounded-md bg-selected text-textcolor flex items-center gap-1 cursor-pointer shrink-0"
                            onclick={() => restoreVersion(value, version.id)}
                        >
                            <RotateCcwIcon size={14}/> 복원
                        </button>
                    </div>
                {/each}
            {/if}
        </div>
    {/if}
    {#if open}
        {#if value.mode === 'folder'}
        <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
            <span class="text-textcolor mt-6 mb-2">{language.folderName}</span>
            <TextInput bind:value={value.comment}/>

            <div class="mt-4">
                <LoreBookList externalLoreBooks={externalLoreBooks} showFolder={value.key} />
            </div>
            
            <div class="mt-2 flex gap-1">
                <button class="text-textcolor2 hover:text-textcolor" onclick={() => {
                    externalLoreBooks.push({
                        key: '',
                        comment: '',
                        content: '',
                        mode: 'normal',
                        insertorder: 100,
                        alwaysActive: true,
                        secondkey: '',
                        selective: false,
                        folder: value.key,
                    })
                }}>
                    <PlusIcon size={20} />
                </button>
            </div>
        </div>
        {:else}
        <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
            {#if value.source_lorebook_id}
                <span class="text-xs text-textcolor2 mt-2">
                    {editingShared ? '편집 중 — 저장하거나 취소할 때까지 잠금이 유지됩니다' : '공유 로어북에 연결된 항목입니다 — 수정하려면 잠금을 먼저 획득하세요'}
                </span>
            {/if}
            <span class="text-textcolor mt-6">{language.name} <Help key="loreName"/></span>
            <TextInput bind:value={contentTarget.comment} disabled={locked}/>
            {#if getActivationMode(value) === 'trigger'}
                <span class="text-textcolor mt-6">{language.activationKeys} <Help key="loreActivationKey"/></span>
                <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                <TextInput bind:value={contentTarget.key} disabled={locked}/>

                {#if contentTarget.selective}
                    <span class="text-textcolor mt-6">{language.SecondaryKeys}</span>
                    <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                    <TextInput bind:value={contentTarget.secondkey} disabled={locked}/>
                {/if}
            {/if}
            {#if !(contentTarget.activationPercent === undefined || contentTarget.activationPercent === null)}
                <span class="text-textcolor mt-6">{language.activationProbability}</span>
                <NumberInput bind:value={contentTarget.activationPercent} disabled={locked} onChange={() => {
                    if(isNaN(contentTarget.activationPercent) || !contentTarget.activationPercent || contentTarget.activationPercent < 0){
                        contentTarget.activationPercent = 0
                    }
                    if(contentTarget.activationPercent > 100){
                        contentTarget.activationPercent = 100
                    }
                }} />
            {/if}
            <span class="text-textcolor mt-4">{language.insertOrder} <Help key="loreorder"/></span>
            <NumberInput bind:value={contentTarget.insertorder} min={0} max={1000} disabled={locked}/>
            <span class="text-textcolor mt-4 mb-2">{language.prompt}</span>
            <TextAreaInput highlight autocomplete="off" bind:value={contentTarget.content} disabled={locked}/>
            <span class="text-textcolor2 mt-2 mb-2 text-sm">{tokens} {language.tokens}</span>
            {#if editingShared}
                <div class="flex justify-end gap-2 mb-4">
                    <button class="px-3 py-1.5 rounded-md text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => cancelSharedEdit(value)}>
                        취소
                    </button>
                    <button
                        class="px-3 py-1.5 rounded-md bg-primary text-textcolor cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={savingSharedEdit}
                        onclick={() => saveSharedEdit(value)}
                    >
                        저장
                    </button>
                </div>
            {/if}
            <span class="text-textcolor mt-4 mb-2">활성화 방식</span>
            <div class="flex border border-selected rounded-md overflow-hidden w-fit">
                {#each ([['trigger','키워드 트리거'],['always',language.alwaysActive],['disabled','비활성화']] as const) as [mode, label]}
                    <button
                        class="px-3 py-1.5 text-sm cursor-pointer"
                        class:bg-selected={getActivationMode(value) === mode}
                        class:text-textcolor={getActivationMode(value) === mode}
                        class:text-textcolor2={getActivationMode(value) !== mode}
                        onclick={() => setActivationMode(value, mode)}
                    >
                        {label}
                    </button>
                {/each}
            </div>
            {#if getActivationMode(value) === 'trigger' && getCurrentCharacter()?.globalLore?.includes(value) && DBState.db.localActivationInGlobalLorebook}
                <div class="flex items-center mt-2">
                    <Check check={isLocallyActivated(value)} onChange={(check: boolean) => toggleLocalActive(check, value)} name={language.alwaysActiveInChat}/>
                </div>
            {/if}
            {#if !contentTarget.useRegex}
                <div class="flex items-center mt-2">
                    <Check bind:check={contentTarget.selective} disabled={locked} name={language.selective}/>
                    <Help key="loreSelective" name={language.selective}/>
                </div>
            {/if}
            {#if getActivationMode(value) === 'trigger'}
                <div class="flex items-center mt-2">
                    <Check bind:check={contentTarget.useRegex} disabled={locked} name={language.useRegexLorebook}/>
                    <Help key="useRegexLorebook" name={language.useRegexLorebook}/>
                </div>
            {/if}
        </div>
        {/if}
    {/if}
</div>



<style>
    .valuer:hover{
        color: rgba(16, 185, 129, 1);
        cursor: pointer;
    }

    .endflex{
        display: flex;
        flex-grow: 1;
        cursor: pointer;
    }

    /* Styles for SortableJS drag-and-drop feedback */
    :global(.risu-chosen-item) {
        /* The item being dragged */
        padding-bottom: 0.5rem;
        margin-bottom: 0.5rem;
        border-bottom: 1px solid;
        border-bottom-color: var(--risu-theme-selected);
        opacity: 0.7;
    }

    :global(.risu-ghost-item) {
        /* The placeholder for the drop location */
        background-color: rgba(var(--risu-theme-selected-rgb), 0.2);

    }
</style>