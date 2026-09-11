// ==UserScript==
// @name         Ultimate Bullseye II Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix arrow/board collision and powerup select
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=903\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=903\b/.test(location.search)) return;

  const GAME = /\/g903_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;

  const hex = (s) => Uint8Array.from(s.replace(/\s/g, '').match(/../g).map((b) => parseInt(b, 16)));

  const RATIO_PATCHES = [
    { find: hex('06 0000f43f 00000000'), repl: hex('06 0000f03f 00000000') },
    { find: hex('06 aaaafa3f abaaaaaa'), repl: hex('06 0000f03f 00000000') },
  ];

  const KEYCHECK_FIND = hex(
    '960b00 06 0000000000000000 0850 1c 9602000895 52' +
    '960700 0701000000 0850 1c 9602000851 52' +
    '12'
  );
  const KEYCHECK_REPL = hex(
    '960400 0500 0850 1c 9602000895 52' +
    '4c 4c' +
    '960700 0701000000 0850 1c 9602000851 52' +
    '0c 4d 51 0c 4a' +
    '12'
  );

  function replaceAll(buf, find, repl) {
    if (find.length !== repl.length) throw new Error('patch length mismatch');
    let count = 0;
    outer: for (let i = 0; i <= buf.length - find.length; i++) {
      for (let j = 0; j < find.length; j++) if (buf[i + j] !== find[j]) continue outer;
      buf.set(repl, i);
      count++;
      i += find.length - 1;
    }
    return count;
  }

  async function zlib(data, mode) {
    const stream = new Blob([data]).stream().pipeThrough(
      mode === 'inflate' ? new DecompressionStream('deflate') : new CompressionStream('deflate')
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    const signature = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (signature !== 'CWS' && signature !== 'FWS') return null;

    const body = signature === 'CWS' ? await zlib(raw.slice(8), 'inflate') : raw.slice(8);

    const ratio1 = replaceAll(body, RATIO_PATCHES[0].find, RATIO_PATCHES[0].repl);
    const ratio2 = replaceAll(body, RATIO_PATCHES[1].find, RATIO_PATCHES[1].repl);
    const keyCheck = replaceAll(body, KEYCHECK_FIND, KEYCHECK_REPL);

    if (ratio1 !== 1 || ratio2 !== 1 || keyCheck !== 3) {
      console.warn('[g903] unexpected patch counts', { ratio1, ratio2, keyCheck });
      return null;
    }

    const header = raw.slice(0, 8);
    const payload = signature === 'CWS' ? await zlib(body, 'deflate') : body;
    const output = new Uint8Array(header.length + payload.length);
    output.set(header, 0);
    output.set(payload, header.length);
    return output;
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await nativeFetch.call(this, input, init);
    if (!GAME.test(url)) return response;

    try {
      const patched = await patchGame(await response.clone().arrayBuffer());
      if (!patched) return response;
      const output = new Response(patched, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/x-shockwave-flash' },
      });
      Object.defineProperty(output, 'url', { value: response.url || url });
      return output;
    } catch (error) {
      console.error('[g903] patch failed, serving the original', error);
      return response;
    }
  };
})();
