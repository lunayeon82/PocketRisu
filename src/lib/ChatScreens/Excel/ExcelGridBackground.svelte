<script lang="ts">
    const CELL_W = 96;
    const CELL_H = 24;
    const HEADER_W = 40;
    const HEADER_H = 22;

    let container: HTMLDivElement | undefined = $state();
    let cols = $state(0);
    let rows = $state(0);

    // Excel-style column labels: A..Z, AA..AZ, BA.. (base-26, no zero digit).
    function colLabel(index: number): string {
        let n = index + 1;
        let label = '';
        while (n > 0) {
            const rem = (n - 1) % 26;
            label = String.fromCharCode(65 + rem) + label;
            n = Math.floor((n - 1) / 26);
        }
        return label;
    }

    function measure() {
        if (!container) return;
        const rect = container.getBoundingClientRect();
        cols = Math.max(0, Math.ceil((rect.width - HEADER_W) / CELL_W)) + 1;
        rows = Math.max(0, Math.ceil((rect.height - HEADER_H) / CELL_H)) + 1;
    }

    $effect(() => {
        if (!container) return;
        measure();
        const ro = new ResizeObserver(() => measure());
        ro.observe(container);
        return () => ro.disconnect();
    });
</script>

<div
    bind:this={container}
    class="absolute inset-0 overflow-hidden pointer-events-none select-none"
    style="--cell-w: {CELL_W}px; --cell-h: {CELL_H}px; --header-w: {HEADER_W}px; --header-h: {HEADER_H}px;"
>
    <div
        class="absolute bg-white"
        style="left: var(--header-w); top: var(--header-h); right: 0; bottom: 0;
            background-image:
                repeating-linear-gradient(to right, #d4d4d4 0 1px, transparent 1px var(--cell-w)),
                repeating-linear-gradient(to bottom, #d4d4d4 0 1px, transparent 1px var(--cell-h));"
    ></div>

    <div class="absolute flex" style="left: var(--header-w); top: 0; right: 0; height: var(--header-h);">
        {#each Array(cols) as _, i (i)}
            <div
                class="flex items-center justify-center text-[11px] text-gray-600 border-r border-b border-gray-300 bg-[#f3f2f1] shrink-0"
                style="width: var(--cell-w); height: 100%;"
            >{colLabel(i)}</div>
        {/each}
    </div>

    <div class="absolute flex flex-col" style="left: 0; top: var(--header-h); width: var(--header-w); bottom: 0;">
        {#each Array(rows) as _, i (i)}
            <div
                class="flex items-center justify-center text-[11px] text-gray-600 border-r border-b border-gray-300 bg-[#f3f2f1] shrink-0"
                style="height: var(--cell-h); width: 100%;"
            >{i + 1}</div>
        {/each}
    </div>

    <div
        class="absolute border-r border-b border-gray-300 bg-[#f3f2f1]"
        style="left: 0; top: 0; width: var(--header-w); height: var(--header-h);"
    ></div>
</div>
