// ==UserScript==
// @name         Dubloon Disaster Fix
// @namespace    Squirtle @ Clraik
// @version      1.0
// @description  Stop the duplicate page request that breaks dubloon disasters score submission
// @include      /^https?:\/\/www\.neopets\.com\/games\/(game|play_flash)\.phtml\?.*\bgame_id=772\b/
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (!/[?&]game_id=772\b/.test(location.search)) return;

  const GAME_PAGE = /^(?:https?:\/\/www\.neopets\.com)?\/games\/(?:game|play_flash)\.phtml(?=[?#]|$)/i;
  const NOTHING = 'data:,';

  function blocked(url) {
    if (typeof url !== 'string') return false;
    if (!GAME_PAGE.test(url)) return false;
    console.warn('[dubloon] blocked a duplicate page request, keeping the score session');
    return true;
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      if (blocked(input)) return nativeFetch.call(this, NOTHING);
    } else if (input && input.url && blocked(input.url)) {
      return nativeFetch.call(this, NOTHING);
    }
    return nativeFetch.call(this, input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeOpen.call(this, method, blocked(url) ? NOTHING : url, ...rest);
  };
})();
