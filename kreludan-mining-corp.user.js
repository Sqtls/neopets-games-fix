// ==UserScript==
// @name         Kreludan Mining Corp Fix
// @namespace    Squirtle @ Clraik
// @version      1.1
// @description  Fix the ship, camera, and collision coordinates in Kreludan Mining Corp under Ruffle
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=404\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=404\b/.test(location.search)) return;

  const GAME = /\/games\/g404_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;
  const ORIGINAL_SHIP_TAG_LENGTH = 4930;
  const ORIGINAL_GAME_TAG_LENGTH = 13744;
  const encoder = new TextEncoder();
  const SHIP_POOL_PREFIX = encoder.encode('Ship\0vel\0x\0y\0');
  const GAME_POOL_PREFIX = encoder.encode('_global\0Game\0myLives\0');
  const CONSTRUCTOR_END = new Uint8Array([
    0x96, 0x08, 0x00, 0x04, 0x01, 0x08, 0x09,
    0x04, 0x01, 0x08, 0x0a, 0x4e, 0x4f,
  ]);
  const LOCAL_TO_GLOBAL_END = new Uint8Array([
    0x96, 0x0b, 0x00, 0x04, 0x02, 0x07, 0x01, 0x00, 0x00,
    0x00, 0x04, 0x04, 0x08, 0xa3, 0x52, 0x17,
  ]);

  function join(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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
  const string = (value) => ({ type: 'string', value });
  const boolean = (value) => ({ type: 'boolean', value });
  const nullValue = () => ({ type: 'null' });
  const double = (value) => ({ type: 'double', value });

  function push(...values) {
    return action(0x96, join(values.map((value) => {
      if (value.type === 'register') return new Uint8Array([0x04, value.number]);
      if (value.type === 'boolean') return new Uint8Array([0x05, Number(value.value)]);
      if (value.type === 'null') return new Uint8Array([0x02]);
      if (value.type === 'double') {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value.value, true);
        return join([new Uint8Array([0x06]), bytes.subarray(4), bytes.subarray(0, 4)]);
      }
      return join([
        new Uint8Array([0x00]),
        encoder.encode(value.value),
        new Uint8Array([0x00]),
      ]);
    })));
  }

  function markerGuardActions() {
    const disableMarker = join([
      push(register(1), string('_visible'), boolean(false)),
      action(0x4f),
      push(register(1), string('onEnterFrame'), nullValue()),
      action(0x4f),
    ]);

    return join([
      push(register(1), string('_name')),
      action(0x4e),
      push(string('ship_marker')),
      action(0x49),
      action(0x12),
      action(0x9d, word(disableMarker.length)),
      disableMarker,
    ]);
  }

  function collisionScaleActions() {
    return join([
      push(register(2), string('x'), register(2), string('x')),
      action(0x4e),
      push(double(0.6)),
      action(0x0c),
      action(0x4f),
      push(register(2), string('y'), register(2), string('y')),
      action(0x4e),
      push(double(0.4)),
      action(0x0c),
      action(0x4f),
    ]);
  }

  function readAction(bytes, offset) {
    const opcode = bytes[offset];
    const dataLength = opcode >= 0x80 ? readWord(bytes, offset + 1) : 0;
    const headerLength = opcode >= 0x80 ? 3 : 1;
    return {
      opcode,
      offset,
      dataAt: offset + headerLength,
      end: offset + headerLength + dataLength,
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

  function patchShipTag(original) {
    const tagBody = original.slice(6);
    const constructorEndAt = findSequence(tagBody, CONSTRUCTOR_END);
    if (constructorEndAt === -1) return null;

    const insertAt = constructorEndAt + CONSTRUCTOR_END.length;
    let constructorSizeAt = -1;

    for (let offset = 2; offset < insertAt;) {
      const current = readAction(tagBody, offset);
      if (current.opcode === 0x8e) {
        const codeSize = readWord(tagBody, current.end - 2);
        if (current.end + codeSize === insertAt) constructorSizeAt = current.end - 2;
      }
      offset = current.end;
    }
    if (constructorSizeAt === -1) return null;

    const guard = markerGuardActions();
    const oldCodeSize = readWord(tagBody, constructorSizeAt);
    tagBody.set(word(oldCodeSize + guard.length), constructorSizeAt);

    for (let offset = 2; offset < insertAt;) {
      const current = readAction(tagBody, offset);
      if (current.opcode === 0x99 || current.opcode === 0x9d) {
        const view = new DataView(tagBody.buffer, tagBody.byteOffset + current.dataAt, 2);
        const distance = view.getInt16(0, true);
        if (current.end + distance >= insertAt) view.setInt16(0, distance + guard.length, true);
      }
      offset = current.end;
    }

    const patchedBody = join([
      tagBody.subarray(0, insertAt),
      guard,
      tagBody.subarray(insertAt),
    ]);
    const tagHeader = new Uint8Array(6);
    const view = new DataView(tagHeader.buffer);
    view.setUint16(0, (59 << 6) | 63, true);
    view.setUint32(2, patchedBody.length, true);
    return join([tagHeader, patchedBody]);
  }

  function patchGameTag(original) {
    const tagBody = original.slice(6);
    const localToGlobalAt = findSequence(tagBody, LOCAL_TO_GLOBAL_END);
    if (localToGlobalAt === -1) return null;

    const insertAt = localToGlobalAt + LOCAL_TO_GLOBAL_END.length;
    const correction = collisionScaleActions();
    let functionCount = 0;

    for (let offset = 2; offset < tagBody.length;) {
      const current = readAction(tagBody, offset);
      if (current.opcode === 0x8e) {
        const sizeAt = current.end - 2;
        const codeSize = readWord(tagBody, sizeAt);
        if (current.end <= insertAt && current.end + codeSize >= insertAt) {
          tagBody.set(word(codeSize + correction.length), sizeAt);
          functionCount++;
        }
      }

      if (current.opcode === 0x99 || current.opcode === 0x9d) {
        const view = new DataView(tagBody.buffer, tagBody.byteOffset + current.dataAt, 2);
        const distance = view.getInt16(0, true);
        const target = current.end + distance;
        if (current.end <= insertAt && target > insertAt) {
          view.setInt16(0, distance + correction.length, true);
        } else if (current.offset >= insertAt && target < insertAt) {
          view.setInt16(0, distance - correction.length, true);
        }
      }
      offset = current.end;
    }
    if (functionCount !== 1) return null;

    const patchedBody = join([
      tagBody.subarray(0, insertAt),
      correction,
      tagBody.subarray(insertAt),
    ]);
    const tagHeader = new Uint8Array(6);
    const view = new DataView(tagHeader.buffer);
    view.setUint16(0, (59 << 6) | 63, true);
    view.setUint32(2, patchedBody.length, true);
    return join([tagHeader, patchedBody]);
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
    let shipReplacements = 0;
    let gameReplacements = 0;

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
        code === 59
        && tag.length === ORIGINAL_SHIP_TAG_LENGTH
        && findSequence(tag, SHIP_POOL_PREFIX) !== -1
      ) {
        const patched = patchShipTag(tag);
        if (!patched) return null;
        parts.push(patched);
        shipReplacements++;
      } else if (
        code === 59
        && tag.length === ORIGINAL_GAME_TAG_LENGTH
        && findSequence(tag, GAME_POOL_PREFIX) !== -1
      ) {
        const patched = patchGameTag(tag);
        if (!patched) return null;
        parts.push(patched);
        gameReplacements++;
      } else {
        parts.push(tag);
      }
      offset = end;
    }

    if (shipReplacements !== 1 || gameReplacements !== 1) {
      console.warn(
        '[kreludan-mining-corp] expected one Ship and Game class, found',
        shipReplacements,
        gameReplacements
      );
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
      console.error('[kreludan-mining-corp] patch failed, serving the original', error);
      return response;
    }
  };
})();
