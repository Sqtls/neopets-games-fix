// ==UserScript==
// @name         Hotdog Hero Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Hotdog Hero platform collisions
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=965\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=965\b/.test(location.search)) return;

  const GAME = /\/games\/g965_v6(?:_\d+)?\.swf(?=[?#]|$)/i;
  const CLASS_NAME = new TextEncoder().encode('CollisionDetection');
  const ORIGINAL_TAG_LENGTH = 1439;
  const encoder = new TextEncoder();

  function join(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function word(value) {
    return new Uint8Array([value & 0xff, value >> 8 & 0xff]);
  }

  function readWord(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function action(opcode, data = new Uint8Array()) {
    return opcode >= 0x80
      ? join([new Uint8Array([opcode]), word(data.length), data])
      : new Uint8Array([opcode]);
  }

  const register = (number) => ({ type: 'register', number });
  const constant = (number) => ({ type: 'constant', number });
  const string = (value) => ({ type: 'string', value });

  function push(...values) {
    const encoded = values.map((value) => {
      if (value.type === 'register') return new Uint8Array([0x04, value.number]);
      if (value.type === 'constant') return new Uint8Array([0x08, value.number]);
      const text = encoder.encode(value.value);
      return join([new Uint8Array([0x00]), text, new Uint8Array([0x00])]);
    });
    return action(0x96, join(encoded));
  }

  function rootMatrixActions() {
    return join([
      push(string('_root')),
      action(0x1c),
      push(constant(19)),
      action(0x4e),
      push(constant(20)),
      action(0x4e),
      action(0x87, new Uint8Array([4])),
      action(0x17),
    ]);
  }

  function divideMember(member, rootMember) {
    return join([
      push(register(5), string(member), register(5), string(member)),
      action(0x4e),
      push(register(4), string(rootMember)),
      action(0x4e),
      action(0x0d),
      action(0x4f),
    ]);
  }

  function translateMember(member, rootScale) {
    return join([
      push(register(5), string(member), register(5), string(member)),
      action(0x4e),
      push(register(4), string(member)),
      action(0x4e),
      action(0x0b),
      push(register(4), string(rootScale)),
      action(0x4e),
      action(0x0d),
      action(0x4f),
    ]);
  }

  function normalizeMatrixActions() {
    return join([
      divideMember('a', 'a'),
      divideMember('c', 'a'),
      translateMember('tx', 'a'),
      divideMember('b', 'd'),
      divideMember('d', 'd'),
      translateMember('ty', 'd'),
    ]);
  }

  function readAction(bytes, offset) {
    const opcode = bytes[offset];
    const length = opcode >= 0x80 ? readWord(bytes, offset + 1) : 0;
    const headerLength = opcode >= 0x80 ? 3 : 1;
    return {
      opcode,
      offset,
      dataAt: offset + headerLength,
      end: offset + headerLength + length,
    };
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

  function contains(bytes, sequence) {
    return findSequence(bytes, sequence) !== -1;
  }

  function patchCollisionTag(original) {
    const tagBody = original.slice(6);
    let functionAction = null;

    for (let offset = 2; offset < tagBody.length;) {
      const current = readAction(tagBody, offset);
      if (current.opcode === 0x8e) {
        functionAction = current;
        break;
      }
      offset = current.end;
    }
    if (!functionAction) return null;

    let cursor = functionAction.dataAt;
    while (tagBody[cursor++]) {}
    const parameterCount = readWord(tagBody, cursor);
    cursor += 5;
    for (let i = 0; i < parameterCount; i++) {
      cursor++;
      while (tagBody[cursor++]) {}
    }

    const codeSizeAt = cursor;
    const codeAt = cursor + 2;
    const codeSize = readWord(tagBody, codeSizeAt);
    const codeEnd = codeAt + codeSize;
    const code = tagBody.subarray(codeAt, codeEnd);
    const firstLoad = new Uint8Array([0x96, 0x04, 0x00, 0x04, 0x0a, 0x08, 0x13, 0x4e, 0x96, 0x02, 0x00, 0x08, 0x14, 0x4e, 0x87, 0x01, 0x00, 0x05, 0x17]);
    const secondLoad = new Uint8Array([0x96, 0x04, 0x00, 0x04, 0x09, 0x08, 0x13, 0x4e, 0x96, 0x02, 0x00, 0x08, 0x14, 0x4e, 0x87, 0x01, 0x00, 0x05, 0x17]);
    const firstAt = findSequence(code, firstLoad);
    const secondAt = findSequence(code, secondLoad);
    if (firstAt === -1 || secondAt === -1) return null;

    const normalize = normalizeMatrixActions();
    const patchedCode = join([
      code.subarray(0, firstAt),
      rootMatrixActions(),
      firstLoad,
      normalize,
      code.subarray(firstAt + firstLoad.length, secondAt),
      secondLoad,
      normalize,
      code.subarray(secondAt + secondLoad.length),
    ]);
    const added = patchedCode.length - code.length;

    for (let offset = 2; offset < functionAction.offset;) {
      const current = readAction(tagBody, offset);
      if (current.opcode === 0x9d) {
        const view = new DataView(tagBody.buffer, tagBody.byteOffset + current.dataAt, 2);
        const distance = view.getInt16(0, true);
        if (current.end + distance > codeEnd) view.setInt16(0, distance + added, true);
      }
      offset = current.end;
    }

    const functionHeader = tagBody.subarray(functionAction.offset, codeSizeAt);
    const patchedBody = join([
      tagBody.subarray(0, functionAction.offset),
      functionHeader,
      word(patchedCode.length),
      patchedCode,
      tagBody.subarray(codeEnd),
    ]);
    const tagHeader = new Uint8Array(6);
    const view = new DataView(tagHeader.buffer);
    view.setUint16(0, (59 << 6) | 63, true);
    view.setUint32(2, patchedBody.length, true);
    return join([tagHeader, patchedBody]);
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

      if (code === 59 && tag.length === ORIGINAL_TAG_LENGTH && contains(tag, CLASS_NAME)) {
        const patched = patchCollisionTag(tag);
        if (!patched) return null;
        parts.push(patched);
        replacements++;
      } else {
        parts.push(tag);
      }
      offset = end;
    }

    if (replacements !== 1) {
      console.warn('[hotdog-hero] expected 1 collision class, found', replacements);
      return null;
    }

    const patchedBody = join(parts);
    const header = raw.slice(0, 8);
    new DataView(header.buffer).setUint32(4, 8 + patchedBody.length, true);
    const payload = signature === 'CWS' ? await zlib(patchedBody, 'deflate') : patchedBody;
    return join([header, payload]);
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
      console.error('[hotdog-hero] patch failed, serving the original', error);
      return response;
    }
  };
})();
