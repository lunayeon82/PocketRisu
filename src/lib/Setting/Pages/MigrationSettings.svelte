<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { alertConfirm, alertStore, notifySuccess, notifyError } from "src/ts/alert";
    import {
        LoadLocalBackup,
        SaveLocalBackupForUpstream,
        SavePartialLocalBackup,
        ImportFromSaveZip,
        CleanupMigratedFiles,
    } from "src/ts/drive/backuplocal";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { openSettings, SettingsRoute, SystemTab } from "src/ts/routing";
    import { InfoIcon } from "@lucide/svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { migrateAllChatsToServer } from "src/ts/storage/chatStorage";

    async function runChatMigration() {
        const characters = DBState.db.characters ?? []
        const total = characters.reduce((n, c) => n + (c?.chats?.length ?? 0), 0)
        if (total === 0) {
            notifyError("마이그레이션할 채팅이 없습니다.")
            return
        }
        if (!(await alertConfirm(`채팅 ${total}건을 서버 DB(rl_chats)로 일괄 이전합니다. 계속할까요?`))) return

        alertStore.set({ type: "wait", msg: `마이그레이션 중... (0 / ${total})` })
        let result: { succeeded: number; failed: number }
        try {
            result = await migrateAllChatsToServer(characters, (done, tot) => {
                alertStore.set({ type: "wait", msg: `마이그레이션 중... (${done} / ${tot})` })
            })
        } catch (e) {
            notifyError(`마이그레이션 실패: ${e instanceof Error ? e.message : String(e)}`)
            return
        }

        if (result.failed === 0) {
            notifySuccess(`마이그레이션 완료: 성공 ${result.succeeded}건`)
        } else {
            notifyError(`마이그레이션 완료: 성공 ${result.succeeded}건, 실패 ${result.failed}건`)
        }
    }

    function gotoBackupTab() {
        openSettings(SettingsRoute.System, SystemTab.Backups);
    }
</script>

<SettingPage title={language.migration}>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <ShAlert variant="info" className="mb-4">
        {#snippet icon()}<InfoIcon />{/snippet}
        {#snippet title()}{language.migrationInfoBackupMoved}{/snippet}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={gotoBackupTab}>
                {language.migrationGotoBackupTab}
            </ShButton>
        {/snippet}
    </ShAlert>

    <!-- Migration: upstream RisuAI ↔ NodeOnly ─────────────────────────── -->
    <Button
        onclick={async () => {
            if (await alertConfirm(language.saveBackupForUpstreamConfirm)) {
                SaveLocalBackupForUpstream();
            }
        }} className="mt-2">
        {language.saveBackupForUpstream}
    </Button>

    <Button
        onclick={async () => {
            if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
                LoadLocalBackup();
            }
        }} className="mt-2">
        {language.migrationLoadUpstreamBackup}
    </Button>

    <!-- Server chat migration ──────────────────────────────────────────── -->
    <div class="mt-6">
        <ShAccordion name="서버 채팅 마이그레이션" variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">
                기존 채팅 전체를 서버 DB(rl_chats / rl_messages)로 일괄 이전합니다.
                이미 이전된 채팅은 덮어씌워도 데이터가 유지됩니다.
                채팅이 많으면 수 분 걸릴 수 있습니다.
            </p>
            <Button onclick={runChatMigration} className="w-full">
                서버로 마이그레이션
            </Button>
        </ShAccordion>
    </div>

    <!-- Save folder import (collapsed by default) ────────────────────── -->
    <div class="mt-6">
        <ShAccordion name={language.migrationSaveFolderAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationSaveFolderDesc}</p>

            <p class="text-textcolor2 text-sm leading-relaxed mb-2">{language.importSaveZipDesc}</p>
            <div class="flex flex-col gap-2">
                <Button onclick={ImportFromSaveZip} className="w-full">
                    {language.importSaveZip}
                </Button>
            </div>

            <p class="text-textcolor2 text-sm leading-relaxed mt-4 mb-2">{language.cleanupMigratedDesc}</p>
            <div class="flex flex-col gap-2">
                <Button onclick={CleanupMigratedFiles} className="w-full">
                    {language.cleanupMigratedFiles}
                </Button>
            </div>
        </ShAccordion>
    </div>

    <!-- Legacy backup options (collapsed by default) ──────────────────── -->
    <div class="mt-3">
        <ShAccordion name={language.migrationLegacyAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationLegacyDesc}</p>
            <div class="flex flex-col gap-2">
                <Button
                    onclick={async () => {
                        if (await alertConfirm(language.backupConfirm)) {
                            SavePartialLocalBackup();
                        }
                    }} className="w-full">
                    {language.savePartialLocalBackup}
                </Button>

                <Button onclick={exportAsDataset} className="w-full">
                    {language.exportAsDataset}
                </Button>
            </div>
        </ShAccordion>
    </div>
</SettingPage>
