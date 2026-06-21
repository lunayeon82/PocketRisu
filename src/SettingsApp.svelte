<script lang="ts">
    import { loadedStore, LoadingStatusState } from './ts/stores.svelte'
    import Settings from './lib/Setting/Settings.svelte'
    import AlertComp from './lib/Others/AlertComp.svelte'
    import LoadingOverlay from './lib/Others/LoadingOverlay.svelte'
    import Toaster from './lib/UI/GUI/Toaster.svelte'
    import RequestStatusToaster from './lib/UI/GUI/RequestStatusToaster.svelte'
    import { LoadLocalBackup } from './ts/drive/backuplocal'
    import { TriangleAlertIcon } from '@lucide/svelte'

    let loadError = $state<string | null>(null)

    $effect(() => {
        function onLoadError(e: Event) {
            loadError = (e as CustomEvent<string>).detail
        }
        window.addEventListener('settings:load-error', onLoadError)
        return () => window.removeEventListener('settings:load-error', onLoadError)
    })
</script>

<div class="flex bg-bg w-full h-full max-w-100vw text-textcolor">
    {#if loadError}
        <div class="w-full h-full flex flex-col justify-center items-center bg-gray-900 text-white gap-4 p-8">
            <TriangleAlertIcon class="text-red-400 size-10" />
            <h1 class="text-xl font-bold text-red-400">데이터 로드 실패</h1>
            <p class="text-gray-400 text-sm text-center max-w-sm break-words">{loadError}</p>
            <p class="text-gray-500 text-xs text-center max-w-sm">저장 파일이 손상되었습니다. 로컬 백업 파일(.bin)로 복원하거나 홈으로 돌아가세요.</p>
            <div class="flex gap-3 flex-wrap justify-center">
                <button
                    onclick={() => LoadLocalBackup()}
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium transition-colors">
                    로컬 백업 파일로 복원
                </button>
                <a href="/" class="px-4 py-2 border border-gray-600 hover:border-gray-400 rounded text-sm text-gray-300 transition-colors">
                    홈으로
                </a>
            </div>
        </div>
    {:else if !$loadedStore}
        <div class="w-full h-full flex justify-center items-center text-textcolor text-xl bg-gray-900 flex-col">
            <div class="flex flex-row items-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-textcolor" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Loading...</span>
            </div>
            <span class="text-sm mt-2 text-textcolor2">{LoadingStatusState.text}</span>
        </div>
    {:else}
        <Settings />
    {/if}
</div>
<AlertComp />
<LoadingOverlay />
<Toaster />
<RequestStatusToaster />
