import "./ts/polyfill";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import SettingsApp from "./SettingsApp.svelte";
import { loadData } from "./ts/bootstrap";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";

window.addEventListener('vite:preloadError', (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

preLoadCheck()
mount(SettingsApp, {
    target: document.getElementById("app"),
});
loadData().catch((err) => {
    window.dispatchEvent(new CustomEvent('settings:load-error', {
        detail: err?.message ?? String(err)
    }));
});
document.getElementById('preloading').remove()
