<script lang="ts">
    import { language } from 'src/lang';
    import { notifyError } from 'src/ts/alert';
    import { DBState } from 'src/ts/stores.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SoundRow from '../Sound/SoundRow.svelte';
    import { getVapidPublicKey, subscribePush, unsubscribePush } from 'src/ts/storage/chatStorage';

    // Standard VAPID applicationServerKey conversion — PushManager.subscribe
    // wants a Uint8Array, the server hands back a urlsafe-base64 string.
    function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
        const padding = '='.repeat((4 - (base64.length % 4)) % 4);
        const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64);
        const out = new Uint8Array(new ArrayBuffer(raw.length));
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    // Best-effort — a subscribe failure doesn't revert DBState.db.notification
    // (in-tab notifications keep working regardless of OS push), just warns.
    async function trySubscribePush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            const registration = await navigator.serviceWorker.ready;
            const publicKey = await getVapidPublicKey();
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
            await subscribePush(subscription.toJSON(), navigator.userAgent);
        } catch (error) {
            notifyError(language.pushSubscribeFailed);
        }
    }

    // Best-effort cleanup — never blocks turning the toggle off.
    async function tryUnsubscribePush() {
        try {
            if (!('serviceWorker' in navigator)) return;
            const registration = await navigator.serviceWorker.getRegistration();
            const subscription = await registration?.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
                await unsubscribePush(subscription.endpoint);
            }
        } catch (error) {
            // Non-fatal — nothing to surface to the user here.
        }
    }

    async function onToggle(check: boolean) {
        DBState.db.notification = check;
        if (!check) {
            void tryUnsubscribePush();
            return;
        }
        let hasPermission = { state: 'denied' };
        try {
            hasPermission = await navigator.permissions.query({ name: 'notifications' });
        } catch (error) {
            // Some browsers do not support the Permissions API.
        }
        if (hasPermission.state === 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'denied') {
                notifyError(language.permissionDenied);
                DBState.db.notification = false;
                return;
            }
        }
        void trySubscribePush();
    }
</script>

<SoundRow label={language.notificationEnable} description={language.descBrowserNotification}>
    <ShSwitch checked={DBState.db.notification} onCheckedChange={onToggle} />
</SoundRow>
