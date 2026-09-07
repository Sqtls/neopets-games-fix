// ==UserScript==
// @name         Deckball Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Deckball options and in game boundaries
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=82\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=82\b/.test(location.search)) return;

  const GAME_SWF = /\/games\/g82_[^/]*\.swf(\?|$)/i;

  const X_SCALE = [
    0x96, 0x05, 0x00, 0x07, 0x02, 0x00, 0x00, 0x00, 0x0c, 0x3e,
    0x9b, 0x1a, 0x00,
    ...[...'dimensionoffset_y'].map((c) => c.charCodeAt(0)),
  ];
  const X_SCALE_VALUE_AT = 4;

  const Y_SCALE = [
    0x96, 0x0b, 0x00, 0x08, 0x03, 0x06,
    0x30, 0x0c, 0x03, 0x40, 0xc3, 0x30, 0x0c, 0xc3,
  ];

  const Y_SCALE_VALUE_AT = 6;
  const ONE_SWAPPED = [0x00, 0x00, 0xf0, 0x3f, 0x00, 0x00, 0x00, 0x00];

  const CASE_FIXES = [
    { find: '\0hittest\0', replace: '\0hitTest\0', expect: 1 },
    { find: '\0indexof\0', replace: '\0indexOf\0', expect: 2 },
  ];

  function findAll(body, pattern) {
    const hits = [];
    outer: for (let i = 0; i <= body.length - pattern.length; i++) {
      for (let j = 0; j < pattern.length; j++) {
        if (body[i + j] !== pattern[j]) continue outer;
      }
      hits.push(i);
    }
    return hits;
  }

  const join = (...parts) => Uint8Array.from(parts.flatMap((part) =>
    typeof part === 'number' ? [part] : Array.from(part)));
  const word = (n) => [n & 255, (n >>> 8) & 255];
  const dword = (n) => [...word(n), ...word(n >>> 16)];
  const tag = (code, body) => join(word((code << 6) | 63), dword(body.length), body);

  const action = (op, bytes) => join(op, word(bytes.length), bytes);
  const str = (s) => action(0x96, join(0, new TextEncoder().encode(s), 0));
  const integer = (n) => action(0x96, join(7, dword(n)));
  const variable = (s) => join(str(s), 0x1c);
  const member = (object, name) => join(object, str(name), 0x4e);
  const set = (name, value) => join(str(name), value, 0x1d);
  const call = (object, method, args = []) => join(
    ...args.slice().reverse(), integer(args.length), object, str(method), 0x52, 0x17);
  const when = (condition, body) => join(condition, 0x12, action(0x9d, word(body.length)), body);

  function buildMenuHandler() {
    const self = variable('this');
    const component = variable('_parent');
    const count = member(member(component, 'items'), 'length');
    const row = join(self, str('item'), variable('dbIndex'), 0x47, 0x4e);

    const hit = (object) => join(integer(0), member(variable('_root'), '_ymouse'),
      member(variable('_root'), '_xmouse'), integer(3), object, str('hitTest'), 0x52);
    const select = when(hit(row), join(
      call(component, 'OnMenu', [variable('dbIndex'), member(row, 'label')]),
      component, str('currentValue'), member(row, 'label'), 0x4f));

    const loop = (body) => {
      const test = join(variable('dbIndex'), count, 0x48, 0x12);
      const step = set('dbIndex', join(variable('dbIndex'), 0x50));
      return join(set('dbIndex', integer(0)), test,
        action(0x9d, word(body.length + step.length + 5)), body, step,
        action(0x99, word(-(test.length + 5 + body.length + step.length + 5))));
    };

    const hide = (object) => join(object, str('_visible'), integer(0), 0x4f);
    const show = (object) => join(object, str('_visible'), integer(1), 0x4f);

    const close = join(loop(select), loop(hide(row)),
      hide(variable('outline')), hide(variable('outlineMac')), hide(variable('checkmark')),
      set('dbArmed', integer(2)));

    const arm = set('dbArmed', integer(1));
    const choose = join(variable('dbArmed'), action(0x9d, word(arm.length + 5)),
      arm, action(0x99, word(close.length)), close);

    const reopen = when(join(hit(variable('currentitem')), hit(variable('macshell')), 0x11),
      join(loop(show(row)), show(variable('outline')), show(variable('outlineMac')),
        show(variable('checkmark')), arm));

    const dispatch = join(variable('dbArmed'), integer(2), 0x49,
      action(0x9d, word(choose.length + 5)), choose,
      action(0x99, word(reopen.length)), reopen);

    return join(when(join(variable('_currentframe'), integer(2), 0x49), dispatch), 0);
  }

  function patchBoundaries(body, patched) {
    const self = variable('this');
    const conversion = [0x96, 0x07, 0x00, 0x07, 0x01, 0x00, 0x00, 0x00, 0x08, 0xf1, 0x3d, 0x17];
    const local = call(variable('_root'), 'globalToLocal', [member(self, 'point')]);

    for (const [name, size] of [['ballkeepinbounds', 545], ['petkeepinbounds', 352]]) {
      const signature = action(0x9b, join(new TextEncoder().encode(name), 0, word(0), word(size)));
      const hits = findAll(body, signature);
      if (!hits.length) continue;
      if (hits.length !== 1) throw new Error('unexpected boundary function');

      const start = hits[0] + signature.length;
      const original = body.slice(start, start + size);
      const calls = findAll(original, conversion);
      if (calls.length !== 1) throw new Error('unexpected boundary coordinates');

      const at = calls[0] + conversion.length;
      body = join(body.slice(0, start - 2), word(size + local.length),
        original.slice(0, at), local, original.slice(at), body.slice(start + size));
      patched.boundaries++;
    }
    return body;
  }

  function disableRowClicks(body, spriteId) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const upSize = spriteId === 770 ? 752 : 833;
    const downSize = spriteId === 770 ? 567 : 483;
    const records = [];

    for (let at = 0; at + 6 < body.length; at++) {
      if (view.getUint16(at, true) === 0x20 && view.getUint32(at + 2, true) === upSize) {
        records.push(at);
      }
    }

    if (records.length !== 1) return false;
    const up = records[0];
    const down = up - downSize - 6;
    if (view.getUint16(down, true) !== 0x10 || view.getUint32(down + 2, true) !== downSize) {
      throw new Error('unexpected row actions');
    }

    body.fill(0, up + 6, up + 6 + upSize);
    body.fill(0, down + 6, up);
    return true;
  }

  function rewriteTags(raw, from, end, spriteId, patched) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const parts = [];

    for (let at = from; at < end;) {
      const value = view.getUint16(at, true);
      const code = value >> 6;
      const header = (value & 63) === 63 ? 6 : 2;
      const length = header === 6 ? view.getUint32(at + 2, true) : value & 63;
      if (at + header + length > end) throw new Error('invalid SWF tag length');

      let body = raw.slice(at + header, at + header + length);
      let changed = false;
      if (code === 39) {
        const id = view.getUint16(at + header, true);
        if ([770, 784, 785].includes(id)) {
          body = join(body.slice(0, 4), rewriteTags(raw, at + header + 4, at + header + length, id, patched));
          changed = true;
        }
      } else if (code === 12 && spriteId === 0) {
        const updated = patchBoundaries(body, patched);

        changed = updated !== body;
        body = updated;

      } else if (code === 26 && spriteId === 785) {
        if (body[0] & 128) throw new Error('unexpected menu clip actions');

        body[0] |= 128;
        body = join(body, word(0), word(0x20), word(0x20),
          dword(patched.handler.length), patched.handler, word(0));

        changed = true;
        patched.menus++;

      } else if (code === 26 && [770, 784].includes(spriteId) && (body[0] & 128)) {
        changed = disableRowClicks(body, spriteId);
        if (changed) patched.rows++;
      }

      parts.push(changed ? tag(code, body) : raw.subarray(at, at + header + length));
      at += header + length;
    }
    return join(...parts);
  }

  function patchMovie(raw) {
    const start = 8 + Math.ceil((5 + (raw[8] >> 3) * 4) / 8) + 4;
    const patched = { handler: buildMenuHandler(), menus: 0, rows: 0, boundaries: 0 };
    const result = join(raw.slice(0, start), rewriteTags(raw, start, raw.length, 0, patched));

    if (patched.menus !== 2 || patched.rows !== 2) throw new Error('unexpected dropdown layout');
    if (patched.boundaries !== 2) throw new Error('unexpected boundary layout');

    new DataView(result.buffer).setUint32(4, result.length, true);
    return result;
  }

  function patchGame(buffer) {
    const raw = new Uint8Array(buffer);
    const sig = String.fromCharCode(raw[0], raw[1], raw[2]);
    if (sig !== 'FWS') return null;

    const out = raw.slice();
    const body = out.subarray(8);

    const xHits = findAll(body, X_SCALE);
    const yHits = findAll(body, Y_SCALE);

    if (xHits.length !== 1 || yHits.length !== 1) {
      console.warn('[deckball] expected 1 match per multiplier, got',
        xHits.length, 'and', yHits.length, '- leaving the game alone');
      return null;
    }

    body[xHits[0] + X_SCALE_VALUE_AT] = 1;
    body.set(ONE_SWAPPED, yHits[0] + Y_SCALE_VALUE_AT);

    for (const fix of CASE_FIXES) {
      const pattern = [...fix.find].map((c) => c.charCodeAt(0));
      const hits = findAll(body, pattern);

      if (hits.length !== fix.expect) {
        console.warn('[deckball] expected', fix.expect, 'of',
          JSON.stringify(fix.find), 'got', hits.length, '- skipping that fix');
        continue;
      }
      const replacement = [...fix.replace].map((c) => c.charCodeAt(0));
      for (const hit of hits) body.set(replacement, hit);
    }

    const patched = patchMovie(out);
    console.log('[deckball] fixed options, dropdown selection, and boundaries');
    return patched;
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
        const bytes = patchGame(await res.clone().arrayBuffer());
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
        console.error('[deckball] patch failed, serving the original', e);
      }
    }
    return res;
  };
})();
