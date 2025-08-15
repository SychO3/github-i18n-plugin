// ==UserScript==
// @name                GitHub 中文汉化（按 URL 作用域）
// @namespace           https://github.com/SychO3/github-i18n-plugin/
// @version             1.0.0
// @description         仅中文，按 URL 作用域覆盖翻译；更高性能与更少干扰
// @author              SychO3
// @match               https://github.com/*
// @match               https://gist.github.com/*
// @grant               GM_getResourceText
// @grant               GM_xmlhttpRequest
// @connect             www.github-zh.com
// @resource            zh-CN-scoped https://raw.githubusercontent.com/SychO3/github-i18n-plugin/refs/heads/master/locales/zh-CN.scoped.json
// @require             https://cdnjs.cloudflare.com/ajax/libs/timeago.js/4.0.2/timeago.min.js
// @require             https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js
// @license             MIT
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    DEBOUNCE_DELAY_MS: 300,
    BATCH_SIZE: 60,
    TIME_LOCALE: 'zh_CN'
  };

  // locales 文件结构：
  // {
  //   css: [ { selector, key|!html, replacement, pattern? } ],
  //   dict: { "key": "默认翻译" },
  //   scopes: [ { pattern: "https://github.com/*/*/issues*", dict: { "key": "覆盖翻译" } } ]
  // }
  let locales = { css: [], dict: {}, scopes: [] };
  let activeDict = {};
  let isTranslating = false;
  let debounceTimer = null;

  function init() {
    loadLocales();
    computeActiveDict();
    translateByCssSelector();
    translateTime();
    translatePage();
    watchDomUpdates();
    watchUrlChanges();
    maybeAddRepoDescTranslateButton();
  }

  function loadLocales() {
    try {
      const rawScoped = GM_getResourceText('zh-CN-scoped');
      const scoped = JSON.parse(rawScoped || '{}');
      locales.css = Array.isArray(scoped.css) ? scoped.css : [];
      locales.dict = scoped.dict || {};
      locales.scopes = Array.isArray(scoped.scopes) ? scoped.scopes : [];
    } catch (err) {
      console.error('[i18n] 加载语言包失败:', err);
      locales = { css: [], dict: {}, scopes: [] };
    }
  }

  function computeActiveDict() {
    const url = window.location.href;
    const merged = { ...locales.dict };
    for (const scope of locales.scopes) {
      if (scope && scope.pattern && scope.dict && isUrlMatch(scope.pattern, url)) {
        Object.assign(merged, scope.dict);
      }
    }
    activeDict = merged;
  }

  function isUrlMatch(pattern, url) {
    // 支持通配符 *，对 . ? + ^ $ { } ( ) | [ ] / 进行转义
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const reg = new RegExp('^' + escaped + '$');
    return reg.test(url);
  }

  function translatePage() {
    if (isTranslating) return;
    isTranslating = true;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent && node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            return shouldTranslateElement(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_REJECT;
        }
      }
    );

    const batch = [];
    let current;
    while ((current = walker.nextNode())) {
      batch.push(current);
      if (batch.length >= CONFIG.BATCH_SIZE) {
        translateBatch(batch);
        batch.length = 0;
      }
    }
    if (batch.length > 0) translateBatch(batch);

    isTranslating = false;
  }

  function translateBatch(nodes) {
    for (const node of nodes) translateNode(node);
  }

  function shouldTranslateElement(el) {
    // 跳过不应翻译的元素/区域
    const skipTags = ['CODE', 'SCRIPT', 'LINK', 'IMG', 'SVG', 'TABLE', 'PRE'];
    if (skipTags.includes(el.tagName)) return false;

    const skipClasses = [
      'CodeMirror', 'js-navigation-container', 'blob-code', 'topic-tag',
      'repo-list', 'js-path-segment', 'final-path', 'react-tree-show-tree-items',
      'markdown-body', 'search-input-container', 'search-match',
      'cm-editor', 'react-code-lines', 'PRIVATE_TreeView-item', 'repo'
    ];
    if (el.classList) {
      for (const c of skipClasses) if (el.classList.contains(c)) return false;
    }

    const skipIds = ['readme', 'file-name-editor-breadcrumb', 'StickyHeader', 'sticky-file-name-id', 'sticky-breadcrumb'];
    if (el.id && skipIds.includes(el.id)) return false;

    // itemprop="name" 等
    if (el.getAttribute) {
      const itemprop = el.getAttribute('itemprop');
      if (itemprop && itemprop.split(' ').includes('name')) return false;
    }

    return true;
  }

  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent;
      if (!raw) return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const key = normalizeKey(trimmed);
      const t = activeDict[key];
      if (t) node.textContent = raw.replace(trimmed, t);
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;

      // input
      if (el.tagName === 'INPUT') {
        const attr = (el.type === 'button' || el.type === 'submit') ? 'value' : 'placeholder';
        const val = el[attr];
        if (val) {
          const key = normalizeKey(val.trim());
          const t = activeDict[key];
          if (t) el[attr] = val.replace(val.trim(), t);
        }
      }

      // aria-label
      if (el.ariaLabel) {
        const key = normalizeKey(el.ariaLabel.trim());
        const t = activeDict[key];
        if (t) el.ariaLabel = el.ariaLabel.replace(el.ariaLabel.trim(), t);
      }
    }
  }

  function normalizeKey(text) {
    return text.toLowerCase().replace(/\xa0/g, ' ').replace(/\s{2,}/g, ' ');
  }

  function watchDomUpdates() {
    if (!window.MutationObserver) return;
    const observer = new MutationObserver(debounce(() => {
      if (!isTranslating) {
        translatePage();
        translateTime();
      }
    }, CONFIG.DEBOUNCE_DELAY_MS));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ['value', 'placeholder', 'aria-label']
    });
  }

  function watchUrlChanges() {
    // GitHub 使用 PJAX；拦截 pushState/replaceState
    const wrap = (fn) => function () {
      const ret = fn.apply(this, arguments);
      onUrlMaybeChanged();
      return ret;
    };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch {}
    window.addEventListener('popstate', onUrlMaybeChanged, false);
  }

  let lastUrl = location.href;
  function onUrlMaybeChanged() {
    const now = location.href;
    if (now === lastUrl) return;
    lastUrl = now;
    computeActiveDict();
    translateByCssSelector();
    translateTime();
    translatePage();
    maybeAddRepoDescTranslateButton();
  }

  function translateTime() {
    $('relative-time').each(function () {
      const el = this;
      const datetime = $(el).attr('datetime');
      if (!datetime) return;
      try {
        const humanTime = timeago.format(datetime, CONFIG.TIME_LOCALE);
        if (el.shadowRoot) el.shadowRoot.textContent = humanTime; else el.textContent = humanTime;
      } catch (e) {}
    });
  }

  function translateByCssSelector() {
    if (!Array.isArray(locales.css)) return;
    const url = window.location.href;
    for (const rule of locales.css) {
      if (!rule || !rule.selector) continue;
      if (rule.pattern && !isUrlMatch(rule.pattern, url)) continue;
      const $els = $(rule.selector);
      if ($els.length === 0) continue;
      if (rule.key === '!html') $els.html(rule.replacement);
      else if (rule.key) $els.attr(rule.key, rule.replacement);
    }
  }

  function maybeAddRepoDescTranslateButton() {
    if (window.location.pathname.split('/').length !== 3) return;
    const target = $('.repository-content .f4');
    if (target.length === 0) return;
    if ($('#translate-me').length > 0) return;
    target.append('<br/>');
    target.append('<a id="translate-me" href="#" style="color:rgb(27, 149, 224);font-size: small">翻译</a>');
    $('#translate-me').on('click', function (e) {
      e.preventDefault();
      translateRepositoryDescription();
    });
  }

  function translateRepositoryDescription() {
    const $box = $('.repository-content .f4');
    const desc = $box.clone().children().remove().end().text().trim();
    if (!desc) return;
    const repoId = $('meta[name=octolytics-dimension-repository_id]').attr('content');
    if (!repoId) return;
    $('#translate-me').hide();
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://www.github-zh.com/translate?i=${repoId}&q=${encodeURIComponent(desc)}`,
      onload: function (rsp) {
        if (rsp.status === 200) {
          $box.append('<span style="font-size: small">由 <a target="_blank" style="color:rgb(27, 149, 224);" href="https://www.github-zh.com">GitHub中文社区</a> 翻译👇</span><br/>' + rsp.responseText);
        } else {
          alert('翻译失败');
          $('#translate-me').show();
        }
      },
      onerror: function () {
        alert('翻译失败');
        $('#translate-me').show();
      }
    });
  }

  function debounce(fn, wait) {
    return function () {
      const ctx = this, args = arguments;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();


