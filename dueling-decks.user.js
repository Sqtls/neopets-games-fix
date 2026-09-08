// ==UserScript==
// @name         Dueling Decks Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix dueling decks freezing between rounds and on opponent turns
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=1182\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=1182\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g1182_v9(?:_\d+)?\.swf(?=[?#]|$)/i;

  const HANDLERS = [
    {
      old: hex('d030d066a40520130a0000d04fa40500d02068a4055d9a034f9a030047'),
      replacement: hex('d0305d9a034f9a0300d066a40520130a0000d04fa40500d02068a40547'),
    },
    {
      old: hex('d030d066ad0520130a0000d04fad0500d02068ad055d9a034f9a030047'),
      replacement: hex('d0305d9a034f9a0300d066ad0520130a0000d04fad0500d02068ad0547'),
    },
    {
      old: hex('d030d066a60520130a0000d04fa60500d02068a6055d9a034f9a030047'),
      replacement: hex('d0305d9a034f9a0300d066a60520130a0000d04fa60500d02068a60547'),
    },
  ];

  function hex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function findAll(buf, pattern) {
    const hits = [];
    outer: for (let i = 0; i <= buf.length - pattern.length; i++) {
      for (let j = 0; j < pattern.length; j++) {
        if (buf[i + j] !== pattern[j]) continue outer;
      }
      hits.push(i);
    }
    return hits;
  }

  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    if (raw.length < 8) return null;

    const sig = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (sig !== 'CWS' && sig !== 'FWS') return null;

    let file = raw.slice();
    if (sig === 'CWS') {
      const body = await inflate(raw.subarray(8));
      file = new Uint8Array(8 + body.length);
      file.set(raw.subarray(0, 8));
      file.set(body, 8);
      file[0] = 0x46;
    }

    const offsets = [];
    for (const handler of HANDLERS) {
      const hits = findAll(file, handler.old);
      if (hits.length !== 1) {
        console.warn('[dueling-decks] expected one animation handler, found', hits.length,
          '- leaving the game alone');
        return null;
      }
      offsets.push(hits[0]);
    }

    for (let i = 0; i < HANDLERS.length; i++) {
      file.set(HANDLERS[i].replacement, offsets[i]);
    }
    console.log('[dueling-decks] fixed animation callback ordering');
    return file;
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await nativeFetch.call(this, input, init);
    if (!GAME_SWF.test(url)) return res;

    try {
      const bytes = await patchGame(await res.clone().arrayBuffer());
      if (bytes) {
        const out = new Response(bytes, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/x-shockwave-flash' },
        });
        Object.defineProperty(out, 'url', { value: res.url || url });
        return out;
      }
    } catch (e) {
      console.error('[dueling-decks] patch failed, serving the original', e);
    }
    return res;
  };
})();
