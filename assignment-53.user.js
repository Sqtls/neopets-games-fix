// ==UserScript==
// @name         Assignment 53 Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix assignment 53's HTTPS server detection so it loads its config from the right host
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=1347\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=1347\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g1347_v66(?:_\d+)?\.swf(?=[?#]|$)/i;
  const SERVER_TAG_AT = 0xd9c5b;
  const SERVERS_AT = 0xdcd12;
  const encoder = new TextEncoder();
  const OLD_SERVERS = encoder.encode('\x19http://images.neopets.com\x11SCRIPT_SERVER_DEV\x16http://dev.neopets.com\x12SCRIPT_SERVER_LIVE\x16http://www.neopets.com');
  const NEW_SERVERS = encoder.encode('\x1ahttps://images.neopets.com\x11SCRIPT_SERVER_DEV\x16http://dev.neopets.com\x12SCRIPT_SERVER_LIVE\x17https://www.neopets.com');

  function matches(buf, at, expected) {
    for (let i = 0; i < expected.length; i++) {
      if (buf[at + i] !== expected[i]) return false;
    }
    return true;
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

    if (!matches(file, SERVER_TAG_AT, [0xbf, 0x14, 0xbf, 0xaa, 0x04, 0x00]) ||
        !matches(file, SERVERS_AT, OLD_SERVERS)) {
      console.warn('[a53] unexpected server config, leaving the game alone');
      return null;
    }

    const patched = new Uint8Array(file.length + 2);
    patched.set(file.subarray(0, SERVERS_AT));
    patched.set(NEW_SERVERS, SERVERS_AT);
    patched.set(file.subarray(SERVERS_AT + OLD_SERVERS.length), SERVERS_AT + NEW_SERVERS.length);
    patched[0] = 0x46;
    const view = new DataView(patched.buffer);
    view.setUint32(4, patched.length, true);
    view.setUint32(SERVER_TAG_AT + 2, 305857, true);
    console.log('[a53] fixed HTTPS server detection');
    return patched;
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const res = await nativeFetch.call(this, input, init);
    if (!GAME_SWF.test(url) || location.protocol === 'http:') return res;

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
      console.error('[a53] patch failed, serving the original', e);
    }
    return res;
  };
})();
