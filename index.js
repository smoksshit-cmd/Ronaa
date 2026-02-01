// index.js — content script for Rona extension
// Встраивается в страницу чата/новелла-движка, добавляет панель управления генерацией изображений
// Поддерживает: Nanobanana, NovelAI, оба; собирает промпт в указанном порядке
// Хранит настройки в chrome.storage.local

(function () {
  'use strict';

  // ======= Конфигурация =======
  const DEFAULT_SETTINGS = {
    proxyUrl: '', // формат: https://domain/(nanobanana|novelai)/KEY
    useNanobanana: true,
    useNovelAI: false,
    includeCharacterAppearance: true,
    includeUserAppearance: false,
    autoGenerate: true,
    positivePrompt: '',
    negativePrompt: '',
    styleTag: '',
    width: 1024,
    height: 1024,
  };

  // Селекторы — адаптируй под конкретный движок
  const SELECTORS = {
    messagesContainer: 'body', // попробуем наблюдать за всем документом — потом можно задать конкретнее
    messageItem: '.message, .chat-line, .chat-message, .st-chat-message',
    lastMessageSelector: '.message:last-of-type, .chat-line:last-of-type, .chat-message:last-of-type'
  };

  // ======= Утилиты =======
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  function log(...args) { console.log('[Rona]', ...args); }

  // Работа с chrome.storage (поддержка Firefox через browser)
  const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : (typeof browser !== 'undefined' && browser.storage && browser.storage.local ? browser.storage.local : null);

  function getSettings() {
    return new Promise((resolve) => {
      if (!storage) return resolve(DEFAULT_SETTINGS);
      storage.get(Object.keys(DEFAULT_SETTINGS), (items) => {
        const s = Object.assign({}, DEFAULT_SETTINGS, items);
        resolve(s);
      });
    });
  }

  function setSettings(newSettings) {
    return new Promise((resolve) => {
      if (!storage) return resolve();
      storage.set(newSettings, () => resolve());
    });
  }

  function parseProxyUrl(url) {
    // Ожидается примерно: https://site/path/(nanobanana|novelai)/USERKEY
    try {
      if (!url) return null;
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      // ищем 'nanobanana' или 'novelai' в пути
      const serviceIndex = parts.findIndex(p => /nanobanana|novelai/i.test(p));
      if (serviceIndex === -1) return null;
      const service = parts[serviceIndex].toLowerCase();
      const key = parts[serviceIndex + 1] || '';
      const base = `${u.protocol}//${u.host}/${parts.slice(0, serviceIndex).join('/')}`.replace(/\/$/, '');
      return { base, service, key, raw: url };
    } catch (e) {
      return null;
    }
  }

  // Попыточный сбор описания внешности из карточек персонажа/юзера
  function extractAppearanceFromDOM() {
    const candidates = [];
    // возможные селекторы где бывает описание
    const selectors = [
      '.character-card .description',
      '.character-card .appearance',
      '.char-desc',
      '.profile-description',
      '[data-character-description]',
      '.user-card .description',
      '.profile-bio',
      '.persona-description'
    ];

    for (const sel of selectors) {
      const els = $$(sel);
      for (const el of els) {
        const text = el.innerText.trim();
        if (text && text.length > 10) candidates.push(text);
      }
    }

    // ещё можно искать data-аттрибуты
    const dataAttrs = ['data-appearance', 'data-description', 'data-bio'];
    for (const a of dataAttrs) {
      const els = Array.from(document.querySelectorAll(`[${a}]`));
      for (const el of els) {
        const text = el.getAttribute(a).trim();
        if (text && text.length > 5) candidates.push(text);
      }
    }

    // Вернуть наиболее длинный кандидат как наиболее детализированный
    candidates.sort((a, b) => b.length - a.length);
    return candidates.length ? candidates[0] : '';
  }

  // Получаем текущюю одежду (тоже из DOM)
  function extractClothingFromDOM() {
    const selectors = ['.character-card .clothing', '.current-clothes', '[data-clothing]'];
    for (const sel of selectors) {
      const el = $(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    return '';
  }

  // Получаем последнее сообщение персонажа — попытаемся вернуть текст и DOM-элемент
  function findLastCharacterMessage() {
    // Пробуем несколько стратегий
    const messageSelectors = ['.message', '.chat-line', '.chat-message', '.st-chat-message'];
    let last = null;
    for (const sel of messageSelectors) {
      const all = $$(sel);
      if (all.length) last = all[all.length - 1];
    }
    if (!last) last = document.body;
    const text = (last && last.innerText) ? last.innerText.trim() : '';
    return { el: last, text };
  }

  // Сбор промпта в нужном порядке
  function buildPrompt(settings, sceneText) {
    const parts = [];
    // 1. Positive + [STYLE: fixed]
    if (settings.positivePrompt && settings.positivePrompt.trim()) parts.push(settings.positivePrompt.trim());
    if (settings.styleTag && settings.styleTag.trim()) parts.push(`[STYLE: ${settings.styleTag.trim()}]`);

    // 2. [Character Reference: внешность]
    if (settings.includeCharacterAppearance) {
      const char = extractAppearanceFromDOM();
      if (char) parts.push(`[Character Reference: ${char}]`);
    }

    // 3. [User Reference: внешность]
    if (settings.includeUserAppearance) {
      // Часто профиль юзера в каких-то селекторах
      const user = (function () {
        const selectors = ['.user-profile .appearance', '.user-card .appearance', '[data-user-appearance]'];
        for (const s of selectors) {
          const el = $(s);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return '';
      })();
      if (user) parts.push(`[User Reference: ${user}]`);
    }

    // 4. Current Clothing
    const clothing = extractClothingFromDOM();
    if (clothing) parts.push(`[Current Clothing: ${clothing}]`);

    // 5. Основной промпт сцены
    if (sceneText && sceneText.trim()) parts.push(sceneText.trim());

    // 6. [AVOID: negative]
    if (settings.negativePrompt && settings.negativePrompt.trim()) parts.push(`[AVOID: ${settings.negativePrompt.trim()}]`);

    return parts.join('\n\n');
  }

  // Формируем запрос к прокси — разные пути для nanobanana/novelai
  function buildProxyRequest(proxyRawUrl, service, key, prompt, settings) {
    // Если raw url уже включает service/key — используем как есть
    const parsed = parseProxyUrl(proxyRawUrl);
    if (parsed && parsed.raw) {
      // Если parsed указывает конкретный сервис и он совпадает — используем raw
      if (parsed.service === service) {
        return { url: proxyRawUrl, body: { prompt, width: settings.width, height: settings.height } };
      }
    }

    // Иначе строим URL: base + /service/key
    try {
      const u = new URL(proxyRawUrl);
      const base = `${u.origin}${u.pathname.replace(/\/$/, '')}`;
      const url = `${base}/${service}/${key}`;
      return { url, body: { prompt, width: settings.width, height: settings.height } };
    } catch (e) {
      // fallback — отправляем на raw
      return { url: proxyRawUrl, body: { prompt, width: settings.width, height: settings.height } };
    }
  }

  async function fetchFromProxy(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Proxy error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json;
  }

  // Получаем итоговые изображения и вставляем в DOM
  function insertImagesUnderMessage(images, messageEl, sourceTag = '') {
    if (!messageEl) messageEl = document.body;
    const container = document.createElement('div');
    container.className = 'rona-image-block';
    container.style.cssText = 'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start;';

    images.forEach((imgData, i) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'max-width:45%;';

      const label = document.createElement('div');
      label.innerText = sourceTag ? `${sourceTag} ${i + 1}` : `Image ${i + 1}`;
      label.style.fontSize = '12px';
      label.style.opacity = '0.8';

      const img = document.createElement('img');
      img.style.maxWidth = '100%';
      img.style.borderRadius = '6px';
      // ожидаем что imgData либо {b64: '...'} либо {url: '...'}
      if (imgData.url) img.src = imgData.url;
      else if (imgData.b64) img.src = `data:image/png;base64,${imgData.b64}`;
      else img.alt = 'image';

      wrap.appendChild(label);
      wrap.appendChild(img);
      container.appendChild(wrap);
    });

    messageEl.appendChild(container);
  }

  // Основная логика генерации
  async function generateForScene(settings, sceneText, messageEl) {
    if (!settings.proxyUrl) throw new Error('Proxy URL not set');
    const prompt = buildPrompt(settings, sceneText);
    log('Built prompt:', prompt);

    const parsed = parseProxyUrl(settings.proxyUrl);

    const tasks = [];
    if (settings.useNanobanana) {
      // если parsed.service совпадает/или не
      const { url, body } = buildProxyRequest(settings.proxyUrl, 'nanobanana', (parsed && parsed.service === 'nanobanana') ? parsed.key : (parsed && parsed.key) || '', prompt, settings);
      tasks.push(fetchFromProxy(url, body).then(json => ({ service: 'Nanobanana', json })).catch(err => ({ service: 'Nanobanana', error: err.message })));
    }
    if (settings.useNovelAI) {
      const { url, body } = buildProxyRequest(settings.proxyUrl, 'novelai', (parsed && parsed.service === 'novelai') ? parsed.key : (parsed && parsed.key) || '', prompt, settings);
      tasks.push(fetchFromProxy(url, body).then(json => ({ service: 'NovelAI', json })).catch(err => ({ service: 'NovelAI', error: err.message })));
    }

    const results = await Promise.all(tasks);
    for (const r of results) {
      if (r.error) {
        log('Service error', r.service, r.error);
        // можно вставлять нотификацию
        const errDiv = document.createElement('div');
        errDiv.innerText = `Rona: ${r.service} error: ${r.error}`;
        errDiv.style.color = 'red';
        messageEl.appendChild(errDiv);
        continue;
      }

      // ожидаем общую структуру ответа: { images: [{url:...}|{b64:...}], meta: {...} }
      const json = r.json;
      const images = [];
      if (Array.isArray(json.images)) {
        for (const it of json.images) images.push(it);
      } else if (json.image) {
        images.push({ b64: json.image });
      } else if (json.data && Array.isArray(json.data)) {
        for (const d of json.data) {
          if (d.url) images.push({ url: d.url });
          else if (d.b64) images.push({ b64: d.b64 });
        }
      }

      if (images.length) insertImagesUnderMessage(images, messageEl, r.service);
      else log('No images returned from', r.service, json);
    }

    return prompt;
  }

  // ======= UI =======
  let panel = null;
  let lastPromptCache = null;

  function createPanel(initialSettings) {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'rona-panel';
    panel.style.cssText = 'position:fixed; right:12px; bottom:12px; width:360px; max-width:calc(100% - 24px); background:rgba(20,20,20,0.95); color:#fff; padding:12px; border-radius:12px; box-shadow:0 6px 20px rgba(0,0,0,0.5); z-index:2147483647; font-family:Arial, sans-serif; font-size:13px;';

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <strong>Rona — image generator</strong>
        <button id="rona-toggle-panel" title="Close" style="background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer">✕</button>
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
        <input id="rona-proxy" placeholder="Proxy URL (https://.../novelai/KEY)" style="flex:1; padding:6px; border-radius:6px; border:none;" />
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
        <label><input type="checkbox" id="rona-nanobanana"> Nanobanana</label>
        <label><input type="checkbox" id="rona-novelai"> NovelAI</label>
      </div>
      <div style="margin-top:8px;">
        <label>Positive prompt</label>
        <textarea id="rona-positive" rows="2" style="width:100%; border-radius:6px; padding:6px; border:none; resize:vertical"></textarea>
      </div>
      <div style="margin-top:8px;">
        <label>Negative prompt</label>
        <textarea id="rona-negative" rows="2" style="width:100%; border-radius:6px; padding:6px; border:none; resize:vertical"></textarea>
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
        <input id="rona-style" placeholder="Style tag (e.g. [STYLE: anime])" style="flex:1; padding:6px; border-radius:6px; border:none;" />
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center; justify-content:space-between;">
        <label><input type="checkbox" id="rona-include-char"> include character appearance</label>
        <label><input type="checkbox" id="rona-include-user"> include user appearance</label>
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center; justify-content:space-between;">
        <label><input type="checkbox" id="rona-auto"> auto generate on new messages</label>
        <button id="rona-regenerate" style="padding:6px 8px; border-radius:6px; border:none; cursor:pointer">Regenerate</button>
      </div>
      <div id="rona-status" style="margin-top:8px; font-size:12px; opacity:0.9"></div>
    `;

    document.body.appendChild(panel);

    // загрузка начальных значений
    $('#rona-proxy').value = initialSettings.proxyUrl || '';
    $('#rona-nanobanana').checked = !!initialSettings.useNanobanana;
    $('#rona-novelai').checked = !!initialSettings.useNovelAI;
    $('#rona-positive').value = initialSettings.positivePrompt || '';
    $('#rona-negative').value = initialSettings.negativePrompt || '';
    $('#rona-style').value = initialSettings.styleTag || '';
    $('#rona-include-char').checked = !!initialSettings.includeCharacterAppearance;
    $('#rona-include-user').checked = !!initialSettings.includeUserAppearance;
    $('#rona-auto').checked = !!initialSettings.autoGenerate;

    // события
    $('#rona-toggle-panel').addEventListener('click', () => panel.remove());

    $('#rona-proxy').addEventListener('change', async (e) => {
      await setSettings({ proxyUrl: e.target.value });
      $('#rona-status').innerText = 'Proxy saved';
      setTimeout(() => $('#rona-status').innerText = '', 2000);
    });

    const saveCheckbox = async (id, key) => {
      const el = $(id);
      el.addEventListener('change', async (e) => {
        const payload = {};
        payload[key] = e.target.checked;
        await setSettings(payload);
      });
    };

    saveCheckbox('#rona-nanobanana', 'useNanobanana');
    saveCheckbox('#rona-novelai', 'useNovelAI');
    saveCheckbox('#rona-include-char', 'includeCharacterAppearance');
    saveCheckbox('#rona-include-user', 'includeUserAppearance');
    saveCheckbox('#rona-auto', 'autoGenerate');

    $('#rona-positive').addEventListener('change', (e) => setSettings({ positivePrompt: e.target.value }));
    $('#rona-negative').addEventListener('change', (e) => setSettings({ negativePrompt: e.target.value }));
    $('#rona-style').addEventListener('change', (e) => setSettings({ styleTag: e.target.value }));

    $('#rona-regenerate').addEventListener('click', async () => {
      $('#rona-status').innerText = 'Regenerating...';
      const settings = await getSettings();
      const lastMsg = findLastCharacterMessage();
      try {
        lastPromptCache = await generateForScene(settings, lastMsg.text, lastMsg.el);
        $('#rona-status').innerText = 'Done';
      } catch (err) {
        $('#rona-status').innerText = `Error: ${err.message}`;
      }
      setTimeout(() => { if ($('#rona-status')) $('#rona-status').innerText = ''; }, 3000);
    });

    return panel;
  }

  // ======= Наблюдатель за новыми сообщениями =======
  function observeMessages(settings) {
    // Попробуем найти контейнер сообщений по нескольким селекторам
    const containers = [];
    const candidateSelectors = ['.messages', '.chat-messages', '#messages', '.conversation', '.st-chat'];
    for (const s of candidateSelectors) {
      const el = $(s);
      if (el) containers.push(el);
    }

    // если не нашли — используем body
    const root = containers.length ? containers[0] : document.body;

    const observer = new MutationObserver(async (mutations) => {
      // ищем добавленные ноды, пытаемся понять новое сообщение
      for (const m of mutations) {
        if (!m.addedNodes || m.addedNodes.length === 0) continue;
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          // простая эвристика: если добавлен элемент с классом message/chat-line — вероятно новое сообщение
          if (/(message|chat|line|st-chat)/i.test(n.className || n.classList?.value || '')) {
            if (!settings.autoGenerate) return;
            // небольшая задержка, чтобы текст успел появиться
            await new Promise(r => setTimeout(r, 150));
            const last = findLastCharacterMessage();
            // собираем промпт и запускаем генерацию
            try {
              $('#rona-status').innerText = 'Auto-generating...';
              lastPromptCache = await generateForScene(settings, last.text, last.el);
              $('#rona-status').innerText = 'Auto-generated';
              setTimeout(() => { if ($('#rona-status')) $('#rona-status').innerText = ''; }, 2500);
            } catch (err) {
              $('#rona-status').innerText = `Error: ${err.message}`;
              setTimeout(() => { if ($('#rona-status')) $('#rona-status').innerText = ''; }, 5000);
            }
          }
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    log('Rona: observing messages on', root);
    return observer;
  }

  // ======= Инициализация =======
  async function init() {
    const settings = await getSettings();
    createPanel(settings);
    // Наблюдаем
    observeMessages(settings);

    // Listen to external settings changes (если пользователь изменит где-то ещё)
    if (storage && storage.onChanged) {
      storage.onChanged.addListener(async (changes) => {
        const s = await getSettings();
        // обновим панель значения, если открыта
        if ($('#rona-proxy')) $('#rona-proxy').value = s.proxyUrl || '';
        if ($('#rona-nanobanana')) $('#rona-nanobanana').checked = !!s.useNanobanana;
        if ($('#rona-novelai')) $('#rona-novelai').checked = !!s.useNovelAI;
        if ($('#rona-positive')) $('#rona-positive').value = s.positivePrompt || '';
        if ($('#rona-negative')) $('#rona-negative').value = s.negativePrompt || '';
        if ($('#rona-style')) $('#rona-style').value = s.styleTag || '';
        if ($('#rona-include-char')) $('#rona-include-char').checked = !!s.includeCharacterAppearance;
        if ($('#rona-include-user')) $('#rona-include-user').checked = !!s.includeUserAppearance;
        if ($('#rona-auto')) $('#rona-auto').checked = !!s.autoGenerate;
      });
    }

    log('Rona initialized');
  }

  // Запускаем
  init();

})();
