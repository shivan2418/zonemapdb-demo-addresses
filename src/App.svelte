<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { search, totalAddresses } from "./search-client";

  let query = $state("");
  let results = $state<string[]>([]);
  let loading = $state(false);
  // Too little typed to search yet (or a half-typed word was dropped).
  let waiting = $state(false);
  let error = $state("");
  let copied = $state<string | null>(null);
  let toast = $state<{ id: number; text: string } | null>(null);
  // A picked address stays put until the search box is cleared.
  let locked = $state<string | null>(null);
  let input: HTMLInputElement;
  let total = $state<number | null>(null);
  totalAddresses().then((n) => (total = n), () => {});

  // A search starts once typing pauses for DEBOUNCE ms. A newer one cancels the older, so only
  // the latest request's results are ever shown.
  const DEBOUNCE = 300;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function onInput() {
    const text = query;
    const id = ++latest;
    clearTimeout(timer);
    if (!text.trim()) {
      results = [];
      loading = false;
      return;
    }
    loading = true;
    timer = setTimeout(async () => {
      try {
        const addresses = await search(text);
        if (id !== latest) return;
        // Not searchable yet: keep showing the last results.
        waiting = addresses === null;
        if (addresses) results = [...new Set(addresses)];
        error = "";
      } catch (e) {
        if (id !== latest) return;
        error = e instanceof Error ? e.message : String(e);
      } finally {
        if (id === latest) loading = false;
      }
    }, DEBOUNCE);
  }

  function lock(address: string) {
    latest++; // drop any search still in flight
    clearTimeout(timer);
    loading = false;
    locked = address;
    query = address;
    results = [address];
  }

  function clear() {
    locked = null;
    query = "";
    onInput();
    input.focus();
  }

  // Up to 20 results come back; VISIBLE of them show, and the list scrolls for the rest. Rows
  // wrap on narrow screens, so the height is measured from the rows rather than fixed.
  const VISIBLE = 5;
  function fitRows(_: string[]) {
    return (ul: HTMLUListElement) => {
      const rows = ul.children;
      ul.style.maxHeight =
        rows.length > VISIBLE ? `${(rows[VISIBLE] as HTMLElement).offsetTop}px` : ""; // rows sit in the list
      ul.scrollTop = 0;
    };
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function notify(text: string) {
    clearTimeout(toastTimer);
    toast = { id: (toast?.id ?? 0) + 1, text };
    toastTimer = setTimeout(() => (toast = null), 2000);
  }

  async function copy(address: string) {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      notify("Couldn't copy: your browser blocked clipboard access");
      return;
    }
    notify("Copied to clipboard");
    copied = address;
    setTimeout(() => {
      if (copied === address) copied = null;
    }, 1500);
  }
</script>

