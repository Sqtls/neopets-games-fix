// ==UserScript==
// @name         Coal War Tactics Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Coal War Tactics so it loads over HTTPS and its battle board arms
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=1370\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=1370\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g1370_v2(?:_\d+)?\.swf(?=[?#]|$)/i;
  const CONFIG_XML = /\/games\/g1370_v\d+\/config\.xml(?=[?#]|$)/i;
  const SERVER_TAG_AT = 0x11b012;
  const IMAGE_SERVER_AT = 0x11b2f4;
  const SCRIPT_SERVER_AT = 0x11b32d;
  const encoder = new TextEncoder();
  const OLD_IMAGE_SERVER = encoder.encode('\x19http://images.neopets.com');
  const NEW_IMAGE_SERVER = encoder.encode('\x1ahttps://images.neopets.com');
  const OLD_SCRIPT_SERVER = encoder.encode('\x16http://www.neopets.com');
  const NEW_SCRIPT_SERVER = encoder.encode('\x17https://www.neopets.com');

  function matches(buf, at, expected) {
    for (let i = 0; i < expected.length; i++) {
      if (buf[at + i] !== expected[i]) return false;
    }
    return true;
  }

  function replace(buf, at, oldBytes, newBytes) {
    const patched = new Uint8Array(buf.length + newBytes.length - oldBytes.length);
    patched.set(buf.subarray(0, at));
    patched.set(newBytes, at);
    patched.set(buf.subarray(at + oldBytes.length), at + newBytes.length);
    return patched;
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

    if (!matches(file, SERVER_TAG_AT, [0xbf, 0x14, 0x77, 0x06, 0x00, 0x00]) ||
        !matches(file, IMAGE_SERVER_AT, OLD_IMAGE_SERVER) ||
        !matches(file, SCRIPT_SERVER_AT, OLD_SCRIPT_SERVER)) {
      console.warn('[coal-war-tactics] unexpected server config, leaving the game alone');
      return null;
    }

    let patched = new Uint8Array(file);
    patched = replace(patched, SCRIPT_SERVER_AT, OLD_SCRIPT_SERVER, NEW_SCRIPT_SERVER);
    patched = replace(patched, IMAGE_SERVER_AT, OLD_IMAGE_SERVER, NEW_IMAGE_SERVER);
    patched[0] = 0x46;
    const view = new DataView(patched.buffer);
    view.setUint32(4, patched.length, true);
    view.setUint32(SERVER_TAG_AT + 2, 1657, true);
    console.log('[coal-war-tactics] fixed HTTPS server detection');
    return patched;
  }

  function methodOf(input, init) {
    if (init && init.method) return init.method;
    if (typeof input === 'object' && input && input.method) return input.method;
    return 'GET';
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;

    if (url && CONFIG_XML.test(url) && methodOf(input, init).toUpperCase() !== 'GET') {
      console.log('[coal-war-tactics] forcing GET for gameplay config');
      return nativeFetch.call(this, url, { method: 'GET', credentials: 'omit' });
    }

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
      console.error('[coal-war-tactics] patch failed, serving the original', e);
    }
    return res;
  };
})();
