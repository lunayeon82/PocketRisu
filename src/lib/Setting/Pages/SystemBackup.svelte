<script lang="ts">
    // System → Backups tab. Single home for snapshot management, full server
    // backups, and local backup actions. Migration-style legacy backups stay
    // in MigrationSettings so this page focuses on day-to-day operations.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import ServerBackupList from 'src/lib/Setting/ServerBackupList.svelte'
    import {
        CameraIcon,
        SaveIcon,
        DownloadIcon,
        UploadIcon,
        RotateCcwIcon,
        FolderIcon,
        TriangleAlertIcon,
        RefreshCwIcon,
        TrashIcon,
        CloudIcon,
        LinkIcon,
        Link2OffIcon,
    } from '@lucide/svelte'
    import { alertConfirm, alertError, alertWait, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { setDatabase } from 'src/ts/storage/database.svelte'
    import { decodeRisuSave } from 'src/ts/storage/risuSave'
    import { language } from 'src/lang'
    import { LoadLocalBackup, SaveLocalBackup, SaveServerBackup } from 'src/ts/drive/backuplocal'

    // ── Types ────────────────────────────────────────────────────────────────
    interface Snapshot { key: string; size: number; timestamp: number | null }
    interface BackupPathInfo { path: string; default: string; isDefault: boolean }
    interface SnapshotLimits {
        maxCount: number
        maxBytes: number
        currentCount: number
        currentBytes: number
        logicalBytes: number
        bounds: { minCount: number; maxCount: number; minBytes: number; maxBytes: number }
        defaults: { count: number; bytes: number }
    }

    // ── State ────────────────────────────────────────────────────────────────
    let snapshots = $state<Snapshot[]>([])
    let snapshotLoading = $state(false)
    let snapshotError = $state<string | null>(null)

    let pathInfo = $state<BackupPathInfo | null>(null)
    let pathDialogOpen = $state(false)
    let pathDraft = $state('')
    let pathDialogError = $state<string | null>(null)
    let pathDialogBusy = $state(false)

    let backupListEl = $state<ServerBackupList | undefined>(undefined)
    let backupSaving = $state(false)

    // ── Google Drive state ───────────────────────────────────────────────────
    interface GdriveLastBackup { ts: number; fileName: string; fileId: string }
    interface GdriveStatus { configured: boolean; connected: boolean; lastBackup: GdriveLastBackup | null; hasFullScope: boolean | null }
    interface GdriveFile { id: string; name: string; createdTime: string }
    let gdriveStatus = $state<GdriveStatus | null>(null)
    let gdriveBusy = $state(false)
    let gdriveError = $state<string | null>(null)
    let gdriveFiles = $state<GdriveFile[] | null>(null)
    let gdriveFilesLoading = $state(false)

    let limits = $state<SnapshotLimits | null>(null)
    let limitsDialogOpen = $state(false)
    // ShInput is string-typed; we parse in submitLimits.
    let limitsDraftCount = $state('20')
    let limitsDraftMB = $state('500')
    let limitsDialogError = $state<string | null>(null)
    let limitsDialogBusy = $state(false)

    let bootReminder = $state(false)
    let bootReminderLoaded = $state(false)

    // Stats subset for warnings — fetched alongside snapshots/limits.
    // Uses backupDisk (the backup destination) rather than save/ — the user
    // may have pointed backupsDir at a different mount/external drive, in
    // which case save/'s free space is irrelevant for the backup guard.
    let diskFree = $state<number | null>(null)
    let diskTotal = $state<number | null>(null)
    let estimatedBackupSize = $state<number | null>(null)

    const diskUsedPct = $derived(
        diskFree != null && diskTotal != null && diskTotal > 0
            ? ((diskTotal - diskFree) / diskTotal) * 100
            : null
    )
    // 90-94% → yellow warn, 95%+ → red crit.
    const diskUsageLevel = $derived<'none' | 'warn' | 'crit'>(
        diskUsedPct == null ? 'none'
            : diskUsedPct >= 95 ? 'crit'
            : diskUsedPct >= 90 ? 'warn'
            : 'none'
    )
    const insufficientForBackup = $derived(
        estimatedBackupSize != null && diskFree != null && estimatedBackupSize > diskFree
    )

    // ── Format helpers ───────────────────────────────────────────────────────
    function fmtBytes(n: number): string {
        if (n < 1024) return `${n} B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    // ── Snapshots ────────────────────────────────────────────────────────────
    async function loadSnapshots() {
        snapshotLoading = true
        snapshotError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            snapshots = json.snapshots ?? []
        } catch (err) {
            snapshotError = err instanceof Error ? err.message : String(err)
        } finally {
            snapshotLoading = false
        }
    }

    async function deleteSnapshot(snap: Snapshot) {
        const when = snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key
        if (!(await alertConfirm(language.backupSnapshotDeleteConfirm(when)))) return
        try {
            const auth = await forageStorage.createAuth()
            const url = '/api/db/snapshots?key=' + encodeURIComponent(snap.key)
            const res = await fetch(url, { method: 'DELETE', headers: { 'risu-auth': auth } })
            if (!res.ok) {
                const json = await res.json().catch(() => ({}))
                throw new Error(json?.error || `HTTP ${res.status}`)
            }
            notifySuccess(language.backupSnapshotDeleted)
            await Promise.all([loadSnapshots(), loadLimits()])
        } catch (err) {
            alertError(language.backupSnapshotDeleteFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    async function restoreSnapshot(snap: Snapshot) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        alertWait(language.serverBackupRestoring)
        try {
            // Server-side atomic restore: copies snapshot blob → live blob,
            // invalidates caches, rebuilds chat store. Avoids the race where
            // a client-side setDatabase + reload could lose data because the
            // debounced save hadn't flushed yet.
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/restore', {
                method: 'POST',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ key: snap.key }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess('Loaded backup')
            location.search = ''
            location.reload()
        } catch (err) {
            alertError(err instanceof Error ? err.message : String(err))
        }
    }

    // ── Snapshot limits ──────────────────────────────────────────────────────
    async function loadLimits() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            limits = await res.json()
        } catch (err) {
            console.error('[Snapshot limits]', err)
        }
    }

    function openLimitsDialog() {
        if (!limits) return
        limitsDraftCount = String(limits.maxCount)
        limitsDraftMB = String(Math.round(limits.maxBytes / 1024 / 1024))
        limitsDialogError = null
        limitsDialogOpen = true
    }

    async function submitLimits() {
        if (!limits) return
        const c = Math.floor(Number(limitsDraftCount))
        const mb = Math.floor(Number(limitsDraftMB))
        const minC = limits.bounds.minCount
        const maxC = limits.bounds.maxCount
        const minMB = Math.round(limits.bounds.minBytes / 1024 / 1024)
        const maxMB = Math.round(limits.bounds.maxBytes / 1024 / 1024)
        if (!Number.isFinite(c) || c < minC || c > maxC) {
            limitsDialogError = language.backupSnapshotLimitsCountRange(minC, maxC)
            return
        }
        if (!Number.isFinite(mb) || mb < minMB || mb > maxMB) {
            limitsDialogError = language.backupSnapshotLimitsBytesRange(minMB, maxMB)
            return
        }
        limitsDialogBusy = true
        limitsDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ maxCount: c, maxBytes: mb * 1024 * 1024 }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                limitsDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            limitsDialogOpen = false
            notifySuccess(language.backupSnapshotLimitsSuccess(json.removed ?? 0))
            await Promise.all([loadLimits(), loadSnapshots()])
        } catch (err) {
            limitsDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            limitsDialogBusy = false
        }
    }

    // ── Backup path ──────────────────────────────────────────────────────────
    async function loadPath() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            pathInfo = await res.json()
        } catch (err) {
            // Non-fatal — path display will show '—'.
            console.error('[Backup path]', err)
        }
    }

    function openPathDialog() {
        pathDraft = pathInfo?.path ?? ''
        pathDialogError = null
        pathDialogOpen = true
    }

    async function submitPathChange() {
        const trimmed = pathDraft.trim()
        if (!trimmed) {
            pathDialogError = language.backupServerPathInputLabel
            return
        }
        pathDialogBusy = true
        pathDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ path: trimmed }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                pathDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            pathInfo = json
            pathDialogOpen = false
            notifySuccess(language.backupServerPathSuccess)
            // Refresh backup list since the dir changed (now empty unless user moved files).
            backupListEl?.loadBackups()
        } catch (err) {
            pathDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            pathDialogBusy = false
        }
    }

    // ── Stats (for disk warnings + insufficient guard) ──────────────────────
    async function loadStats() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats', { headers: { 'risu-auth': auth } })
            if (!res.ok) return
            const json = await res.json()
            // Prefer backupDisk (mounts to actual backup destination); fall
            // back to disk for older servers that don't yet expose it.
            const d = json?.backupDisk ?? json?.disk
            if (typeof d?.free === 'number') diskFree = d.free
            if (typeof d?.total === 'number') diskTotal = d.total
            if (typeof json?.estimatedBackupSize === 'number') estimatedBackupSize = json.estimatedBackupSize
        } catch { /* non-fatal */ }
    }

    // ── Boot reminder ────────────────────────────────────────────────────────
    async function loadBootReminder() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            bootReminder = !!json.enabled
            bootReminderLoaded = true
        } catch (err) {
            console.error('[Boot reminder]', err)
        }
    }

    async function saveBootReminder(next: boolean) {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            notifySuccess(next ? language.backupBootReminderToggledOn : language.backupBootReminderToggledOff)
        } catch (err) {
            // Optimistic update revert on PUT failure.
            bootReminder = !next
            notifyError('Failed to save: ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    // ── Google Drive actions ─────────────────────────────────────────────────
    async function loadGdriveStatus() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/gdrive/status', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            gdriveStatus = await res.json()
        } catch (err) {
            console.error('[GDrive status]', err)
        }
    }

    async function connectGdrive() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/gdrive/auth-url', { headers: { 'risu-auth': auth } })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            window.location.href = json.url
        } catch (err) {
            gdriveError = err instanceof Error ? err.message : String(err)
        }
    }

    async function disconnectGdrive() {
        if (!(await alertConfirm('Google Drive 연결을 해제하시겠습니까?'))) return
        gdriveBusy = true
        gdriveError = null
        try {
            const auth = await forageStorage.createAuth()
            await fetch('/api/gdrive/disconnect', { method: 'DELETE', headers: { 'risu-auth': auth } })
            await loadGdriveStatus()
        } catch (err) {
            gdriveError = err instanceof Error ? err.message : String(err)
        } finally {
            gdriveBusy = false
        }
    }

    async function backupToGdrive() {
        gdriveBusy = true
        gdriveError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/gdrive/backup', { method: 'POST', headers: { 'risu-auth': auth } })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess(`Google Drive 백업 완료: ${json.fileName}`)
            await Promise.all([loadGdriveStatus(), loadGdriveFiles()])
        } catch (err) {
            gdriveError = err instanceof Error ? err.message : String(err)
        } finally {
            gdriveBusy = false
        }
    }

    async function loadGdriveFiles() {
        gdriveFilesLoading = true
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/gdrive/files', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            gdriveFiles = json.files ?? []
        } catch (err) {
            console.error('[GDrive files]', err)
            gdriveFiles = []
        } finally {
            gdriveFilesLoading = false
        }
    }

    async function restoreFromGdrive(file: GdriveFile) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        alertWait(language.serverBackupRestoring)
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/gdrive/restore', {
                method: 'POST',
                headers: { 'risu-auth': auth, 'content-type': 'application/json' },
                body: JSON.stringify({ fileId: file.id }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess('Google Drive 백업에서 복원 완료')
            location.search = ''
            location.reload()
        } catch (err) {
            notifyError(err instanceof Error ? err.message : String(err))
        }
    }

    // ── Server backup actions ───────────────────────────────────────────────
    async function createServerBackup() {
        if (!(await alertConfirm(language.backupConfirm))) return
        backupSaving = true
        try {
            await SaveServerBackup()
            backupListEl?.loadBackups()
        } finally {
            backupSaving = false
        }
    }

    async function downloadLocal() {
        if (!(await alertConfirm(language.backupConfirm))) return
        SaveLocalBackup()
    }

    async function restoreFromLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }

    $effect(() => {
        loadSnapshots()
        loadPath()
        loadLimits()
        loadBootReminder()
        loadStats()
        loadGdriveStatus()
        // Pick up ?gdriveConnected or ?gdriveError query params after OAuth redirect
        const params = new URLSearchParams(window.location.search)
        if (params.has('gdriveConnected')) {
            notifySuccess('Google Drive 연결 완료!')
            window.history.replaceState({}, '', window.location.pathname)
        } else if (params.has('gdriveError')) {
            gdriveError = 'Google Drive 연결 실패: ' + decodeURIComponent(params.get('gdriveError') ?? '')
            window.history.replaceState({}, '', window.location.pathname)
        }
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.backupTabDesc}</p>

<!-- Server backup section ────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-textcolor">
            <SaveIcon size={16} />
            <span class="font-medium">{language.backupServer}</span>
        </div>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerDesc}</p>

    {#if insufficientForBackup}
        <div class="bg-draculared/20 border border-draculared/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-red-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
            <span class="leading-relaxed text-sm">{language.backupServerInsufficient}</span>
        </div>
    {:else if diskUsageLevel === 'crit' && diskUsedPct != null}
        <div class="bg-draculared/20 border border-draculared/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-red-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
            <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
        </div>
    {:else if diskUsageLevel === 'warn' && diskUsedPct != null}
        <div class="bg-yellow-900/30 border border-yellow-700/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-yellow-300">
            <TriangleAlertIcon class="size-4 shrink-0 text-yellow-400" />
            <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
        </div>
    {/if}

    <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
        {#if bootReminderLoaded}
            <div class="flex items-center gap-2">
                <label class="flex items-center gap-2 cursor-pointer select-none" title={language.backupBootReminderHint}>
                    <ShSwitch bind:checked={bootReminder} onCheckedChange={(v) => { bootReminder = v; saveBootReminder(v); }} />
                    <span class="text-textcolor text-sm">{language.backupBootReminder}</span>
                </label>
                <Help key="bootBackupReminder" />
            </div>
        {:else}
            <span></span>
        {/if}
        <ShButton variant="primary" onclick={createServerBackup} disabled={backupSaving || insufficientForBackup}>
            <SaveIcon size={16} />
            {language.backupServerCreate}
        </ShButton>
    </div>

    <!-- Path control -->
    <div class="flex items-center gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
        <FolderIcon size={14} class="text-textcolor2 shrink-0" />
        <span class="text-textcolor2 text-xs shrink-0">{language.backupServerPath}:</span>
        <span class="text-textcolor text-xs font-mono truncate flex-1 min-w-0">
            {pathInfo?.path ?? '—'}
        </span>
        {#if pathInfo?.isDefault}
            <span class="text-textcolor2 text-xs shrink-0 opacity-60">({language.backupServerPathDefault})</span>
        {/if}
        <ShButton variant="outline" size="xs" onclick={openPathDialog}>
            {language.backupServerPathChange}
        </ShButton>
    </div>

    <ServerBackupList bind:this={backupListEl} />
</div>

<!-- Snapshot section ─────────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-textcolor">
            <CameraIcon size={16} />
            <span class="font-medium">{language.backupSnapshot}</span>
        </div>
        <ShButton variant="outline" size="sm" onclick={loadSnapshots} disabled={snapshotLoading}>
            <RefreshCwIcon size={14} class={snapshotLoading ? 'animate-spin' : ''} />
        </ShButton>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.storageBackupsAutoDesc}</p>

    <!-- Retention limits row -->
    {#if limits}
        <div class="flex items-start gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <!-- Stacked so the (now longer) "current/savings" line wraps to as many
                 lines as it needs on a narrow phone instead of being truncated. -->
            <div class="flex flex-col gap-0.5 flex-1 min-w-0">
                <span class="text-textcolor2 text-xs">{language.backupSnapshotLimits(limits.maxCount, limits.maxBytes)}</span>
                <span class="text-textcolor2 text-xs opacity-70 wrap-break-word">
                    {language.backupSnapshotLimitsCurrent(limits.currentCount, limits.currentBytes, limits.logicalBytes)}
                </span>
            </div>
            <div class="shrink-0">
                <ShButton variant="outline" size="xs" onclick={openLimitsDialog}>
                    {language.backupSnapshotLimitsChange}
                </ShButton>
            </div>
        </div>
    {/if}

    {#if snapshotError}
        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {snapshotError}
        </ShAlert>
    {:else if snapshots.length === 0 && !snapshotLoading}
        <p class="text-textcolor2 text-sm">{language.backupSnapshotEmpty}</p>
    {:else if snapshots.length > 0}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            {#each snapshots as snap, i (snap.key)}
                <div class="flex items-center gap-3 px-3 py-2 {i > 0 ? 'border-t border-darkborderc/50' : ''}">
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-sm text-textcolor">
                            {snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key}
                        </span>
                        <span class="text-xs text-textcolor2 tabular-nums">{fmtBytes(snap.size)}</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button class="text-textcolor2 hover:text-primary cursor-pointer" title={language.backupSnapshotRestore} aria-label={language.backupSnapshotRestore}
                            onclick={() => restoreSnapshot(snap)}>
                            <RotateCcwIcon size={18}/>
                        </button>
                        <button class="text-textcolor2 hover:text-red-400 cursor-pointer" title={language.backupSnapshotDelete} aria-label={language.backupSnapshotDelete}
                            onclick={() => deleteSnapshot(snap)}>
                            <TrashIcon size={18}/>
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>

<!-- Local backup section ────────────────────────────────────────────────── -->
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <DownloadIcon size={16} />
        <span class="font-medium">{language.backupLocal}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupLocalDesc}</p>

    <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupLocalDownload}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalDownloadDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadLocal}>
                <DownloadIcon size={14} />
                {language.backupLocalDownload}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.loadBackupLocal}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalRestoreDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={restoreFromLocalFile}>
                <UploadIcon size={14} />
                {language.loadBackupLocal}
            </ShButton>
        </div>
    </div>
</div>

<!-- Google Drive backup section ─────────────────────────────────────────── -->
{#if gdriveStatus}
<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-textcolor">
            <CloudIcon size={16} />
            <span class="font-medium">Google Drive 백업</span>
        </div>
        {#if gdriveStatus.connected}
            <span class="text-xs text-green-400 flex items-center gap-1">
                <LinkIcon size={12} />연결됨
            </span>
        {/if}
    </div>

    {#if !gdriveStatus.configured}
        <p class="text-textcolor2 text-sm leading-relaxed">
            Google Drive 백업을 사용하려면 서버에 <code class="bg-bgcolor px-1 rounded text-xs">GDRIVE_CLIENT_ID</code>와
            <code class="bg-bgcolor px-1 rounded text-xs">GDRIVE_CLIENT_SECRET</code> 환경변수를 설정해야 합니다.
        </p>
    {:else if !gdriveStatus.connected}
        <p class="text-textcolor2 text-sm leading-relaxed mb-3">
            Google Drive와 연결하면 5분마다 자동으로 백업되고, 버튼으로 즉시 백업할 수 있습니다.
        </p>
        <ShButton variant="primary" onclick={connectGdrive} disabled={gdriveBusy}>
            <LinkIcon size={14} />
            Google Drive 연결
        </ShButton>
    {:else}
        {#if gdriveStatus.hasFullScope === false}
            <div class="bg-yellow-900/30 border border-yellow-700/40 rounded-md px-4 py-3 mb-3 flex items-start gap-2.5 text-yellow-300">
                <TriangleAlertIcon class="size-4 shrink-0 text-yellow-400 mt-0.5" />
                <span class="leading-relaxed text-sm">
                    <strong>권한 부족:</strong> 현재 연결은 앱이 직접 만든 파일만 접근 가능합니다.
                    수동으로 추가한 파일을 불러오려면 <strong>연결 해제</strong> 후 다시 연결하세요.
                </span>
            </div>
        {/if}
        <p class="text-textcolor2 text-sm leading-relaxed mb-3">
            변경 사항이 있을 때 5분마다 자동 백업됩니다. Google Drive의 <strong>PocketRisu Backups</strong> 폴더에 저장됩니다.
        </p>
        {#if gdriveStatus.lastBackup}
            <p class="text-textcolor2 text-xs mb-3">
                마지막 백업: {new Date(gdriveStatus.lastBackup.ts).toLocaleString()}
                ({gdriveStatus.lastBackup.fileName})
            </p>
        {:else}
            <p class="text-textcolor2 text-xs mb-3">아직 백업된 기록이 없습니다.</p>
        {/if}
        <div class="flex items-center gap-2 mb-4">
            <ShButton variant="primary" onclick={backupToGdrive} disabled={gdriveBusy}>
                <CloudIcon size={14} />
                {gdriveBusy ? '백업 중...' : '지금 백업'}
            </ShButton>
            <ShButton variant="outline" onclick={disconnectGdrive} disabled={gdriveBusy}>
                <Link2OffIcon size={14} />
                연결 해제
            </ShButton>
        </div>

        <!-- Drive 백업 파일 목록 -->
        <div class="border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-darkborderc/50">
                <span class="text-textcolor2 text-xs font-medium">Drive 백업 목록 (최대 10개)</span>
                <ShButton variant="outline" size="xs"
                    onclick={() => { gdriveFiles === null ? loadGdriveFiles() : loadGdriveFiles() }}
                    disabled={gdriveFilesLoading}>
                    <RefreshCwIcon size={12} class={gdriveFilesLoading ? 'animate-spin' : ''} />
                    {gdriveFiles === null ? '목록 불러오기' : '새로고침'}
                </ShButton>
            </div>
            {#if gdriveFiles === null}
                <p class="text-textcolor2 text-xs px-3 py-2">버튼을 눌러 목록을 불러오세요.</p>
            {:else if gdriveFiles.length === 0}
                <p class="text-textcolor2 text-xs px-3 py-2">백업 파일이 없습니다.</p>
            {:else}
                {#each gdriveFiles as file, i (file.id)}
                    <div class="flex items-center gap-3 px-3 py-2 {i > 0 ? 'border-t border-darkborderc/50' : ''}">
                        <div class="flex flex-col min-w-0 flex-1">
                            <span class="text-sm text-textcolor truncate">{file.name}</span>
                            <span class="text-xs text-textcolor2">{new Date(file.createdTime).toLocaleString()}</span>
                        </div>
                        <button
                            class="text-textcolor2 hover:text-primary cursor-pointer shrink-0"
                            title="이 백업으로 복원"
                            aria-label="복원"
                            onclick={() => restoreFromGdrive(file)}>
                            <RotateCcwIcon size={16} />
                        </button>
                    </div>
                {/each}
            {/if}
        </div>
    {/if}

    {#if gdriveError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {gdriveError}
        </ShAlert>
    {/if}
</div>
{/if}

<!-- Path-change dialog ──────────────────────────────────────────────────── -->
<ShDialog bind:open={pathDialogOpen} size="lg">
    {#snippet title()}{language.backupServerPathDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerPathDialogDesc}</p>
    <label class="flex flex-col gap-1">
        <span class="text-textcolor2 text-sm">{language.backupServerPathInputLabel}</span>
        <ShInput bind:value={pathDraft} placeholder="/absolute/path/to/backups" />
    </label>
    {#if pathDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {pathDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (pathDialogOpen = false)} disabled={pathDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitPathChange} disabled={pathDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>

<!-- Snapshot limits dialog ──────────────────────────────────────────────── -->
<ShDialog bind:open={limitsDialogOpen} size="lg">
    {#snippet title()}{language.backupSnapshotLimitsDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupSnapshotLimitsDialogDesc}</p>
    {#if limits}
        <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsCount}</span>
                <ShInput type="number" bind:value={limitsDraftCount}
                    min={limits.bounds.minCount} max={limits.bounds.maxCount} step={1} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsCountRange(limits.bounds.minCount, limits.bounds.maxCount)}
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsBytes}</span>
                <ShInput type="number" bind:value={limitsDraftMB}
                    min={Math.round(limits.bounds.minBytes / 1024 / 1024)}
                    max={Math.round(limits.bounds.maxBytes / 1024 / 1024)}
                    step={10} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsBytesRange(
                        Math.round(limits.bounds.minBytes / 1024 / 1024),
                        Math.round(limits.bounds.maxBytes / 1024 / 1024)
                    )}
                </span>
            </label>
        </div>
    {/if}
    {#if limitsDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {limitsDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (limitsDialogOpen = false)} disabled={limitsDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitLimits} disabled={limitsDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>
