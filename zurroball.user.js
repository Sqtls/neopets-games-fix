// ==UserScript==
// @name         Zurroball Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Make the ball clickable in zurroball.
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=207\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=207\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g207_[^/]*\.swf(\?|$)/i;

  const FILE_LEN = 307519;
  const XRATIO_AT = 0x3e64c; // push double 1.6666666666666667
  const YRATIO_AT = 0x3e661; // push double 2.5
  const PRESS_AT = 0x25dc3; // first on(press) action of DefineButton2 62
  const DOACTION_LEN_AT = 0x47110; // u32 length of the bigbuttonpress DoAction
  const DOACTION_LEN = 521;
  const INSERT_AT = 0x4731c; // its End action, listener goes in front

  // SWF doubles store the high word first
  const OLD_XRATIO = hex('aaaafa3fabaaaaaa');
  const OLD_YRATIO = hex('0000044000000000');
  const ONE = hex('0000f03f00000000');

  // _root.onMouseDown = _root.bigbuttonpress;
  const LISTENER = hex(
    '960700005f726f6f74001c960d00006f6e4d6f757365446f776e00' +
    '960700005f726f6f74001c96100000626967627574746f6e7072657373004e4f'
  );

  function hex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function u32(buf, at) {
    return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24);
  }

  function putU32(buf, at, value) {
    buf[at] = value & 0xff;
    buf[at + 1] = (value >> 8) & 0xff;
    buf[at + 2] = (value >> 16) & 0xff;
    buf[at + 3] = (value >>> 24) & 0xff;
  }

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

  async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    const sig = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (sig !== 'CWS' && sig !== 'FWS') return null;

    let file = raw;
    if (sig === 'CWS') {
      const body = await inflate(raw.subarray(8));
      file = new Uint8Array(8 + body.length);
      file.set(raw.subarray(0, 8));
      file.set(body, 8);
    } else {
      file = raw.slice();
    }

    if (file.length !== FILE_LEN
        || !matches(file, XRATIO_AT, OLD_XRATIO)
        || !matches(file, YRATIO_AT, OLD_YRATIO)
        || file[PRESS_AT] !== 0x96
        || u32(file, DOACTION_LEN_AT) !== DOACTION_LEN
        || file[INSERT_AT] !== 0x00) {
      return null;
    }

    file.set(ONE, XRATIO_AT);
    file.set(ONE, YRATIO_AT);
    file[PRESS_AT] = 0x00; // End action, the button now does nothing
    putU32(file, DOACTION_LEN_AT, DOACTION_LEN + LISTENER.length);

    const out = new Uint8Array(file.length + LISTENER.length);
    out.set(file.subarray(0, INSERT_AT));
    out.set(LISTENER, INSERT_AT);
    out.set(file.subarray(INSERT_AT), INSERT_AT + LISTENER.length);
    putU32(out, 4, out.length);
    console.log('[zurroball] patched mouse ratios and installed the click listener');

    if (sig !== 'CWS') return out;

    const compressed = await deflate(out.subarray(8));
    const result = new Uint8Array(8 + compressed.length);
    result.set(out.subarray(0, 8));
    result.set(compressed, 8);
    return result;
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
        console.error('[zurroball] patch failed, serving the original', e);
      }
    }
    return res;
  };
})();
