import {
    saveSettingsDebounced,
    getContext,
    extension_settings,
    callPopup,
    getCharacters,
    this_chid,
    saveChat,
    chat,
    eventSource,
    event_types,
} from "../../../script.js";

const MODULE_NAME = 'rona_image_gen';
const processingMessages = new Set();
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function ronaLog(level, ...args) {
    // console.log(`[Rona]`, ...args); // Раскомментируй для отладки
}

function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rona-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Rona');
}

// Настройки по умолчанию
const defaultSettings = {
    enabled: true,
    autoGenerate: true,
    useBanana: false,
    bananaUrl: '', 
    useNovelAI: true,
    novelaiUrl: '', 
    positivePrompt: 'masterpiece, best quality, detailed',
    negativePrompt: 'low quality, blurry, deformed, ugly, bad anatomy, text, watermark',
    fixedStyle: '',
    fixedStyleEnabled: false,
    charAppearance: '', 
    userAppearance: '', 
    autoParseAppearance: true,
    detectClothing: true,
    clothingSearchDepth: 5,
    includeScene: true,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // Дополняем отсутствующие ключи
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
}

// === ЛОГИКА КОНТЕКСТА ===

function getSceneFromLastMessage() {
    try {
        if (!chat || chat.length === 0) return null;
        
        // Ищем последнее сообщение (не юзера)
        const lastMsg = [...chat].reverse().find(msg => !msg.is_user && msg.mes);
        if (!lastMsg) return null;
        
        let text = lastMsg.mes.replace(/<[^>]+>/g, ' ').trim();
        
        // Ищем действия в звездочках (*действия*)
        const actions = [];
        const matches = text.matchAll(/[*_]([^*_]{2,})[*_]/g); 
        for (const m of matches) actions.push(m[1].trim());
        
        let scene = '';
        if (actions.length > 0) {
            scene = actions.slice(0, 3).join(', ');
        } else {
            // Если действий нет, берем первое предложение
            const sentences = text.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
            scene = sentences[0] || '';
        }
        
        scene = scene.substring(0, 300).replace(/[\r\n]+/g, ' ');
        return scene.length < 3 ? null : scene;
    } catch (e) { return null; }
}

function detectClothingFromChat(depth = 5) {
    try {
        if (!chat || chat.length === 0) return null;
        const characters = getCharacters(); // Используем импортированную функцию
        const charName = characters[this_chid]?.name || 'Character';
        
        const patterns = [
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on)[:\s]+([^.;!?\n]{5,100})/gi,
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,100})/gi,
        ];
        
        const found = [];
        const seen = new Set();
        const start = Math.max(0, chat.length - depth);
        
        for (let i = chat.length - 1; i >= start; i--) {
            const msg = chat[i];
            if (!msg.mes) continue;
            for (const pattern of patterns) {
                pattern.lastIndex = 0;
                for (const match of msg.mes.matchAll(pattern)) {
                    const clothing = (match[1] || match[0]).trim();
                    if (clothing.length > 3 && !seen.has(clothing.toLowerCase())) {
                        seen.add(clothing.toLowerCase());
                        found.push(clothing);
                    }
                }
            }
        }
        return found.length === 0 ? null : `${charName} wearing: ${found.slice(0, 2).join(', ')}`;
    } catch (e) { return null; }
}

function autoParseAppearance() {
    try {
        if (this_chid === undefined) return null;
        const characters = getCharacters();
        const char = characters[this_chid];
        if (!char) return null;
        
        const desc = char.description || '';
        const name = char.name || 'Character';
        
        // 1. Блок [Appearance]
        const blockMatch = desc.match(/\[Appearance[:\]]\s*([^\[]{10,500})/i);
        if (blockMatch) return `${name}: ${blockMatch[1].trim().replace(/\n/g, ', ')}`;
        
        // 2. Отдельные черты
        const traits = [];
        const hairMatch = desc.match(/([a-zA-Z,\s]+) hair/i);
        if (hairMatch) traits.push(`${hairMatch[1].trim()} hair`);
        
        const eyesMatch = desc.match(/([a-zA-Z,\s]+) eyes/i);
        if (eyesMatch) traits.push(`${eyesMatch[1].trim()} eyes`);
        
        if (traits.length > 0) return `${name}: ${traits.join(', ')}`;
        
        // 3. Просто начало описания (резерв)
        if (desc.length > 0) {
            const cleanDesc = desc.replace(/[\r\n]+/g, ' ').substring(0, 300);
            return `${name}: ${cleanDesc}`;
        }
        return null;
    } catch (e) { return null; }
}

function buildFullPrompt() {
    const settings = getSettings();
    const parts = [];
    
    if (settings.positivePrompt) parts.push(settings.positivePrompt);
    if (settings.fixedStyleEnabled && settings.fixedStyle) parts.push(`(Style: ${settings.fixedStyle})`);
    
    let charApp = settings.charAppearance;
    if (!charApp && settings.autoParseAppearance) charApp = autoParseAppearance();
    if (charApp) parts.push(charApp);
    
    if (settings.userAppearance) parts.push(settings.userAppearance);
    
    if (settings.detectClothing) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth);
        if (clothing) parts.push(clothing);
    }
    
    if (settings.includeScene) {
        const scene = getSceneFromLastMessage();
        if (scene) parts.push(scene);
    }
    
    return parts.join(', ');
}

