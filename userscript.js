// ==UserScript==
// @name         GitHub 中文翻译增强
// @namespace    https://github.com/SychO3/github-i18n-plugin
// @version      1.0.0
// @description  将 GitHub 页面翻译为中文。采用字典驱动，按页面细分，不改变页面功能；自动处理 PJAX/动态内容。
// @author       SychO
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @run-at       document-idle
// @license      MIT
// @grant        GM.getResourceText
// @grant        GM_getResourceText
// @resource     zhCN https://raw.githubusercontent.com/SychO3/github-i18n-plugin/master/locales/zh-CN.json
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------
    // 外部字典加载（JSON 文件）
    // ---------------------------
    /**
     * 词典 JSON 结构：
     * {
     *   "global": { "sign in": "登录", ... },
     *   "repo": { ... },
     *   "issues_list": { ... },
     *   ... 其他页面键 ...
     * }
     */
    const RESOURCE_NAME = 'zhCN';
    let loadedDictionaries = {};

    function parseDictionaryJson(text) {
        try {
            const json = JSON.parse(text);
            if (json && typeof json === 'object') return json;
        } catch (_) {}
        return {};
    }

    async function loadDictionaries() {
        // 仅使用 @resource（GreasyFork/Tampermonkey 推荐方式）
        try {
            // 兼容 GM.getResourceText / GM_getResourceText
            // eslint-disable-next-line no-undef
            const gmGet = (typeof GM !== 'undefined' && typeof GM.getResourceText === 'function') ? GM.getResourceText : (typeof GM_getResourceText === 'function' ? GM_getResourceText : null);
            if (gmGet) {
                const maybe = gmGet(RESOURCE_NAME);
                const text = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
                if (typeof text === 'string' && text) {
                    return parseDictionaryJson(text);
                }
            }
        } catch (_) {}

        // 未配置资源时兜底为空对象（不翻译）
        return {};
    }

    // ---------------------------
    // 工具函数
    // ---------------------------
    function normalizeKey(text) {
        if (typeof text !== 'string') return '';
        return text.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function detectPageKeyFallback() {
        const p = location.pathname;
        // 仓库首页，如 /owner/repo
        if (/^\/[\w.-]+\/[\w.-]+$/.test(p)) return 'repo';
        // Issues 列表或详情
        if (/^\/[\w.-]+\/[\w.-]+\/issues(\/.*)?$/.test(p)) {
            return /\/issues\/\d+/.test(p) ? 'issue_detail' : 'issues_list';
        }
        // PR 列表或详情
        if (/^\/[\w.-]+\/[\w.-]+\/(pull|pulls)(\/.*)?$/.test(p)) {
            return /\/pull\/(\d+)/.test(p) ? 'pr_detail' : 'pulls_list';
        }
        // 文件浏览
        if (/^\/[\w.-]+\/[\w.-]+\/(tree|blob)\//.test(p)) return 'file_view';
        // Commits 列表/详情
        if (/^\/[\w.-]+\/[\w.-]+\/commits/.test(p)) return 'commits_list';
        if (/^\/[\w.-]+\/[\w.-]+\/commit\//.test(p)) return 'commit_detail';
        // 搜索/通知
        if (/^\/search/.test(p)) return 'search';
        if (/^\/notifications/.test(p)) return 'notifications';
        return 'global';
    }

    function matchRouteByRegex(pattern, url) {
        try {
            const re = new RegExp(pattern);
            return re.test(url);
        } catch (_) {
            return false;
        }
    }

    function matchRouteByPrefix(prefix, url) {
        if (typeof prefix !== 'string') return false;
        return url.startsWith(prefix);
    }

    function resolvePageKeyByRoutes(url) {
        const routes = Array.isArray(loadedDictionaries.routes) ? loadedDictionaries.routes : [];
        for (const route of routes) {
            if (!route || typeof route !== 'object') continue;
            const type = route.type || 'regex';
            const pattern = route.pattern || route.match || '';
            const key = route.key || route.pageKey || '';
            if (!pattern || !key) continue;
            let ok = false;
            if (type === 'prefix') ok = matchRouteByPrefix(pattern, url);
            else ok = matchRouteByRegex(pattern, url);
            if (ok) return key;
        }
        return null;
    }

    function detectActivePageKey() {
        const url = location.href;
        const mapped = resolvePageKeyByRoutes(url);
        if (mapped) return mapped;
        return detectPageKeyFallback();
    }

    function buildDictionaryForPage(pageKey) {
        const merged = Object.create(null);
        const globalDict = loadedDictionaries.global || {};
        for (const [k, v] of Object.entries(globalDict)) {
            merged[normalizeKey(k)] = v;
        }
        const pageDict = loadedDictionaries[pageKey] || {};
        for (const [k, v] of Object.entries(pageDict)) {
            merged[normalizeKey(k)] = v;
        }
        return merged;
    }

    // 需要跳过翻译的容器选择器
    const SKIP_CONTAINER_SELECTOR = [
        'pre', 'code', 'kbd', 'samp', 'var',
        'script', 'style', 'noscript',
        'svg', 'math',
        // Markdown/代码内容区域
        '.markdown-body', '.blob-code', '.diff-code', '.js-blob-code-container'
    ].join(',');

    function isSkippable(node) {
        if (!node) return true;
        if (node.nodeType !== Node.TEXT_NODE) return true;
        const parent = node.parentElement;
        if (!parent) return true;
        if (parent.closest(SKIP_CONTAINER_SELECTOR)) return true;
        // 忽略很长的文本（段落类），避免误伤内容文本
        const text = node.nodeValue || '';
        const norm = normalizeKey(text);
        if (!norm) return true;
        if (norm.length > 80) return true;
        return false;
    }

    function translateTextNode(node, dict) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return 0;
        const original = node.nodeValue || '';
        const leading = (original.match(/^\s*/)?.[0]) || '';
        const trailing = (original.match(/\s*$/)?.[0]) || '';
        const core = original.slice(leading.length, original.length - trailing.length);
        const key = normalizeKey(core);
        if (!key) return 0;
        const replacement = dict[key];
        if (!replacement) return 0;
        const next = leading + replacement + trailing;
        if (next !== original) {
            node.nodeValue = next;
            return 1;
        }
        return 0;
    }

    function translateInTree(root, dict) {
        if (!root || !dict) return 0;
        let replacedCount = 0;
        // 仅遍历文本节点
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const toProcess = [];
        while (walker.nextNode()) {
            const t = walker.currentNode;
            toProcess.push(t);
        }
        for (const textNode of toProcess) {
            if (isSkippable(textNode)) continue;
            replacedCount += translateTextNode(textNode, dict);
        }
        return replacedCount;
    }

    // ---------------------------
    // 事件与观察
    // ---------------------------
    let currentPageKey = null;
    let currentDict = null;
    let scheduled = false;

    function applyTranslation(reason) {
        try {
            const pageKey = detectActivePageKey();
            if (pageKey !== currentPageKey || !currentDict) {
                currentPageKey = pageKey;
                currentDict = buildDictionaryForPage(pageKey);
            }
            translateInTree(document.body, currentDict);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.debug('[GH i18n] translate error:', e, 'reason =', reason);
        }
    }

    function scheduleTranslate(reason) {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            applyTranslation(reason);
        });
    }

    // 观察 DOM 变化（处理懒加载和交互新增的节点）
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                if (m.addedNodes && m.addedNodes.length) {
                    scheduleTranslate('mutation:childList');
                    break;
                }
            } else if (m.type === 'characterData') {
                scheduleTranslate('mutation:char');
                break;
            }
        }
    });

    function startObserver() {
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true
        });
    }

    // 监听 PJAX/前端路由跳转
    function hookHistory() {
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function () {
            const ret = origPush.apply(this, arguments);
            scheduleTranslate('history.pushState');
            return ret;
        };
        history.replaceState = function () {
            const ret = origReplace.apply(this, arguments);
            scheduleTranslate('history.replaceState');
            return ret;
        };
        window.addEventListener('popstate', () => scheduleTranslate('history.popstate'));
        // GitHub pjax 事件
        document.addEventListener('pjax:end', () => scheduleTranslate('pjax:end'));
    }

    // 初始化
    async function init() {
        hookHistory();
        startObserver();
        loadedDictionaries = await loadDictionaries();
        applyTranslation('init');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();


