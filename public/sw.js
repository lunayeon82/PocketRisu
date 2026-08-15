// @ts-nocheck

// No install/activate handling existed before — a new sw.js deploy would sit
// in "waiting" until every open tab/PWA instance was fully closed, and even
// then wouldn't take control of already-open clients without a reload.
// Doesn't affect app JS/HTML staleness (this SW never intercepts those — see
// the fetch handler below, scoped to /sw/* and /tf/* only) but matters for
// this SW's own listeners (push/notificationclick) taking effect promptly.
self.addEventListener('install', () => {
    self.skipWaiting()
})
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim())
})

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    const path = url.pathname.split('/')
    if(path[1] === 'sw'){
        try {
            switch (path[2]){
                case "check":{
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    event.respondWith(checkCache(targetUrl))
                    break
                }
                case "img": {
                    event.respondWith(getSource(url))
                    break
                }
                case "register": {
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    const noContentType = headers.get('x-no-content-type') === 'true'
                    event.respondWith(
                        registerCache(targetUrl, event.request.arrayBuffer(), noContentType)
                    )
                    break
                }
                case "init":{
                    event.respondWith(new Response("v2"))
                    break
                }
                case 'share':{
                    event.respondWith((async () => {
                        const formData = await event.request.formData();
                        /**
                         * @type {File}
                        */
                        const character = formData.get('character')
                        const preset = formData.get('preset')
                        const module = formData.get('module')
                        if(character){
                            const buf = await character.arrayBuffer()
                            await registerCache(`/sw/share/character`, buf, true)
                            return Response.redirect("/#share_character", 303)
                        }
                        if(preset){
                            const buf = await preset.arrayBuffer()
                            await registerCache(`/sw/share/preset`, buf, true)
                            return Response.redirect("/#share_preset", 303)
                        }
                        if(module){
                            const buf = await module.arrayBuffer()
                            await registerCache(`/sw/share/module`, buf, true)
                            return Response.redirect("/#share_module", 303)
                        }
                        return Response.redirect("/", 303)

                    })())
                    break
                }
                default: {
                    event.respondWith(new Response(
                        path[2]
                    ))
                }
            }
        } catch (error) {
            event.respondWith(new Response(`${error}`))
        }
    }
    if(path[1] === 'tf'){{
        event.respondWith(new Response("Cannot find resource from cache", {
            status: 404
        }))
    }}
})


async function checkCache(url){
    const cache = await caches.open('risuCache')

    if(url.pathname.startsWith("/sw/check")) {
        url.pathname = "/sw/img" + url.pathname.slice(9);
        return new Response(JSON.stringify({
            "able": !!(await cache.match(url))
        }))
    }

    return new Response(JSON.stringify({
        "able": !!(await cache.match(url))
    }))
}

async function getSource(url){
    const cache = await caches.open('risuCache')
    return await cache.match(url)
}

async function check(){

}

async function registerCache(urlr, buffer, noContentType = false){
    const cache = await caches.open('risuCache')
    const url = new URL(urlr)
    if(!noContentType){
        let path = url.pathname.split('/')
        path[2] = 'img'
        url.pathname = path.join('/')
    }
    const buf = new Uint8Array(await buffer)
    let headers = {
        "cache-control": "max-age=604800",
        "content-type": "image/png"
    }
    if(noContentType){
        delete headers["content-type"]
    }
    await cache.put(url, new Response(buf, {
        headers
    }))
    return new Response(JSON.stringify({
        "done": true
    }))
}

// Server never puts the actual reply text in the push payload (see
// pushApi.cjs) — always a generic title/body, so this stays a simple display.
self.addEventListener('push', (event) => {
    let data = {}
    try { data = event.data ? event.data.json() : {} } catch {}
    event.waitUntil(self.registration.showNotification(data.title || '포켓리수', {
        body: data.body || '',
        icon: '/logo_192.png',
        data: { url: '/' },
    }))
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    event.waitUntil((async () => {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const client of allClients) {
            if (client.url.startsWith(self.registration.scope)) {
                client.focus()
                return
            }
        }
        const targetUrl = (event.notification.data && event.notification.data.url) || '/'
        await clients.openWindow(targetUrl)
    })())
})