// === ГЕНЕРАЦИЯ ===

function encodePromptForUrl(prompt) {
    let clean = prompt.trim().replace(/\s+/g, ' ');
    clean = clean.replace(/ /g, '_'); // Nano/NovelAI любят подчеркивания
    return encodeURIComponent(clean);
}

async function performRequest(baseUrl, prompt) {
    if (!baseUrl) throw new Error('URL не настроен');
    
    const cleanUrl = baseUrl.replace(/\/$/, '');
    const encodedPrompt = encodePromptForUrl(prompt);
    const finalUrl = `${cleanUrl}/prompt/${encodedPrompt}`;
    
    const response = await fetch(finalUrl, {
        method: 'GET',
        headers: { 
            'Accept': 'image/*, application/json',
            'User-Agent': 'SillyTavern-Rona'
        }
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
        const result = await response.json();
        if (result.output) return `data:image/png;base64,${result.output}`;
        if (result.image) return `data:image/png;base64,${result.image}`;
        if (result.images && result.images[0]) return `data:image/png;base64,${result.images[0]}`;
        // Gemini/Google
        if (result.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
            return `data:${result.candidates[0].content.parts[0].inlineData.mimeType};base64,${result.candidates[0].content.parts[0].inlineData.data}`;
        }
        if (result.url) {
            const imgResp = await fetch(result.url);
            return await blobToDataUrl(await imgResp.blob());
        }
        throw new Error('JSON получен, картинки нет');
    }
    
    const blob = await response.blob();
    return await blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function generateImage(onStatus) {
    const settings = getSettings();
    const prompt = buildFullPrompt();
    
    if (!settings.useBanana && !settings.useNovelAI) throw new Error('Провайдер не выбран!');
    
    const results = [];
    
    if (settings.useNovelAI) {
        onStatus?.('NovelAI...');
        try {
            const res = await performRequest(settings.novelaiUrl, prompt);
            results.push({ dataUrl: res });
        } catch (e) {
            if (!settings.useBanana) throw e;
        }
    }
    
    if (settings.useBanana && results.length === 0) {
        onStatus?.('Banana...');
        try {
            const res = await performRequest(settings.bananaUrl, prompt);
            results.push({ dataUrl: res });
        } catch (e) { throw e; }
    }
    
    return results;
}

// === СОХРАНЕНИЕ ===

async function saveImageToFile(dataUrl) {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Bad Base64');
    
    const format = match[1];
    const base64Data = match[2];
    
    const characters = getCharacters();
    const charName = characters[this_chid]?.name || 'rona';
    const filename = `rona_${charName}_${Date.now()}`;
    
    // Получаем хедеры для запроса (CSRF и т.д.)
    const headers = getContext().getRequestHeaders ? getContext().getRequestHeaders() : { 'Content-Type': 'application/json' };

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) throw new Error('Ошибка сохранения');
    return (await response.json()).path;
}

// === UI И ОБРАБОТЧИКИ ===

async function processMessage(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenerate) return;
    if (processingMessages.has(messageId)) return;
    
    // ВАЖНО: chat - массив сообщений. Ищем по индексу или перебором
    let message = chat[messageId];
    // Если messageId не индекс, а реальный ID (зависит от версии ST), ищем вручную:
    if (!message) message = chat.find(m => m.mesId === messageId);
    
    if (!message || message.is_user || message.rona_generated) return;
    
    processingMessages.add(messageId);
    
    const msgEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!msgEl) { processingMessages.delete(messageId); return; }
    
    const textEl = msgEl.querySelector('.mes_text');
    const placeholder = document.createElement('div');
    placeholder.innerHTML = `<small>🎨 Rona: Рисую...</small>`;
    textEl.appendChild(placeholder);
    
    try {
        const results = await generateImage((s) => placeholder.innerText = `🎨 ${s}`);
        
        const paths = [];
        for (const res of results) paths.push(await saveImageToFile(res.dataUrl));
        
        const imgContainer = document.createElement('div');
        imgContainer.style.marginTop = '10px';
        paths.forEach(path => {
            const img = document.createElement('img');
            img.src = path;
            img.style.maxWidth = '100%';
            img.style.borderRadius = '8px';
            img.style.cursor = 'pointer';
            img.onclick = () => window.open(path, '_blank');
            imgContainer.appendChild(img);
        });
        
        placeholder.replaceWith(imgContainer);
        message.rona_generated = true;
        message.rona_paths = paths;
        saveChat(); // Импортированная функция
        
    } catch (e) {
        placeholder.innerText = `❌ ${e.message}`;
        toastr.error(e.message);
    } finally {
        processingMessages.delete(messageId);
    }
}