<main>
  <h1>Search {total === null ? "" : total.toLocaleString("en-US")} US addresses</h1>
  <p class="tagline">
    A proof of concept for <a href="https://github.com/shivan2418/zonemapdb">zonemapdb</a>. There's no API
    and no server: your browser searches static files directly.
  </p>

  <div class="box">
    <input
      bind:this={input}
      type="text"
      bind:value={query}
      oninput={onInput}
      onkeydown={(e) => e.key === "Escape" && clear()}
      readonly={locked !== null}
      placeholder="e.g. 1600 Pennsylvania Ave, DC"
      autocomplete="off"
      spellcheck="false"
      aria-label="Address"
      {@attach (el) => el.focus()}
    />
    {#if query}
      <button type="button" class="clear" onclick={clear} aria-label="Clear search">×</button>
    {/if}
  </div>

  {#if error}
    <p class="status">Something went wrong: {error}</p>
  {:else if query.trim() && !loading && !waiting && results.length === 0}
    <p class="status">No matching addresses</p>
  {/if}

  <ul class:loading class:more={results.length > VISIBLE} {@attach fitRows(results)}>
    {#each results as address (address)}
      <li class:locked={locked === address}>
        <button type="button" class="pick" onclick={() => lock(address)} disabled={locked !== null}>
          {#if locked === address}
            <svg class="lock" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="7" width="10" height="7" rx="1.5" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" />
            </svg>
          {/if}
          {address}
        </button>
        <button type="button" class="copy" onclick={() => copy(address)} aria-label="Copy {address}">
          {copied === address ? "Copied" : "Copy"}
        </button>
      </li>
    {/each}
  </ul>
  {#if locked}
    <p class="status">Clear the search to look up another address.</p>
  {/if}
</main>

{#if toast}
  {#key toast.id}
    <div class="toast" role="status" in:fly={{ y: 12, duration: 180 }} out:fade={{ duration: 200 }}>
      {toast.text}
    </div>
  {/key}
{/if}

<footer>
  <p>
    Addresses from <a href="https://openaddresses.io">OpenAddresses</a> and the
    <a href="https://www.transportation.gov/gis/national-address-database">National Address Database</a>
    (via <a href="https://overturemaps.org">Overture Maps</a>). Missing cities and ZIP codes are filled in
    from U.S. Census boundaries.
  </p>
  <p>
    Built from what local governments publish, so addresses aren't validated against USPS records.
    <a href="https://github.com/shivan2418/block-addresses#limits">Limits</a> ·
    <a href="https://github.com/shivan2418/block-addresses">Source</a>
  </p>
</footer>

<style>
  :global(body) {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: #fff;
    color: #1a1a1a;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  :global(#app) {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  main {
    flex: 1;
    box-sizing: border-box;
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: 38vh 16px 48px;
  }

  /* On phones the keyboard covers the lower half, where the results would be. */
  @media (max-width: 600px) {
    main {
      padding-top: 12vh;
    }
  }

  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .tagline {
    margin: 8px 0 24px;
    font-size: 15px;
    color: #777;
    text-align: center;
  }

  .box {
    position: relative;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    padding: 14px 52px 14px 22px;
    font: inherit;
    font-size: 17px;
    border: 1px solid #dcdcdc;
    border-radius: 999px;
    outline: none;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.06);
  }

  input[readonly] {
    color: #555;
  }

  .clear {
    position: absolute;
    top: 50%;
    right: 10px;
    translate: 0 -50%;
    width: 34px;
    height: 34px;
    padding: 0;
    font-size: 22px;
    line-height: 1;
    color: #888;
    background: none;
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

  .clear:hover {
    color: #1a1a1a;
    background: #f2f2f2;
  }

  input:focus {
    border-color: #b5b5b5;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.1);
  }

  ul {
    position: relative;
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    transition: opacity 0.15s;
  }

  /* A soft edge at the bottom says the list scrolls. */
  ul.more {
    mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent);
  }

  ul.loading {
    opacity: 0.5;
  }

  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 22px;
    border-radius: 12px;
  }

  li:hover,
  li.locked {
    background: #f5f5f5;
  }

  .pick {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }

  .pick:disabled {
    cursor: default;
  }

  .lock {
    flex: none;
    width: 15px;
    height: 15px;
    fill: #1a1a1a;
    stroke: #1a1a1a;
    stroke-width: 1.5;
  }

  li.locked .pick {
    font-weight: 600;
  }

  .copy {
    flex: none;
    min-width: 68px;
    padding: 5px 12px;
    font: inherit;
    font-size: 13px;
    color: #444;
    background: #fff;
    border: 1px solid #dcdcdc;
    border-radius: 999px;
    cursor: pointer;
  }

  .copy:hover {
    border-color: #aaa;
  }

  footer {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 16px 16px;
    text-align: center;
    font-size: 12px;
    line-height: 1.6;
    color: #aaa;
  }

  footer p {
    margin: 0 0 4px;
  }

  .tagline a {
    color: inherit;
  }

  footer a {
    color: inherit;
  }

  .toast {
    position: fixed;
    bottom: 32px;
    left: 50%;
    translate: -50% 0;
    padding: 9px 18px;
    font-size: 14px;
    color: #fff;
    background: #1a1a1a;
    border-radius: 999px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.15);
    white-space: nowrap;
  }

  .status {
    margin: 16px 22px 0;
    color: #888;
    font-size: 14px;
  }
</style>
