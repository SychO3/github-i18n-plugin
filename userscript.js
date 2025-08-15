// ==UserScript==
// @name         GitHub 中文翻译增强
// @namespace    https://github.com/SychO3/github-i18n-plugin
// @version      1.0.9
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

    function escapeRegExp(literal) {
        return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    function buildPatternRulesForPage(pageKey) {
        const rules = [];
        const add = (arr) => {
            if (Array.isArray(arr)) {
                for (const item of arr) {
                    if (!item || typeof item !== 'object') continue;
                    const pattern = item.regex || item.pattern;
                    const replace = item.replace || item.replacement;
                    if (!pattern || typeof replace !== 'string') continue;
                    const flags = item.flags || 'i';
                    try {
                        const re = new RegExp(pattern, flags);
                        rules.push({ re, replace });
                    } catch (_) {
                        // ignore invalid regex
                    }
                }
            }
        };
        add(loadedDictionaries.patterns);
        const pageDict = loadedDictionaries[pageKey] || {};
        add(pageDict.patterns);
        return rules;
    }

    function buildTemplatesForPage(pageKey) {
        // 模板对象：{ normalizedKey: { html: string, anchors?: string[] } }
        const templates = Object.create(null);
        const add = (obj) => {
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                for (const [k, v] of Object.entries(obj)) {
                    if (typeof k !== 'string') continue;
                    const nk = normalizeKey(k);
                    if (typeof v === 'string') {
                        templates[nk] = { html: v };
                    } else if (v && typeof v === 'object') {
                        const html = typeof v.html === 'string' ? v.html : null;
                        const anchors = Array.isArray(v.anchors) ? v.anchors
                            : (Array.isArray(v.anchorTexts) ? v.anchorTexts : null);
                        if (html) templates[nk] = anchors ? { html, anchors } : { html };
                    }
                }
            }
        };
        add(loadedDictionaries.templates);
        const pageDict = loadedDictionaries[pageKey] || {};
        add(pageDict.templates);
        return templates;
    }

    function buildAnchorTemplateKey(parent) {
        const tokens = [];
        const anchors = [];
        parent.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                tokens.push(node.nodeValue || '');
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node;
                if (el.tagName === 'A') {
                    const idx = anchors.length;
                    anchors.push(el);
                    tokens.push(`[A${idx}]`);
                } else if (el.tagName === 'KBD') {
                    // 将 <kbd>x</kbd> 看作其文本
                    tokens.push(el.textContent || '');
                } else {
                    // 其他标签中止模板尝试
                    anchors.length = 0;
                    tokens.length = 0;
                }
            }
        });
        if (tokens.length === 0 && anchors.length === 0) return null;
        // 直接拼接，避免标点前的多余空格
        let raw = tokens.join('');
        // 清理标点前空格："word ." -> "word."
        raw = raw.replace(/\s+([.,!?;:])/g, '$1');
        return { key: normalizeKey(raw), anchors };
    }

    function translateTextByDictAndPatterns(text, dict, patternRules) {
        if (!text) return null;
        const key = normalizeKey(text);
        if (key) {
            const byDict = dict[key];
            if (byDict) return byDict;
        }
        if (patternRules && patternRules.length) {
            const byPat = translateByPatterns(text, patternRules);
            if (typeof byPat === 'string' && byPat !== text) return byPat;
        }
        return null;
    }

    function applyAnchorTemplate(parent, templates, dict, patternRules) {
        if (!parent || !templates) return 0;
        const built = buildAnchorTemplateKey(parent);
        if (!built) return 0;
        const tpl = templates[built.key];
        if (!tpl || !tpl.html) return 0;
        let html = tpl.html;
        built.anchors.forEach((a, idx) => {
            const marker = new RegExp(escapeRegExp(`[A${idx}]`), 'g');
            let aHtml = a.outerHTML;
            const override = tpl.anchors && typeof tpl.anchors[idx] === 'string' ? tpl.anchors[idx] : null;
            if (override) {
                const clone = a.cloneNode(true);
                clone.textContent = override;
                aHtml = clone.outerHTML;
            } else {
                // 尝试依据词典/模式翻译链接文本
                const translated = translateTextByDictAndPatterns(a.textContent || '', dict, patternRules);
                if (translated && translated !== (a.textContent || '')) {
                    const clone = a.cloneNode(true);
                    clone.textContent = translated;
                    aHtml = clone.outerHTML;
                }
            }
            html = html.replace(marker, aHtml);
        });
        if (parent.innerHTML !== html) {
            parent.innerHTML = html;
            processedElementSet.add(parent);
            return 1;
        }
        return 0;
    }

    function translateByPatterns(text, patternRules) {
        if (!Array.isArray(patternRules) || !patternRules.length) return null;
        for (const { re, replace } of patternRules) {
            if (!re) continue;
            if (re.test(text)) {
                try {
                    return text.replace(re, replace);
                } catch (_) {
                    continue;
                }
            }
        }
        return null;
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

    function translateTextNode(node, dict, patternRules) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return 0;
        const original = node.nodeValue || '';
        const leading = (original.match(/^\s*/)?.[0]) || '';
        const trailing = (original.match(/\s*$/)?.[0]) || '';
        const core = original.slice(leading.length, original.length - trailing.length);
        const key = normalizeKey(core);
        if (!key) return 0;
        const replacement = dict[key];
        if (replacement) {
            const next = leading + replacement + trailing;
            if (next !== original) {
                node.nodeValue = next;
                return 1;
            }
            return 0;
        }
        // 尝试模式规则（如 "2 results" 等）
        if (patternRules && patternRules.length) {
            const byPattern = translateByPatterns(core, patternRules);
            if (typeof byPattern === 'string' && byPattern !== core) {
                const next = leading + byPattern + trailing;
                if (next !== original) {
                    node.nodeValue = next;
                    return 1;
                }
            }
        }
        return 0;
    }

    let processedElementSet = new WeakSet();

    function tryTranslateByParentElement(textNode, dict, patternRules, templates) {
        const parent = textNode && textNode.parentElement;
        if (!parent || processedElementSet.has(parent)) return 0;
        if (parent.closest(SKIP_CONTAINER_SELECTOR)) return 0;
        // 情况 A：仅含 <kbd>
        const allowedInlineTags = new Set(['KBD']);
        const children = parent.children;
        let onlyKbd = true;
        let onlyAnchorOrKbd = true;
        if (children && children.length > 0) {
            for (let i = 0; i < children.length; i++) {
                const tag = children[i].tagName;
                if (!allowedInlineTags.has(tag)) onlyKbd = false;
                if (!(tag === 'A' || tag === 'KBD')) onlyAnchorOrKbd = false;
            }
        }
        if (!onlyKbd && onlyAnchorOrKbd) {
            // 情况 B：仅含 <a>/<kbd>，尝试模板替换以保留链接
            const changed = applyAnchorTemplate(parent, templates, dict, patternRules);
            if (changed) return changed;
            // 未命中模板则不整体替换
            return 0;
        } else if (!onlyKbd && !onlyAnchorOrKbd && children && children.length > 0) {
            // 复杂结构：放弃整体替换
            return 0;
        }
        const fullText = parent.textContent || '';
        const norm = normalizeKey(fullText);
        if (!norm || norm.length > 120) return 0;
        let replacement = dict[norm];
        // 如果没有直接命中，尝试按未规范化文本应用模式规则
        if (!replacement && patternRules && patternRules.length) {
            const byPattern = translateByPatterns(fullText, patternRules);
            if (typeof byPattern === 'string' && byPattern !== fullText) {
                replacement = byPattern;
            }
        }
        if (!replacement) return 0;
        // 如果 replacement 含 HTML 标签，则作为 innerHTML 应用；否则尝试保留 <kbd> 结构
        if (typeof replacement === 'string' && /<[^>]+>/.test(replacement)) {
            if (parent.innerHTML !== replacement) {
                parent.innerHTML = replacement;
                processedElementSet.add(parent);
                return 1;
            }
            return 0;
        } else {
            const next = String(replacement);
            // 若父元素包含一个或多个 <kbd>，尝试将 next 中对应字符替换为原 <kbd> 的 outerHTML
            const kbdNodes = parent.querySelectorAll('kbd');
            if (kbdNodes.length > 0) {
                let html = next;
                kbdNodes.forEach((k) => {
                    const token = (k.textContent || '').trim();
                    if (!token) return;
                    const re = new RegExp(escapeRegExp(token));
                    html = html.replace(re, k.outerHTML);
                });
                if (parent.innerHTML !== html) {
                    parent.innerHTML = html;
                    processedElementSet.add(parent);
                    return 1;
                }
                return 0;
            } else {
                if (parent.textContent !== next) {
                    parent.textContent = next;
                    processedElementSet.add(parent);
                    return 1;
                }
                return 0;
            }
        }
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
            // 先尝试以父元素整体文本进行替换（支持跨内联标签的整体翻译）
            replacedCount += tryTranslateByParentElement(textNode, dict, currentPatternRules, currentTemplates);
            if (isSkippable(textNode)) continue;
            replacedCount += translateTextNode(textNode, dict, currentPatternRules);
        }
        return replacedCount;
    }

    function translateAttributesInRoot(root, dict) {
        if (!root || !dict) return 0;
        let count = 0;
        try {
            const attrTargets = [
                ['placeholder'],
                ['title'],
                ['aria-label']
            ];
            const walker = (container) => {
                const all = container.querySelectorAll('*');
                all.forEach((el) => {
                    for (const attrs of attrTargets) {
                        for (const attr of attrs) {
                            if (!el.hasAttribute(attr)) continue;
                            const value = el.getAttribute(attr) || '';
                            const key = normalizeKey(value);
                            if (!key) continue;
                            const replacement = dict[key];
                            if (!replacement) continue;
                            if (replacement !== value) {
                                el.setAttribute(attr, replacement);
                                count++;
                            }
                        }
                    }
                });
            };
            if (root instanceof ShadowRoot || root instanceof Document || root instanceof HTMLElement) {
                walker(root);
            }
        } catch (_) {}
        return count;
    }

    function translateInAllShadowRoots(dict) {
        let count = 0;
        try {
            const all = document.querySelectorAll('*');
            all.forEach((el) => {
                const sr = el.shadowRoot;
                if (sr) {
                    count += translateInTree(sr, dict);
                    count += translateAttributesInRoot(sr, dict);
                }
            });
        } catch (_) {}
        return count;
    }

    // ---------------------------
    // 事件与观察
    // ---------------------------
    let currentPageKey = null;
    let currentDict = null;
    let scheduled = false;
    let currentPatternRules = [];
    let currentTemplates = Object.create(null);

    function applyTranslation(reason) {
        try {
            // 每次翻译重新计算已处理元素集合，避免动态更新后无法再次翻译
            processedElementSet = new WeakSet();
            const pageKey = detectActivePageKey();
            if (pageKey !== currentPageKey || !currentDict) {
                currentPageKey = pageKey;
                currentDict = buildDictionaryForPage(pageKey);
                currentPatternRules = buildPatternRulesForPage(pageKey);
                currentTemplates = buildTemplatesForPage(pageKey);
            }
            translateInTree(document.body, currentDict);
            translateAttributesInRoot(document, currentDict);
            translateInAllShadowRoots(currentDict);
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
                if (m.removedNodes && m.removedNodes.length) {
                    scheduleTranslate('mutation:childList:removed');
                    break;
                }
            } else if (m.type === 'characterData') {
                scheduleTranslate('mutation:char');
                break;
            } else if (m.type === 'attributes') {
                // GitHub 会通过切换类名/属性重绘部分节点
                if (m.attributeName === 'class' || m.attributeName === 'aria-label' || m.attributeName === 'data-view-component') {
                    scheduleTranslate('mutation:attr');
                    break;
                }
            }
        }
    });

    function startObserver() {
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
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


