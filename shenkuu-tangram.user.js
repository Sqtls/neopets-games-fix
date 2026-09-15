// ==UserScript==
// @name         Shenkuu Tangram Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix keyboard piece controls
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=1075\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
  'use strict';

  if (!/[?&]game_id=1075\b/.test(location.search)) return;

  const GAME = /\/games\/g1075_v\d+(?:_\d+)?\.swf(?=[?#]|$)/i;
  const decoder = new TextDecoder();

  function join(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  const readWord = (b, o) => b[o] | (b[o + 1] << 8);
  const readDword = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true);

  function encodeU30(value) {
    const out = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value) byte |= 0x80;
      out.push(byte);
    } while (value);
    return out;
  }

  class Reader {
    constructor(bytes) {
      this.bytes = bytes;
      this.at = 0;
    }
    u8() { return this.bytes[this.at++]; }
    u16() { const v = readWord(this.bytes, this.at); this.at += 2; return v; }
    u30() {
      let result = 0, shift = 0, byte;
      do { byte = this.bytes[this.at++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
      return result >>> 0;
    }
    skip(count) { this.at += count; }
  }

  function u30ByteLength(bytes, pos) {
    let length = 0;
    while (bytes[pos + length] & 0x80) length++;
    return length + 1;
  }

  function parseAbc(abc) {
    const r = new Reader(abc);
    r.u16(); r.u16(); // minor, major

    let n = r.u30(); for (let i = 1; i < n; i++) r.u30();
    n = r.u30(); for (let i = 1; i < n; i++) r.u30();
    n = r.u30(); for (let i = 1; i < n; i++) r.skip(8);

    n = r.u30();
    const strings = [''];
    for (let i = 1; i < n; i++) { const len = r.u30(); strings.push(decoder.decode(abc.subarray(r.at, r.at + len))); r.skip(len); }

    n = r.u30();
    const namespaces = [null];
    for (let i = 1; i < n; i++) { const kind = r.u8(); const name = r.u30(); namespaces.push({ kind, name }); }

    n = r.u30();
    for (let i = 1; i < n; i++) { const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); } // ns_set

    n = r.u30();
    const multinames = [null];
    for (let i = 1; i < n; i++) {
      const kind = r.u8();
      const mn = { kind };
      switch (kind) {
        case 0x07: case 0x0d: mn.ns = r.u30(); mn.name = r.u30(); break;
        case 0x0f: case 0x10: mn.name = r.u30(); break;
        case 0x11: case 0x12: break;
        case 0x09: case 0x0e: mn.name = r.u30(); r.u30(); break;
        case 0x1b: case 0x1c: r.u30(); break;
        case 0x1d: mn.name = r.u30(); { const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); } break;
        default: return null;
      }
      multinames.push(mn);
    }

    const readTraits = (onMethod) => {
      const count = r.u30();
      for (let t = 0; t < count; t++) {
        const name = r.u30();
        const tag = r.u8();
        const kind = tag & 0x0f;
        if (kind === 0 || kind === 6) { r.u30(); r.u30(); const vindex = r.u30(); if (vindex) r.u8(); }
        else if (kind === 1 || kind === 2 || kind === 3) { r.u30(); const method = r.u30(); if (onMethod) onMethod(name, method); }
        else if (kind === 4 || kind === 5) { r.u30(); r.u30(); }
        else return false;
        if (tag & 0x40) { const mc = r.u30(); for (let m = 0; m < mc; m++) r.u30(); }
      }
      return true;
    };

    const methodCount = r.u30();
    for (let i = 0; i < methodCount; i++) {
      const pc = r.u30(); r.u30();
      for (let j = 0; j < pc; j++) r.u30();
      r.u30();
      const flags = r.u8();
      if (flags & 0x08) { const oc = r.u30(); for (let k = 0; k < oc; k++) { r.u30(); r.u8(); } }
      if (flags & 0x80) { for (let j = 0; j < pc; j++) r.u30(); }
    }

    const metaCount = r.u30();
    for (let i = 0; i < metaCount; i++) { r.u30(); const ic = r.u30(); for (let j = 0; j < ic; j++) { r.u30(); r.u30(); } }

    const nameToMethod = new Map();
    const classCount = r.u30();
    for (let i = 0; i < classCount; i++) {
      r.u30(); r.u30();
      const flags = r.u8();
      if (flags & 0x08) r.u30();
      const ic = r.u30(); for (let j = 0; j < ic; j++) r.u30();
      r.u30();
      if (!readTraits((name, method) => nameToMethod.set(name, method))) return null;
    }
    for (let i = 0; i < classCount; i++) { r.u30(); if (!readTraits(null)) return null; }

    const scriptCount = r.u30();
    for (let i = 0; i < scriptCount; i++) { r.u30(); if (!readTraits(null)) return null; }

    const bodyCount = r.u30();
    const bodies = [];
    for (let i = 0; i < bodyCount; i++) {
      const method = r.u30();
      r.u30(); r.u30(); r.u30(); r.u30();
      const codeLenPos = r.at;
      const codeLen = r.u30();
      const codeStart = r.at;
      r.skip(codeLen);
      const codeEnd = r.at;
      const exCount = r.u30();
      for (let e = 0; e < exCount; e++) { r.u30(); r.u30(); r.u30(); r.u30(); r.u30(); }
      if (!readTraits(null)) return null;
      bodies.push({ method, codeLenPos, codeStart, codeEnd, codeLen });
    }
    if (r.at !== abc.length) return null;

    return { strings, namespaces, multinames, nameToMethod, bodies };
  }

  const findQName = (abcData, nsName, localName) => {
    const { multinames, namespaces, strings } = abcData;
    for (let i = 1; i < multinames.length; i++) {
      const mn = multinames[i];
      if (!mn || mn.kind !== 0x07 || mn.name === 0) continue;
      if (strings[mn.name] !== localName) continue;
      const ns = namespaces[mn.ns];
      if (ns && strings[ns.name] === nsName) return i;
    }
    return -1;
  };
  const findLocal = (abcData, localName) => {
    const { multinames, strings } = abcData;
    for (let i = 1; i < multinames.length; i++) {
      const mn = multinames[i];
      if (mn && mn.kind === 0x07 && strings[mn.name] === localName) return i;
    }
    return -1;
  };

  function findSequence(bytes, sequence, from, to) {
    outer: for (let i = from; i <= to - sequence.length; i++) {
      for (let j = 0; j < sequence.length; j++) if (bytes[i + j] !== sequence[j]) continue outer;
      return i;
    }
    return -1;
  }

  function patchAbc(abc) {
    const data = parseAbc(abc);
    if (!data) return null;

    const idx = {
      target: findQName(data, '', 'target'),
      mainTile: findQName(data, 'tangram', 'MainTile'),
      currentTile: findLocal(data, '_currentTile'),
      stage: findQName(data, '', 'stage'),
      keyboardEvent: findQName(data, 'flash.events', 'KeyboardEvent'),
      keyDown: findQName(data, '', 'KEY_DOWN'),
      rotateTile: findLocal(data, 'rotateTile'),
      addEventListener: findQName(data, '', 'addEventListener'),
    };
    if (Object.values(idx).some((v) => v < 0)) return null;

    const rotateMethod = data.nameToMethod.get(idx.rotateTile);
    const setUpNameIndex = findLocal(data, 'setUpTiles');
    const setUpMethod = data.nameToMethod.get(setUpNameIndex);
    const rotateBody = data.bodies.find((b) => b.method === rotateMethod);
    const setUpBody = data.bodies.find((b) => b.method === setUpMethod);
    if (!rotateBody || !setUpBody) return null;

    const ct = encodeU30(idx.currentTile);
    const mt = encodeU30(idx.mainTile);
    const st = encodeU30(idx.stage);
    const kb = encodeU30(idx.keyboardEvent);
    const kd = encodeU30(idx.keyDown);
    const rt = encodeU30(idx.rotateTile);
    const ae = encodeU30(idx.addEventListener);

    const fallbackLen = 1 + ct.length + 1 + mt.length + 1;
    const routing = [
      0xd2, 0x20, 0x14, fallbackLen, 0x00, 0x00,
      0x60, ...ct, 0x80, ...mt, 0xd6,
      0xd2, 0x20, 0x1a, 0x01, 0x00, 0x00,
      0x47,
    ];
    const rotateSig = [0xd1, 0x66, ...encodeU30(idx.target), 0x60, ...mt, 0x87, 0x80, ...mt, 0xd6];

    const listenerCall = [0xd0, 0x66, ...st, 0x60, ...kb, 0x66, ...kd, 0x60, ...rt, 0x4f, ...ae, 0x02];
    const guardHead = [0xd0, 0x66, ...st, 0x20, 0x19];
    const stageBlock = [...guardHead, 0x00, 0x00, 0x00, ...listenerCall];
    stageBlock[guardHead.length] = listenerCall.length;
    const setUpSig = [0xd1, 0x60, ...kb, 0x66, ...kd, 0x60, ...rt, 0x4f, ...ae, 0x02];

    const plan = (body, sig, block) => {
      const found = findSequence(abc, sig, body.codeStart, body.codeEnd);
      if (found < 0) return null;
      return {
        codeLenPos: body.codeLenPos,
        codeEnd: body.codeEnd,
        insertAt: found + sig.length,
        newLen: body.codeLen + block.length,
        block: new Uint8Array(block),
      };
    };

    const edits = [
      plan(rotateBody, rotateSig, routing),
      plan(setUpBody, setUpSig, stageBlock),
    ];
    if (edits.some((e) => !e)) return null;
    edits.sort((a, b) => a.codeLenPos - b.codeLenPos);

    const parts = [];
    let cursor = 0;
    for (const edit of edits) {
      parts.push(abc.subarray(cursor, edit.codeLenPos));
      parts.push(new Uint8Array(encodeU30(edit.newLen)));
      const codeStart = edit.codeLenPos + u30ByteLength(abc, edit.codeLenPos);
      parts.push(abc.subarray(codeStart, edit.insertAt));
      parts.push(edit.block);
      parts.push(abc.subarray(edit.insertAt, edit.codeEnd));
      cursor = edit.codeEnd;
    }
    parts.push(abc.subarray(cursor));
    return join(parts);
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

    let patched = null;
    for (let offset = tagsAt; offset < body.length;) {
      const value = readWord(body, offset);
      const code = value >> 6;
      const shortLength = value & 63;
      const headerLength = shortLength === 63 ? 6 : 2;
      const length = shortLength === 63 ? readDword(body, offset + 2) : shortLength;
      const bodyStart = offset + headerLength;
      const end = bodyStart + length;

      if (code === 82) {
        const tagBody = body.subarray(bodyStart, end);
        let nameEnd = 4;
        while (tagBody[nameEnd] !== 0) nameEnd++;
        const abcStart = nameEnd + 1;
        const newAbc = patchAbc(tagBody.subarray(abcStart));
        if (!newAbc) return null;

        const newTagBody = join([tagBody.subarray(0, abcStart), newAbc]);
        const tagHeader = new Uint8Array(6);
        const view = new DataView(tagHeader.buffer);
        view.setUint16(0, (82 << 6) | 63, true);
        view.setUint32(2, newTagBody.length, true);
        patched = join([body.subarray(0, offset), tagHeader, newTagBody, body.subarray(end)]);
        break;
      }
      offset = end;
    }

    if (!patched) {
      console.warn('[shenkuu-tangram] DoABC2 tag not found');
      return null;
    }

    const header = raw.slice(0, 8);
    new DataView(header.buffer).setUint32(4, 8 + patched.length, true);
    const payload = signature === 'CWS' ? await zlib(patched, 'deflate') : patched;
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
      console.error('[shenkuu-tangram] patch failed, serving the original', error);
      return response;
    }
  };
})();
