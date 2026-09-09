// ==UserScript==
// @name         Extreme Potato Counter Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Fix Extreme Potato Counter so its config loads
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=226\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=226\b/.test(location.search)) return;

  const CONFIG_XML = /^https?:\/\/www\.neopets\.com\/games\/games(\/g226\/config\.xml(?:[?#].*)?)$/i;

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const match = url && CONFIG_XML.exec(url);
    if (match) {
      const fixed = 'https://images.neopets.com/games' + match[1];
      console.log('[extreme-potato-counter] loading config from images host');
      return nativeFetch.call(this, fixed, { method: 'GET', credentials: 'omit' });
    }
    return nativeFetch.call(this, input, init);
  };
})();
