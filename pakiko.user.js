// ==UserScript==
// @name         Pakiko Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Pakikos config URL and HTTPS server detection
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=1369\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=1369\b/.test(location.search)) return;

  const CONFIG_URL = /^https?:\/\/www\.neopets\.com\/games\/g1369_v8\/shellconfig\.xml(?=[?#]|$)/;
  const CORRECT_URL = 'https://images.neopets.com/games/g1369_v8/shellconfig.xml';
  const GAME_SWF = /\/games\/g1369_v8(?:_\d+)?\.swf(?=[?#]|$)/i;
  const SERVER_TAG_AT = 0x160e3;
  const SERVERS_AT = 0x162a1;
  const encoder = new TextEncoder();
  const OLD_SERVERS = encoder.encode('\x16http://www.neopets.com\x19http://images.neopets.com');
  const NEW_SERVERS = encoder.encode('\x17https://www.neopets.com\x1ahttps://images.neopets.com');

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

    if (!matches(file, SERVER_TAG_AT, [0xbf, 0x14, 0x9d, 0x04, 0x00, 0x00]) ||
        !matches(file, SERVERS_AT, OLD_SERVERS)) {
      console.warn('[pakiko] unexpected server config, leaving the game alone');
      return null;
    }

    const patched = new Uint8Array(file.length + 2);
    patched.set(file.subarray(0, SERVERS_AT));
    patched.set(NEW_SERVERS, SERVERS_AT);
    patched.set(file.subarray(SERVERS_AT + OLD_SERVERS.length), SERVERS_AT + NEW_SERVERS.length);
    patched[0] = 0x46;
    const view = new DataView(patched.buffer);
    view.setUint32(4, patched.length, true);
    view.setUint32(SERVER_TAG_AT + 2, 1183, true);
    console.log('[pakiko] fixed HTTPS server detection');
    return patched;
  }

  function fix(url) {
    if (typeof url !== 'string') return url;
    return url.replace(CONFIG_URL, CORRECT_URL);
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    if (typeof input === 'string') input = fix(input);
    else if (input && input.url) {
      const fixed = fix(input.url);
      if (fixed !== input.url) input = new Request(fixed, input);
    }
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
      console.error('[pakiko] patch failed, serving the original', e);
    }
    return res;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeOpen.call(this, method, fix(url), ...rest);
  };
})();
