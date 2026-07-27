import { describe, expect, it } from 'vitest';
import { lintGeneratedFile } from './lintGenerated.js';

const msgs = (path: string, content: string): string[] =>
  lintGeneratedFile(path, content).map((w) => w.message);

describe('lintGeneratedFile — JS accident detection', () => {
  it('clean sandbox-correct code produces no warnings', () => {
    const good = `
      const G = window.__GENESIS__;
      async function load() {
        const res = await fetch(G.proxyUrl + '/contacts/search', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + G.token },
          body: JSON.stringify({ pageLimit: 20 }),
        });
        const data = await res.json();
        document.querySelector('#list').textContent = data.total;
      }
      load();
    `;
    expect(msgs('app.js', good)).toEqual([]);
  });

  it('flags eval and new Function', () => {
    expect(msgs('a.js', 'eval("1+1")')[0]).toMatch(/eval/);
    expect(msgs('b.js', 'const f = new Function("return 1")')[0]).toMatch(/Function/);
  });

  it('flags external fetch, WebSocket, EventSource, XHR, sendBeacon', () => {
    expect(msgs('a.js', 'fetch("https://api.example.com/x")')[0]).toMatch(/external URL/);
    expect(msgs('b.js', 'new WebSocket("wss://x")')[0]).toMatch(/WebSocket/);
    expect(msgs('c.js', 'new EventSource("/s")')[0]).toMatch(/EventSource/);
    expect(msgs('d.js', 'const x = new XMLHttpRequest()')[0]).toMatch(/XMLHttpRequest/);
    expect(msgs('e.js', 'navigator.sendBeacon("https://x", "d")')[0]).toMatch(/sendBeacon/);
  });

  it('flags sandbox-escape probes (window.parent / window.top)', () => {
    expect(msgs('a.js', 'window.parent.postMessage("x", "*")')[0]).toMatch(/window.parent/);
    expect(msgs('b.js', 'globalThis.top.location.href')[0]).toMatch(/window.top/);
  });

  it('does not flag an ordinary variable named parent', () => {
    expect(msgs('a.js', 'const parent = getNode(); parent.appendChild(el);')).toEqual([]);
  });

  it('flags storage APIs that do not exist in the sandbox', () => {
    expect(msgs('a.js', 'localStorage.setItem("k", "v")')[0]).toMatch(/localStorage/);
    expect(msgs('b.js', 'window.sessionStorage.clear()')[0]).toMatch(/sessionStorage/);
    expect(msgs('c.js', 'indexedDB.open("db")')[0]).toMatch(/indexedDB/);
  });

  it('reports a syntax error as the primary warning', () => {
    const out = msgs('broken.js', 'function ( {');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/does not parse/);
  });

  it('deduplicates repeated findings of the same kind', () => {
    const out = msgs('a.js', 'eval("1"); eval("2"); eval("3");');
    expect(out).toHaveLength(1);
  });
});

describe('lintGeneratedFile — HTML external references', () => {
  it('flags external scripts/styles/images by host, once per host', () => {
    const html = `
      <script src="https://cdn.example.com/lib.js"></script>
      <link href="https://cdn.example.com/style.css" rel="stylesheet">
      <img src="https://images.example.org/pic.png">
    `;
    const out = msgs('index.html', html);
    expect(out).toHaveLength(2); // cdn.example.com deduped, images.example.org
    expect(out.join(' ')).toMatch(/cdn.example.com/);
    expect(out.join(' ')).toMatch(/images.example.org/);
  });

  it('ignores local and data: references', () => {
    const html = `<script src="./app.js"></script><img src="data:image/png;base64,x">`;
    expect(msgs('index.html', html)).toEqual([]);
  });

  it('does not lint css/json/svg', () => {
    expect(msgs('style.css', 'body{background:url(https://x.com/a.png)}')).toEqual([]);
  });
});
