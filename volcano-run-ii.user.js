// ==UserScript==
// @name         Volcano Run II Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix the collision detection in Volcano Run II
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=761\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=761\b/.test(location.search)) return;

  const GAME = /\/games\/g761_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;
  const ORIGINAL_RATIO_TAG_LENGTH = 148;
  const encoder = new TextEncoder();
  const RATIO_POOL_PREFIX = encoder.encode('_root\0_level0\0_global\0ratioX_num\0ratioY_num\0');
  const RATIO_X_TWO = new Uint8Array([
    0x96, 0x07, 0x00, 0x08, 0x03, 0x07, 0x02, 0x00, 0x00, 0x00,
  ]);
  const RATIO_Y_TWO = new Uint8Array([
    0x96, 0x07, 0x00, 0x08, 0x04, 0x07, 0x02, 0x00, 0x00, 0x00,
  ]);

  function readWord(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function findSequence(bytes, sequence) {
    outer: for (let i = 0; i <= bytes.length - sequence.length; i++) {
      for (let j = 0; j < sequence.length; j++) {
        if (bytes[i + j] !== sequence[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function patchRatioTag(original) {
    const patched = original.slice();
    const ratioXAt = findSequence(patched, RATIO_X_TWO);
    const ratioYAt = findSequence(patched, RATIO_Y_TWO);
    if (ratioXAt === -1 || ratioYAt === -1) return null;

    patched[ratioXAt + 6] = 1;
    patched[ratioYAt + 6] = 1;
    return patched;
  }

  async function zlib(data, mode) {
    const stream = new Blob([data]).stream().pipeThrough(
      mode === 'inflate'
        ? new DecompressionStream('deflate')
        : new CompressionStream('deflate')
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    const signature = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (signature !== 'CWS' && signature !== 'FWS') return null;

    const body = signature === 'CWS' ? await zlib(raw.slice(8), 'inflate') : raw.slice(8);
    const nbits = body[0] >> 3;
    const tagsAt = Math.ceil((5 + 4 * nbits) / 8) + 4;
    const parts = [body.subarray(0, tagsAt)];
    let replacements = 0;

    for (let offset = tagsAt; offset < body.length;) {
      const value = readWord(body, offset);
      const code = value >> 6;
      const shortLength = value & 63;
      const headerLength = shortLength === 63 ? 6 : 2;
      const length = shortLength === 63
        ? new DataView(body.buffer, body.byteOffset + offset + 2, 4).getUint32(0, true)
        : shortLength;
      const end = offset + headerLength + length;
      const tag = body.subarray(offset, end);

      if (
        code === 12
        && tag.length === ORIGINAL_RATIO_TAG_LENGTH
        && findSequence(tag, RATIO_POOL_PREFIX) !== -1
      ) {
        const patched = patchRatioTag(tag);
        if (!patched) return null;
        parts.push(patched);
        replacements++;
      } else {
        parts.push(tag);
      }
      offset = end;
    }

    if (replacements !== 1) {
      console.warn('[volcano-run-ii] expected one collision ratio script, found', replacements);
      return null;
    }

    const patchedBody = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let outputAt = 0;
    for (const part of parts) {
      patchedBody.set(part, outputAt);
      outputAt += part.length;
    }

    const header = raw.slice(0, 8);
    const payload = signature === 'CWS' ? await zlib(patchedBody, 'deflate') : patchedBody;
    const output = new Uint8Array(header.length + payload.length);
    output.set(header);
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
      console.error('[volcano-run-ii] patch failed, serving the original', error);
      return response;
    }
  };
})();