function addRegenerateButton(msgEl, messageId) {
    if (msgEl.querySelector('.rona-regen')) return;
    const extra = msgEl.querySelector('.extraMesButtons');
    if (!extra) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button rona-regen fa-solid fa-paintbrush interactable';
    btn.title = 'Rona: Нарисовать';
    btn.onclick = () => {
        const message = chat[messageId];
        if (message) message.rona_generated = false;
        processMessage(messageId);
    };
    extra.appendChild(btn);
}

function createSettingsUI() {
    const settings = getSettings();
    const container = $('#extensions_settings'); // Используем jQuery глобально или импорт
    if (container.length === 0) return;
    
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🎨 Rona: Генератор</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="rona_enabled" ${settings.enabled ? 'checked' : ''}> Включено</label>
            <label class="checkbox_label"><input type="checkbox" id="rona_auto" ${settings.autoGenerate ? 'checked' : ''}> Авто-генерация</label>
            <hr>
            <label>NovelAI URL (с ключом):</label>
            <input type="text" class="text_pole" id="rona_nai_url" value="${settings.novelaiUrl}" placeholder="https://aituned.xyz/v1/novelai/KEY">
            
            <label>Nano-Banana URL (с ключом):</label>
            <input type="text" class="text_pole" id="rona_banana_url" value="${settings.bananaUrl}" placeholder="https://aituned.xyz/v1/nano-banana/KEY">
            <hr>
            <label>Позитивный промпт:</label>
            <textarea class="text_pole" id="rona_pos">${settings.positivePrompt}</textarea>
            
            <label>Стиль:</label>
            <input type="text" class="text_pole" id="rona_style" value="${settings.fixedStyle}">
            <label class="checkbox_label"><input type="checkbox" id="rona_style_on" ${settings.fixedStyleEnabled ? 'checked' : ''}> Применять стиль</label>
            <hr>
            <label>Внешность Персонажа:</label>
            <textarea class="text_pole" id="rona_char">${settings.charAppearance}</textarea>
            <label class="checkbox_label"><input type="checkbox" id="rona_autoparse" ${settings.autoParseAppearance ? 'checked' : ''}> Авто-парсинг</label>
            
            <label>Внешность Юзера:</label>
            <textarea class="text_pole" id="rona_user">${settings.userAppearance}</textarea>
            
            <label class="checkbox_label"><input type="checkbox" id="rona_scene" ${settings.includeScene ? 'checked' : ''}> Считывать сцену</label>
        </div>
    </div>`;
    
    container.append(html);
    
    // Биндинг
    $('#rona_enabled').change(e => { settings.enabled = e.target.checked; saveSettings(); });
    $('#rona_auto').change(e => { settings.autoGenerate = e.target.checked; saveSettings(); });
    $('#rona_nai_url').on('input', e => { settings.novelaiUrl = e.target.value; saveSettings(); });
    $('#rona_banana_url').on('input', e => { settings.bananaUrl = e.target.value; saveSettings(); });
    $('#rona_pos').on('input', e => { settings.positivePrompt = e.target.value; saveSettings(); });
    $('#rona_style').on('input', e => { settings.fixedStyle = e.target.value; saveSettings(); });
    $('#rona_style_on').change(e => { settings.fixedStyleEnabled = e.target.checked; saveSettings(); });
    $('#rona_char').on('input', e => { settings.charAppearance = e.target.value; saveSettings(); });
    $('#rona_autoparse').change(e => { settings.autoParseAppearance = e.target.checked; saveSettings(); });
    $('#rona_user').on('input', e => { settings.userAppearance = e.target.value; saveSettings(); });
    $('#rona_scene').change(e => { settings.includeScene = e.target.checked; saveSettings(); });
}

// START
jQuery(async () => {
    getSettings();
    createSettingsUI();
    
    // Добавляем кнопки к уже загруженным сообщениям
    $('.mes').each(function() {
        const id = $(this).attr('mesid');
        if (id) addRegenerateButton(this, id);
    });
    
    // Слушаем рендер новых сообщений
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        const el = document.querySelector(`.mes[mesid="${id}"]`);
        if (el) {
            addRegenerateButton(el, id);
            processMessage(id);
        }
    });
});