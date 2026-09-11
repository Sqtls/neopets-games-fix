// ==UserScript==
// @name         Whirlpool Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix the misplaced shell and hazard hitboxes
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=927\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=927\b/.test(location.search)) return;

  const GAME = /\/games\/g927_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;
  const COLLISION_TAG_LENGTH = 1691;
  const Y_RATIO_DIVIDE = new Uint8Array([0x96, 0x02, 0x00, 0x08, 0x0e, 0x1c, 0x0d]);
  const X_RATIO_DIVIDE = new Uint8Array([0x96, 0x02, 0x00, 0x08, 0x0f, 0x1c, 0x0d]);

  const DIVIDE_BY_ONE = new Uint8Array([0x96, 0x02, 0x00, 0x05, 0x01, 0x4a, 0x0d]);

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

  function replaceAll(bytes, sequence, replacement) {
    let count = 0;
    for (let at = findSequence(bytes, sequence); at !== -1; at = findSequence(bytes, sequence)) {
      bytes.set(replacement, at);
      count++;
    }
    return count;
  }

  function patchCollisionTag(original) {
    const patched = original.slice();
    const yReplacements = replaceAll(patched, Y_RATIO_DIVIDE, DIVIDE_BY_ONE);
    const xReplacements = replaceAll(patched, X_RATIO_DIVIDE, DIVIDE_BY_ONE);
    if (xReplacements !== 2 || yReplacements !== 2) return null;
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

      if (code === 12 && tag.length === COLLISION_TAG_LENGTH) {
        const patched = patchCollisionTag(tag);
        if (patched) {
          parts.push(patched);
          replacements++;
        } else {
          parts.push(tag);
        }
      } else {
        parts.push(tag);
      }
      offset = end;
    }

    if (replacements !== 1) {
      console.warn('[whirlpool] expected one collision script, found', replacements);
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
      console.error('[whirlpool] patch failed, serving the original', error);
      return response;
    }
  };
})();
