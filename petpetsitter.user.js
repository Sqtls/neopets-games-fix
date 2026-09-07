// ==UserScript==
// @name         Petpetsitter Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix petpet drop targets and mop cleaning
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=428\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=428\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g428_[^/]*\.swf(\?|$)/i;
  const XRATIO_AT = 0x47d38;
  const YRATIO_AT = 0x47d5e;
  const CLEAN_XRATIO_AT = 0x48f14;
  const CLEAN_YRATIO_AT = 0x48f3a;
  const OLD_XRATIO = [0x00, 0x00, 0xf9, 0x3f, 0x00, 0x00, 0x00, 0x00];
  const OLD_YRATIO = [0xaa, 0xaa, 0x00, 0x40, 0xab, 0xaa, 0xaa, 0xaa];
  const ONE = [0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00];

  function matches(buf, at, expected) {
    for (let i = 0; i < expected.length; i++) {
      if (buf[at + i] !== expected[i]) return false;
    }
    return true;
  }

  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    const sig = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (sig !== 'CWS' && sig !== 'FWS') return null;
    if (raw.length < 8) return null;

    let file = raw.slice();
    if (sig === 'CWS') {
      const body = await inflate(raw.subarray(8));
      file = new Uint8Array(8 + body.length);
      file.set(raw.subarray(0, 8));
      file.set(body, 8);
      file[0] = 0x46;
    }

    if (!matches(file, XRATIO_AT, OLD_XRATIO) || !matches(file, YRATIO_AT, OLD_YRATIO)
        || !matches(file, CLEAN_XRATIO_AT, OLD_XRATIO) || !matches(file, CLEAN_YRATIO_AT, OLD_YRATIO)) {
      console.warn('[sitter] unexpected coordinate code, leaving the game alone');
      return null;
    }

    file.set(ONE, XRATIO_AT);
    file.set(ONE, YRATIO_AT);
    file.set(ONE, CLEAN_XRATIO_AT);
    file.set(ONE, CLEAN_YRATIO_AT);
    console.log('[sitter] fixed drop and cleaning coordinates');
    return file;
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && input.url) {
      url = input.url;
    }

    const res = await nativeFetch.call(this, input, init);

    if (GAME_SWF.test(url)) {
      try {
        const original = await res.clone().arrayBuffer();
        const bytes = await patchGame(original);
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
        console.error('[sitter] patch failed, serving the original', e);
      }
    }
    return res;
  };
})();
