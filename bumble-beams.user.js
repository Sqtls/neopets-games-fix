// ==UserScript==
// @name         Bubble Beams Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix the petpets falling/warping through the beams
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=799\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=799\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g799_v15(?:_\d+)?\.swf(?=[?#]|$)/i;

  const RATIO_MUL_AT = [0x10fbb7, 0x10fbce, 0x10fda7, 0x10fdbe, 0x10fdea, 0x10fe01];

  const OLD_RATIO_MUL = [
    [0x96, 0x04, 0x00, 0x04, 0x02, 0x08, 0xe6, 0x4e, 0x0c],
    [0x96, 0x04, 0x00, 0x04, 0x02, 0x08, 0xe7, 0x4e, 0x0c],
  ];
  const NOP9 = [0x96, 0x00, 0x00, 0x96, 0x00, 0x00, 0x96, 0x00, 0x00];

  const HIT_SHAPE_AT = 0xee298;
  const OLD_HIT_SHAPE = hex(
    '3f0837000000b6004e30d77c4a800100ffffff000010153fcbe655dfd02a950a90' +
    '0ea500eefa997029a4025a20305796fd70116501190d7950565e0400');
  const NEW_HIT_SHAPE = hex(
    '3f081f000000b6005f8c0d7df19e000100ffffff0000101538cbe771bfcaf037243cb10000');

  function hex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
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

    for (let i = 0; i < RATIO_MUL_AT.length; i++) {
      if (!matches(file, RATIO_MUL_AT[i], OLD_RATIO_MUL[i % 2])) {
        console.warn('[bubble] unexpected collision code, leaving the game alone');
        return null;
      }
    }
    if (!matches(file, HIT_SHAPE_AT, OLD_HIT_SHAPE)) {
      console.warn('[bubble] unexpected beam shape, leaving the game alone');
      return null;
    }
    for (const at of RATIO_MUL_AT) file.set(NOP9, at);

    const out = new Uint8Array(file.length - OLD_HIT_SHAPE.length + NEW_HIT_SHAPE.length);
    out.set(file.subarray(0, HIT_SHAPE_AT));
    out.set(NEW_HIT_SHAPE, HIT_SHAPE_AT);
    out.set(file.subarray(HIT_SHAPE_AT + OLD_HIT_SHAPE.length), HIT_SHAPE_AT + NEW_HIT_SHAPE.length);
    new DataView(out.buffer).setUint32(4, out.length, true);
    console.log('[bubble] fixed collision coordinates and beam thickness');
    return out;
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
      console.error('[bubble] patch failed, serving the original', e);
    }
    return res;
  };
})();
