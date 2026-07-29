import type SettingsType from './Settings.svelte'

let settingsPromise: Promise<{ default: typeof SettingsType }> | null = null

// Shared across App.svelte / ChatApp.svelte / MobileBody.svelte so the dynamic
// import fires once regardless of which shell mounts it first.
export function loadSettings() {
    settingsPromise ??= import('./Settings.svelte')
    return settingsPromise
}
