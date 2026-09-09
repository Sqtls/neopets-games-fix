// ==UserScript==
// @name         Cooty Wars Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Cooty Wars so shots register
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=796\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=796\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g796_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;

  const X_RATIO = [0x96, 0x09, 0x00, 0x04, 0x01, 0x08, 0x02, 0x07, 0x02, 0x00, 0x00, 0x00, 0x4f];
  const Y_RATIO = [0x96, 0x09, 0x00, 0x04, 0x01, 0x08, 0x03, 0x07, 0x02, 0x00, 0x00, 0x00, 0x4f];
  const VALUE_INDEX = 8;

  function findUnique(buf, sig) {
    let found = -1;
    outer: for (let i = 0; i <= buf.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) {
        if (buf[i + j] !== sig[j]) continue outer;
      }
      if (found !== -1) return -1;
      found = i;
    }
    return found;
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

    const body = sig === 'CWS' ? await inflate(raw.subarray(8)) : raw.subarray(8);
    const file = new Uint8Array(8 + body.length);
    file.set(raw.subarray(0, 8));
    file.set(body, 8);

    const xAt = findUnique(file, X_RATIO);
    const yAt = findUnique(file, Y_RATIO);
    if (xAt === -1 || yAt === -1) {
      console.warn('[cooty-wars] ratio code not found as expected, leaving the game alone');
      return null;
    }

    file[xAt + VALUE_INDEX] = 0x01;
    file[yAt + VALUE_INDEX] = 0x01;
    file[0] = 0x46;
    new DataView(file.buffer).setUint32(4, file.length, true);
    console.log('[cooty-wars] shots fixed (mouse ratio forced to 1)');
    return file;
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
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
      console.error('[cooty-wars] patch failed, serving the original', e);
    }
    return res;
  };
})();
