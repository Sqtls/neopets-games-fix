// ==UserScript==
// @name         Kiko Lake Racing Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Kiko Lake Racing map images
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=606\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=606\b/.test(location.search)) return;

  const MAP_IMAGE = /^https?:\/\/swf\.neopets\.com(\/games\/kikolakeracing\/map\d{2}_\d{2}\.jpg(?:[?#].*)?)$/i;

  function fix(url) {
    if (typeof url !== 'string') return url;
    return url.replace(MAP_IMAGE, 'https://images.neopets.com$1');
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      const fixed = fix(input);
      if (fixed !== input) {
        return nativeFetch.call(this, fixed, { ...init, credentials: 'omit' });
      }
    } else if (input && input.url) {
      const fixed = fix(input.url);
      if (fixed !== input.url) {
        let request = new Request(fixed, input);
        if (init) request = new Request(request, init);
        request = new Request(request, { credentials: 'omit' });
        return nativeFetch.call(this, request);
      }
    }
    return nativeFetch.call(this, input, init);
  };
})();
