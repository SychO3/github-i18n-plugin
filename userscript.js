// ==UserScript==
// @name                GitHub 中文汉化
// @namespace           https://github.com/SychO3/github-i18n-plugin/
// @version             2.0.1
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
    // 立即开始翻译，不等待 DOM 完全加载
    loadLocales();
    computeActiveDict();
    
    // 如果 DOM 还没准备好，等待一下再翻译
    if (document.body) {
      startTranslation();
    } else {
      // 等待 body 出现
      const observer = new MutationObserver((mutations, obs) => {
        if (document.body) {
          obs.disconnect();
          startTranslation();
        }
      });
      observer.observe(document.documentElement, { childList: true });
    }
  }

  function startTranslation() {
    // 先隐藏页面内容，避免闪烁
    hidePageContent();
    
    // 开始翻译
    translateByCssSelector();
    translateTime();
    translatePage();
    
    // 翻译完成后显示内容
    showPageContent();
    
    // 设置监听器
    watchDomUpdates();
    watchUrlChanges();
    maybeAddRepoDescTranslateButton();
  }

  // 隐藏页面内容，避免翻译过程中的闪烁
  function hidePageContent() {
    if (!document.body) return;
    
    // 添加样式来隐藏内容
    const style = document.createElement('style');
    style.id = 'github-i18n-hide';
    style.textContent = `
      body > *:not(script):not(style) {
        opacity: 0;
        transition: opacity 0.3s ease-in-out;
      }
      body.translated > *:not(script):not(style) {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  // 显示页面内容
  function showPageContent() {
    if (!document.body) return;
    
    // 添加标记类
    document.body.classList.add('translated');
    
    // 延迟移除隐藏样式，确保过渡效果完成
    setTimeout(() => {
      const style = document.getElementById('github-i18n-hide');
      if (style) style.remove();
    }, 350);
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
    let processedCount = 0;
    
    // 分批处理，每批之间添加小延迟，让页面更平滑
    const processBatch = () => {
      if (batch.length === 0) {
        isTranslating = false;
        return;
      }
      
      const currentBatch = batch.splice(0, CONFIG.BATCH_SIZE);
      translateBatch(currentBatch);
      processedCount += currentBatch.length;
      
      // 如果还有内容要处理，继续下一批
      if (batch.length > 0) {
        // 使用 requestAnimationFrame 确保平滑
        requestAnimationFrame(() => {
          setTimeout(processBatch, 10); // 10ms 延迟，让浏览器有时间渲染
        });
      } else {
        isTranslating = false;
      }
    };

    // 收集所有需要翻译的节点
    while ((current = walker.nextNode())) {
      batch.push(current);
    }
    
    // 开始处理第一批
    if (batch.length > 0) {
      processBatch();
    } else {
      isTranslating = false;
    }
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

      // 处理包含 HTML 标签的复杂文本元素
      if (el.children.length > 0 && el.textContent.trim()) {
        translateComplexElement(el);
      }
    }
  }

  // 翻译包含 HTML 标签的复杂元素
  function translateComplexElement(el) {
    // 跳过已经处理过的元素
    if (el.hasAttribute('data-i18n-processed')) return;
    
    const fullText = el.textContent.trim();
    if (!fullText) return;
    
    // 尝试匹配完整的文本（包含 HTML 标签）
    const key = normalizeKey(fullText);
    const t = activeDict[key];
    
    if (t) {
      // 如果找到完整翻译，直接替换 innerHTML
      el.innerHTML = t;
      el.setAttribute('data-i18n-processed', 'true');
      return;
    }
    
    // 如果没有完整翻译，尝试部分匹配
    const partialKey = normalizeKey(fullText.replace(/<[^>]*>/g, '').trim());
    const partialT = activeDict[partialKey];
    
    if (partialT) {
      // 保持原有的 HTML 结构，只替换文本部分
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = el.innerHTML;
      
      // 递归处理子节点
      const walkTextNodes = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          if (text) {
            const textKey = normalizeKey(text);
            const textT = activeDict[textKey];
            if (textT) {
              node.textContent = textT;
            }
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          for (const child of node.childNodes) {
            walkTextNodes(child);
          }
        }
      };
      
      walkTextNodes(tempDiv);
      el.innerHTML = tempDiv.innerHTML;
      el.setAttribute('data-i18n-processed', 'true');
    }
  }

  function normalizeKey(text) {
    return text.toLowerCase().replace(/\xa0/g, ' ').replace(/\s{2,}/g, ' ');
  }

  function watchDomUpdates() {
    if (!window.MutationObserver) return;
    
    let pendingUpdate = false;
    
    const observer = new MutationObserver((mutations) => {
      // 检查是否有重要的变化
      const hasImportantChanges = mutations.some(mutation => {
        // 跳过不重要的变化
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent;
          // 跳过纯数字、空白字符等
          return text && text.trim() && /[a-zA-Z]/.test(text);
        }
        
        if (mutation.type === 'childList') {
          // 检查新增的节点是否包含文本内容
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
              return true;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
              return true;
            }
          }
        }
        
        return false;
      });
      
      if (hasImportantChanges && !pendingUpdate && !isTranslating) {
        pendingUpdate = true;
        
        // 使用防抖，避免频繁更新
        setTimeout(() => {
          if (pendingUpdate) {
            translatePage();
            translateTime();
            pendingUpdate = false;
          }
        }, CONFIG.DEBOUNCE_DELAY_MS);
      }
    });
    
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
  let isUrlChanging = false;
  
  function onUrlMaybeChanged() {
    const now = location.href;
    if (now === lastUrl || isUrlChanging) return;
    
    isUrlChanging = true;
    lastUrl = now;
    
    // 隐藏页面内容，避免 URL 变化时的闪烁
    hidePageContent();
    
    // 重新计算翻译词典
    computeActiveDict();
    
    // 延迟翻译，让新页面内容加载完成
    setTimeout(() => {
      translateByCssSelector();
      translateTime();
      translatePage();
      maybeAddRepoDescTranslateButton();
      
      // 显示翻译后的内容
      showPageContent();
      isUrlChanging = false;
    }, 100);
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


