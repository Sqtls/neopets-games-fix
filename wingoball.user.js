// ==UserScript==
// @name         Wingoball Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Wingoballs instant ball death.
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=771\b/
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const GAME_SWF = /\/games\/g771_[^/]*\.swf(\?|$)/i;
  const EXPECTED_SITES = 12;
  const PUSH_ONE = new Uint8Array([0x96, 0x05, 0x00, 0x07, 0x01, 0x00, 0x00, 0x00]); // Push int32 1

  const ACTION_GET_VARIABLE = 0x1c;
  const ACTION_GET_MEMBER = 0x4e;
  const ACTION_CALL_METHOD = 0x52;
  const ACTION_CONSTANT_POOL = 0x88;
  const ACTION_DEFINE_FUNCTION2 = 0x8e;
  const ACTION_WITH = 0x94;
  const ACTION_PUSH = 0x96;
  const ACTION_JUMP = 0x99;
  const ACTION_DEFINE_FUNCTION = 0x9b;
  const ACTION_IF = 0x9d;

  const TAG_DO_ACTION = 12;
  const TAG_DO_INIT_ACTION = 59;

  function u16(buf, at) { return buf[at] | (buf[at + 1] << 8); }
  function u32(buf, at) { return u16(buf, at) + u16(buf, at + 2) * 0x10000; }

  function putU16(buf, at, value) {
    buf[at] = value & 0xff;
    buf[at + 1] = (value >> 8) & 0xff;
  }

  function skipString(buf, at) {
    while (buf[at] !== 0) at++;
    return at + 1;
  }

  function concat(parts) {
    let total = 0;
    for (const part of parts) total += part.length;

    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }

    return out;
  }

  // walk an action stream once, noting the constant pool and everything that
  // stores an offset (those all break once we start inserting bytes).
  function scanActions(buf) {
    const actions = [];
    const branches = [];
    const blocks = []; // function and with() bodies, which carry a codeSize
    let pool = [];

    let at = 0;
    while (at < buf.length) {
      const code = buf[at];
      let dataStart = at + 1;
      let dataLen = 0;
      if (code >= 0x80) {
        dataLen = u16(buf, at + 1);
        dataStart = at + 3;
      }
      const end = dataStart + dataLen;
      actions.push({ offset: at, code, dataStart, end });

      if (code === ACTION_CONSTANT_POOL) {
        pool = [];
        let s = dataStart + 2;
        for (let n = u16(buf, dataStart); n > 0; n--) {
          const start = s;
          s = skipString(buf, s);
          const chars = buf.subarray(start, s - 1);
          pool.push(String.fromCharCode.apply(null, chars));
        }
      } else if (code === ACTION_JUMP || code === ACTION_IF) {
        // the s16 delta is relative to the end of the branch action itself
        branches.push({ deltaAt: dataStart, base: end });
      } else if (code === ACTION_DEFINE_FUNCTION) {
        let s = skipString(buf, dataStart); // function name
        let argc = u16(buf, s);
        s += 2;
        while (argc--) s = skipString(buf, s);
        blocks.push({ sizeAt: s, bodyStart: end, bodySize: u16(buf, s) });
      } else if (code === ACTION_DEFINE_FUNCTION2) {
        // codeSize is the last u16 of the payload
        blocks.push({ sizeAt: end - 2, bodyStart: end, bodySize: u16(buf, end - 2) });
      } else if (code === ACTION_WITH) {
        blocks.push({ sizeAt: dataStart, bodyStart: end, bodySize: u16(buf, dataStart) });
      }

      at = end;
    }

    return { actions, branches, blocks, pool };
  }

  function readPushValues(buf, action) {
    const values = [];
    let s = action.dataStart;
    while (s < action.end) {
      const type = buf[s++];
      const value = { type, at: s };
      switch (type) {
        case 0: s = skipString(buf, s); break; // string literal
        case 1: s += 4; break; // float
        case 2: break; // null
        case 3: break; // undefined
        case 4: s += 1; break; // register
        case 5: s += 1; break; // boolean
        case 6: s += 8; break; // double
        case 7: value.int = u32(buf, s); s += 4; break;
        case 8: value.poolIndex = buf[s]; s += 1; break;
        case 9: value.poolIndex = u16(buf, s); s += 2; break;
        default: return null;
      }
      values.push(value);
    }
    return values;
  }

  function findCallSites(buf, actions, pool) {
    const sites = [];

    for (let i = 2; i < actions.length; i++) {
      if (actions[i].code !== ACTION_CALL_METHOD) continue;
      const namePush = actions[i - 1];
      if (namePush.code !== ACTION_PUSH) continue;
      const name = readPushValues(buf, namePush);
      if (!name || name.length !== 1) continue;
      if (pool[name[0].poolIndex] !== 'hitTest') continue;

      // step back over the receiver expression to the arg count push
      let countValue = null;
      let k = i - 2;
      for (; k >= i - 7 && k >= 0; k--) {
        const action = actions[k];
        if (action.code === ACTION_GET_MEMBER) continue;
        if (action.code !== ACTION_PUSH) break;
        const values = readPushValues(buf, action);
        if (!values) break;
        if (values[0].type === 7 && values[0].int === 4) {
          countValue = values[0];
          break;
        }
        // member name pushes are all the receiver expression may contain
        let allStrings = true;
        for (const value of values) {
          if (value.poolIndex === undefined && value.type !== 0) {
            allStrings = false;
            break;
          }
        }
        if (!allStrings) break;
      }
      if (!countValue) continue;

      let need = 4;
      let insertAt = -1;
      while (--k >= 0 && need > 0) {
        const action = actions[k];
        if (action.code === ACTION_GET_MEMBER) {
          need += 1; // pops two, pushes one
        } else if (action.code === ACTION_GET_VARIABLE) {
          // pops one, pushes one
        } else if (action.code === ACTION_PUSH) {
          const values = readPushValues(buf, action);
          if (!values) break;
          need -= values.length;
        } else {
          break;
        }
        if (need === 0) insertAt = action.offset;
      }
      if (insertAt < 0) continue;

      sites.push({ insertAt, countByteAt: countValue.at });
    }

    return sites;
  }

  function applyPatch(buf, sites, branches, blocks) {
    const insertions = [];
    for (const site of sites) insertions.push(site.insertAt);
    insertions.sort((a, b) => a - b);

    const grow = PUSH_ONE.length;

    // an insertion point maps to itself, so a branch aimed at one lands on
    // the inserted Push instead of jumping over it. WorldClass has one.
    function reloc(offset) {
      let moved = offset;
      for (const p of insertions) {
        if (p < offset) moved += grow;
      }
      return moved;
    }

    const out = new Uint8Array(buf.length + grow * insertions.length);
    let read = 0;
    let write = 0;
    for (const p of insertions) {
      out.set(buf.subarray(read, p), write);
      write += p - read;
      out.set(PUSH_ONE, write);
      write += grow;
      read = p;
    }
    out.set(buf.subarray(read), write);

    for (const site of sites) {
      out[reloc(site.countByteAt)] = 5; // arg count 4 -> 5
    }

    for (const branch of branches) {
      let delta = u16(buf, branch.deltaAt);
      if (delta & 0x8000) delta -= 0x10000;
      const newDelta = reloc(branch.base + delta) - reloc(branch.base);
      putU16(out, reloc(branch.deltaAt), newDelta);
    }

    for (const block of blocks) {
      const newSize = reloc(block.bodyStart + block.bodySize) - reloc(block.bodyStart);
      putU16(out, reloc(block.sizeAt), newSize);
    }

    return out;
  }

  function patchActions(buf) {
    const { actions, branches, blocks, pool } = scanActions(buf);
    const sites = findCallSites(buf, actions, pool);
    if (sites.length === 0) return { bytes: buf, count: 0 };

    const patched = applyPatch(buf, sites, branches, blocks);
    return { bytes: patched, count: sites.length };
  }

  // run patchActions over every DoAction/DoInitAction tag in the swf body
  function patchSwfBody(body) {
    const nbits = body[0] >> 3;
    const headerLen = Math.ceil((5 + 4 * nbits) / 8) + 4; // stage rect + framerate + frame count
    const parts = [body.subarray(0, headerLen)];
    let count = 0;

    let at = headerLen;
    while (at < body.length) {
      const tagCode = u16(body, at) >> 6;
      let tagLen = u16(body, at) & 0x3f;
      let headerSize = 2;
      if (tagLen === 0x3f) {
        tagLen = u32(body, at + 2);
        headerSize = 6;
      }
      const next = at + headerSize + tagLen;

      if (tagCode === TAG_DO_ACTION || tagCode === TAG_DO_INIT_ACTION) {
        const patched = patchActions(body.subarray(at + headerSize, next));
        if (patched.count > 0) {
          count += patched.count;

          const header = new Uint8Array(6); // patched tags always get the long form
          putU16(header, 0, (tagCode << 6) | 0x3f);
          putU16(header, 2, patched.bytes.length & 0xffff);
          putU16(header, 4, patched.bytes.length >>> 16);

          parts.push(header, patched.bytes);
          at = next;
          continue;
        }
      }

      parts.push(body.subarray(at, next));
      at = next;
    }

    return { bytes: concat(parts), count };
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

    let body = raw.slice(8);
    if (sig === 'CWS') body = await inflate(body);

    const { bytes, count } = patchSwfBody(body);
    if (count !== EXPECTED_SITES) {
      // not the swf we audited, don't touch it
      console.warn('[wingoball] expected', EXPECTED_SITES, 'hitTest call sites, found', count, '- leaving the game alone');
      return null;
    }
    console.log('[wingoball] added secondAlphaThreshold=1 to', count, 'hitTest calls');

    let compressed = bytes;
    if (sig === 'CWS') compressed = await deflate(bytes);

    const out = new Uint8Array(8 + compressed.length);
    out.set(raw.subarray(0, 8));
    out.set(compressed, 8);

    const fileLen = 8 + bytes.length; // the header wants the uncompressed length
    putU16(out, 4, fileLen & 0xffff);
    putU16(out, 6, fileLen >>> 16);

    return out;
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
          // a constructed Response has url = "", and Ruffle uses the url as
          // the movie's base for relative loads and flashvars
          Object.defineProperty(out, 'url', { value: res.url || url });
          return out;
        }
      } catch (e) {
        console.error('[wingoball] patch failed, serving the original', e);
      }
    }
    return res;
  };
})();
