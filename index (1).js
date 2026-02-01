/**
 * Rona - Auto Image Generation Extension for SillyTavern
 * 
 * Автоматически генерирует изображения через aituned.xyz прокси
 * Поддержка Nano-Banana и NovelAI
 * 
 * @author smoksshit-cmd
 * @version 1.0.0
 */

const MODULE_NAME = 'rona_image_gen';

const processingMessages = new Set();
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function ronaLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    
    if (level === 'ERROR') console.error('[Rona]', ...args);
    else if (level === 'WARN') console.warn('[Rona]', ...args);
    else console.log('[Rona]', ...args);
}

function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rona-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Rona');
}

// ============ НАСТРОЙКИ ============

const defaultSettings = Object.freeze({
    enabled: true,
    autoGenerate: true,
    
    // Провайдеры
    useBanana: false,
    bananaUrl: '', // https://aituned.xyz/v1/nano-banana/KEY
    
    useNovelAI: true,
    novelaiUrl: '', // https://aituned.xyz/v1/novelai/KEY
    
    // Промпты (ПЕРВЫМИ в генерации)
    positivePrompt: 'masterpiece, best quality, detailed',
    negativePrompt: 'low quality, blurry, deformed, ugly, bad anatomy',
    
    // Фиксированный стиль (ПЕРВЫМ после positive)
    fixedStyle: '',
    fixedStyleEnabled: false,
    
    // РУЧНОЙ ВВОД внешности (надёжнее парсера)
    charAppearance: '', // Внешность {{char}} - вводится вручную
    userAppearance: '', // Внешность {{user}} - вводится вручную
    
    // Автопарсинг (опционально)
    autoParseAppearance: false,
    
    // Одежда из чата
    detectClothing: true,
    clothingSearchDepth: 5,
    
    // Сцена из сообщения
    includeScene: true,
});

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ============ ИЗВЛЕЧЕНИЕ КОНТЕКСТА ============

/**
 * Получить сцену из последнего сообщения персонажа
 * Берёт действия в *звёздочках* или первые предложения
 */
function getSceneFromLastMessage() {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return null;
        
        // Находим последнее сообщение персонажа
        let lastMsg = null;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && chat[i].mes) {
                lastMsg = chat[i].mes;
                break;
            }
        }
        if (!lastMsg) return null;
        
        // Убираем HTML
        let text = lastMsg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        
        // Извлекаем действия в *звёздочках* или _подчёркиваниях_
        const actions = [];
        const matches = text.matchAll(/[*_]([^*_]{10,200})[*_]/g);
        for (const m of matches) {
            actions.push(m[1].trim());
        }
        
        let scene = '';
        if (actions.length > 0) {
            // Берём первые 2 действия
            scene = actions.slice(0, 2).join(', ');
        } else {
            // Берём первые 2 предложения
            const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 15);
            scene = sentences.slice(0, 2).join('. ');
        }
        
        // Ограничиваем длину
        if (scene.length > 250) scene = scene.substring(0, 250);
        
        ronaLog('INFO', `Сцена: ${scene.substring(0, 80)}...`);
        return scene;
    } catch (e) {
        ronaLog('ERROR', 'Ошибка получения сцены:', e);
        return null;
    }
}

/**
 * Определить одежду из чата
 */
function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return null;
        
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        
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
        
        if (found.length === 0) return null;
        
        const result = `${charName} wearing: ${found.slice(0, 2).join(', ')}`;
        ronaLog('INFO', `Одежда: ${result}`);
        return result;
    } catch (e) {
        ronaLog('ERROR', 'Ошибка определения одежды:', e);
        return null;
    }
}

/**
 * Автопарсинг внешности из карточки (резервный вариант)
 */
function autoParseAppearance() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined) return null;
        
        const char = context.characters?.[context.characterId];
        if (!char?.description) return null;
        
        const desc = char.description;
        const name = char.name || 'Character';
        
        // Ищем блок [Appearance]
        const blockMatch = desc.match(/\[Appearance[:\]]\s*([^\[]{20,400})/i);
        if (blockMatch) {
            return `${name}: ${blockMatch[1].trim().substring(0, 300)}`;
        }
        
        // Собираем отдельные черты
        const traits = [];
        
        const hairMatch = desc.match(/(?:hair)[:\s]*([a-zA-Z\s\-,]+?)(?:[.;\n]|$)/i);
        if (hairMatch) traits.push(`hair: ${hairMatch[1].trim()}`);
        
        const eyesMatch = desc.match(/(?:eyes?)[:\s]*([a-zA-Z\s\-,]+?)(?:[.;\n]|$)/i);
        if (eyesMatch) traits.push(`eyes: ${eyesMatch[1].trim()}`);
        
        const genderMatch = desc.match(/(?:gender|sex)[:\s]*(male|female)/i);
        if (genderMatch) traits.push(genderMatch[1]);
        
        if (traits.length === 0) return null;
        return `${name}: ${traits.join(', ')}`;
    } catch (e) {
        ronaLog('ERROR', 'Ошибка автопарсинга:', e);
        return null;
    }
}

// ============ ПОСТРОЕНИЕ ПРОМПТА ============

/**
 * Собрать полный промпт в ПРАВИЛЬНОМ ПОРЯДКЕ:
 * 1. Positive промпт
 * 2. [STYLE: стиль]
 * 3. Внешность {{char}}
 * 4. Внешность {{user}}
 * 5. Одежда
 * 6. Сцена
 * 7. [AVOID: negative]
 */
function buildFullPrompt() {
    const settings = getSettings();
    const parts = [];
    
    // 1. POSITIVE ПРОМПТ (ПЕРВЫМ!)
    if (settings.positivePrompt) {
        parts.push(settings.positivePrompt);
        ronaLog('INFO', `[1] Positive: ${settings.positivePrompt.substring(0, 50)}`);
    }
    
    // 2. ФИКСИРОВАННЫЙ СТИЛЬ (ВТОРЫМ!)
    if (settings.fixedStyleEnabled && settings.fixedStyle) {
        parts.push(settings.fixedStyle);
        ronaLog('INFO', `[2] Style: ${settings.fixedStyle}`);
    }
    
    // 3. ВНЕШНОСТЬ {{char}}
    let charApp = settings.charAppearance;
    if (!charApp && settings.autoParseAppearance) {
        charApp = autoParseAppearance();
    }
    if (charApp) {
        parts.push(charApp);
        ronaLog('INFO', `[3] Char: ${charApp.substring(0, 50)}`);
    }
    
    // 4. ВНЕШНОСТЬ {{user}}
    if (settings.userAppearance) {
        parts.push(settings.userAppearance);
        ronaLog('INFO', `[4] User: ${settings.userAppearance.substring(0, 50)}`);
    }
    
    // 5. ОДЕЖДА
    if (settings.detectClothing) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth);
        if (clothing) {
            parts.push(clothing);
            ronaLog('INFO', `[5] Clothing: ${clothing.substring(0, 50)}`);
        }
    }
    
    // 6. СЦЕНА
    if (settings.includeScene) {
        const scene = getSceneFromLastMessage();
        if (scene) {
            parts.push(scene);
            ronaLog('INFO', `[6] Scene: ${scene.substring(0, 50)}`);
        }
    }
    
    // 7. NEGATIVE ПРОМПТ (ПОСЛЕДНИМ!)
    // Для NovelAI negative не добавляем в основной промпт - он обрабатывается отдельно
    // Но для других провайдеров добавим как [AVOID: ...]
    // Пока оставим без negative в основном промпте
    
    const fullPrompt = parts.join(', ');
    ronaLog('INFO', `=== ПОЛНЫЙ ПРОМПТ (${fullPrompt.length} символов) ===`);
    ronaLog('INFO', fullPrompt.substring(0, 300));
    
    return fullPrompt;
}

/**
 * Кодировать промпт для URL (пробелы → подчёркивания)
 */
function encodePromptForUrl(prompt) {
    return prompt
        .replace(/\s+/g, '_')
        .replace(/[^\w\-_.,!?а-яА-ЯёЁ]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 1500); // Ограничение длины URL
}

// ============ ГЕНЕРАЦИЯ ============

/**
 * Генерация через NovelAI (aituned.xyz)
 * Формат: GET https://aituned.xyz/v1/novelai/KEY/prompt/PROMPT_WITH_UNDERSCORES
 */
async function generateViaNovelAI(prompt) {
    const settings = getSettings();
    if (!settings.novelaiUrl) throw new Error('URL NovelAI не настроен');
    
    const baseUrl = settings.novelaiUrl.replace(/\/$/, '');
    const encodedPrompt = encodePromptForUrl(prompt);
    const url = `${baseUrl}/prompt/${encodedPrompt}`;
    
    ronaLog('INFO', `NovelAI запрос: ${url.substring(0, 100)}...`);
    
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'image/*, application/json' }
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`NovelAI Error (${response.status}): ${text.substring(0, 100)}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    // Изображение напрямую
    if (contentType.includes('image/')) {
        const blob = await response.blob();
        return await blobToDataUrl(blob);
    }
    
    // JSON ответ
    if (contentType.includes('application/json')) {
        const result = await response.json();
        if (result.output) return `data:image/png;base64,${result.output}`;
        if (result.image) return `data:image/png;base64,${result.image}`;
        if (result.images?.[0]) return `data:image/png;base64,${result.images[0]}`;
        if (result.url) {
            const imgResp = await fetch(result.url);
            return await blobToDataUrl(await imgResp.blob());
        }
        throw new Error('Изображение не найдено в ответе');
    }
    
    // Попытка как blob
    const blob = await response.blob();
    if (blob.size > 1000) return await blobToDataUrl(blob);
    
    throw new Error('Неизвестный формат ответа');
}

/**
 * Генерация через Nano-Banana (aituned.xyz)
 */
async function generateViaBanana(prompt) {
    const settings = getSettings();
    if (!settings.bananaUrl) throw new Error('URL Nano-Banana не настроен');
    
    const baseUrl = settings.bananaUrl.replace(/\/$/, '');
    const encodedPrompt = encodePromptForUrl(prompt);
    const url = `${baseUrl}/prompt/${encodedPrompt}`;
    
    ronaLog('INFO', `Banana запрос: ${url.substring(0, 100)}...`);
    
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'image/*, application/json' }
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Banana Error (${response.status}): ${text.substring(0, 100)}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('image/')) {
        return await blobToDataUrl(await response.blob());
    }
    
    if (contentType.includes('application/json')) {
        const result = await response.json();
        // Gemini формат
        if (result.candidates?.[0]?.content?.parts) {
            for (const part of result.candidates[0].content.parts) {
                if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
            }
        }
        if (result.output) return `data:image/png;base64,${result.output}`;
        if (result.image) return `data:image/png;base64,${result.image}`;
        throw new Error('Изображение не найдено в ответе');
    }
    
    const blob = await response.blob();
    if (blob.size > 1000) return await blobToDataUrl(blob);
    
    throw new Error('Неизвестный формат ответа');
}

async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Основная функция генерации
 */
async function generateImage(onStatus) {
    const settings = getSettings();
    
    if (!settings.useBanana && !settings.useNovelAI) {
        throw new Error('Выберите хотя бы один провайдер');
    }
    
    const prompt = buildFullPrompt();
    const results = [];
    const errors = [];
    
    if (settings.useNovelAI && settings.novelaiUrl) {
        try {
            onStatus?.('Генерация через NovelAI...');
            const result = await generateViaNovelAI(prompt);
            results.push({ provider: 'novelai', dataUrl: result });
            ronaLog('INFO', 'NovelAI: успех');
        } catch (e) {
            ronaLog('ERROR', 'NovelAI ошибка:', e.message);
            errors.push({ provider: 'novelai', error: e.message });
        }
    }
    
    if (settings.useBanana && settings.bananaUrl) {
        try {
            onStatus?.('Генерация через Nano-Banana...');
            const result = await generateViaBanana(prompt);
            results.push({ provider: 'banana', dataUrl: result });
            ronaLog('INFO', 'Banana: успех');
        } catch (e) {
            ronaLog('ERROR', 'Banana ошибка:', e.message);
            errors.push({ provider: 'banana', error: e.message });
        }
    }
    
    if (results.length === 0) {
        throw new Error(errors.map(e => `${e.provider}: ${e.error}`).join('; '));
    }
    
    return results;
}

// ============ СОХРАНЕНИЕ ИЗОБРАЖЕНИЙ ============

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Неверный формат data URL');
    
    const format = match[1];
    const base64Data = match[2];
    
    let charName = 'rona_gen';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'rona_gen';
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: `rona_${timestamp}`
        })
    });
    
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    ronaLog('INFO', 'Сохранено:', result.path);
    return result.path;
}

// ============ ОБРАБОТКА СООБЩЕНИЙ ============

function createLoadingPlaceholder() {
    const div = document.createElement('div');
    div.className = 'rona-loading';
    div.innerHTML = `
        <div class="rona-spinner"></div>
        <div class="rona-status">Генерация...</div>
    `;
    return div;
}

function createImageContainer(paths) {
    const div = document.createElement('div');
    div.className = 'rona-images';
    for (const path of paths) {
        const img = document.createElement('img');
        img.className = 'rona-image';
        img.src = path;
        img.alt = 'Generated by Rona';
        div.appendChild(img);
    }
    return div;
}

async function processMessage(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled || !settings.autoGenerate) return;
    if (processingMessages.has(messageId)) return;
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    if (message.rona_generated) return;
    
    processingMessages.add(messageId);
    ronaLog('INFO', `Обработка сообщения ${messageId}`);
    
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!msgEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    const textEl = msgEl.querySelector('.mes_text');
    if (!textEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    const placeholder = createLoadingPlaceholder();
    textEl.appendChild(placeholder);
    
    const statusEl = placeholder.querySelector('.rona-status');
    
    try {
        const results = await generateImage(s => { statusEl.textContent = s; });
        
        statusEl.textContent = 'Сохранение...';
        
        const paths = [];
        for (const r of results) {
            const path = await saveImageToFile(r.dataUrl);
            paths.push(path);
        }
        
        const container = createImageContainer(paths);
        placeholder.replaceWith(container);
        
        message.rona_generated = true;
        message.rona_paths = paths;
        
        toastr.success(`Готово: ${paths.length} изображений`, 'Rona');
        await context.saveChat();
        
    } catch (e) {
        ronaLog('ERROR', 'Ошибка:', e.message);
        placeholder.innerHTML = `<div class="rona-error">⚠️ ${e.message}</div>`;
        toastr.error(e.message, 'Rona');
    } finally {
        processingMessages.delete(messageId);
    }
}

async function regenerateImage(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) return;
    
    message.rona_generated = false;
    delete message.rona_paths;
    
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (msgEl) {
        msgEl.querySelectorAll('.rona-images, .rona-loading, .rona-error').forEach(el => el.remove());
    }
    
    await processMessage(messageId);
}

function addRegenerateButton(msgEl, messageId) {
    if (msgEl.querySelector('.rona-regen-btn')) return;
    
    const extra = msgEl.querySelector('.extraMesButtons');
    if (!extra) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button rona-regen-btn fa-solid fa-image interactable';
    btn.title = 'Перегенерировать (Rona)';
    btn.tabIndex = 0;
    btn.onclick = (e) => {
        e.stopPropagation();
        regenerateImage(messageId);
    };
    extra.appendChild(btn);
}

function addButtonsToAll() {
    const context = SillyTavern.getContext();
    if (!context.chat) return;
    
    document.querySelectorAll('#chat .mes').forEach(msgEl => {
        const id = msgEl.getAttribute('mesid');
        if (id === null) return;
        const msg = context.chat[parseInt(id)];
        if (msg && !msg.is_user) {
            addRegenerateButton(msgEl, parseInt(id));
        }
    });
}

async function onMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!msgEl) return;
    
    if (message && !message.is_user) {
        addRegenerateButton(msgEl, messageId);
    }
    
    if (settings.autoGenerate && message && !message.is_user) {
        await processMessage(messageId);
    }
}

// ============ UI НАСТРОЕК ============

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎨 Rona - Auto Image Generation</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="rona-settings">
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить Rona</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_auto" ${settings.autoGenerate ? 'checked' : ''}>
                        <span>Автогенерация в сообщения</span>
                    </label>
                    
                    <hr>
                    
                    <!-- ПРОВАЙДЕРЫ -->
                    <h4>🔌 Провайдеры</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_use_novelai" ${settings.useNovelAI ? 'checked' : ''}>
                        <span>NovelAI</span>
                    </label>
                    
                    <div id="rona_novelai_section" class="${!settings.useNovelAI ? 'hidden' : ''}">
                        <div class="rona-field">
                            <label>URL (с ключом)</label>
                            <input type="text" id="rona_novelai_url" class="text_pole" 
                                   value="${settings.novelaiUrl}" 
                                   placeholder="https://aituned.xyz/v1/novelai/sk_xxx">
                        </div>
                    </div>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_use_banana" ${settings.useBanana ? 'checked' : ''}>
                        <span>Nano-Banana</span>
                    </label>
                    
                    <div id="rona_banana_section" class="${!settings.useBanana ? 'hidden' : ''}">
                        <div class="rona-field">
                            <label>URL (с ключом)</label>
                            <input type="text" id="rona_banana_url" class="text_pole" 
                                   value="${settings.bananaUrl}" 
                                   placeholder="https://aituned.xyz/v1/nano-banana/sk_xxx">
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- ПРОМПТЫ -->
                    <h4>📝 Промпты (идут ПЕРВЫМИ)</h4>
                    
                    <div class="rona-field">
                        <label>Positive промпт</label>
                        <textarea id="rona_positive" class="text_pole" rows="2"
                                  placeholder="masterpiece, best quality...">${settings.positivePrompt}</textarea>
                    </div>
                    
                    <div class="rona-field">
                        <label>Negative промпт</label>
                        <textarea id="rona_negative" class="text_pole" rows="2"
                                  placeholder="low quality, blurry...">${settings.negativePrompt}</textarea>
                    </div>
                    
                    <hr>
                    
                    <!-- СТИЛЬ -->
                    <h4>🎨 Фиксированный стиль</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
                        <span>Включить</span>
                    </label>
                    
                    <div class="rona-field">
                        <label>Стиль (примеры: "Lo-fi retro anime", "Cyberpunk 2077", "Studio Ghibli")</label>
                        <input type="text" id="rona_style" class="text_pole" 
                               value="${settings.fixedStyle}"
                               placeholder="Lo-fi retro anime style, detailed">
                    </div>
                    
                    <hr>
                    
                    <!-- ВНЕШНОСТЬ -->
                    <h4>👤 Внешность персонажей</h4>
                    <p class="hint">Введи описание вручную для точного результата!</p>
                    
                    <div class="rona-field">
                        <label>Внешность {{char}}</label>
                        <textarea id="rona_char_appearance" class="text_pole" rows="3"
                                  placeholder="female, short, red hair in ponytails, green eyes, pale skin, cat-ear headphones">${settings.charAppearance}</textarea>
                    </div>
                    
                    <div class="rona-field">
                        <label>Внешность {{user}}</label>
                        <textarea id="rona_user_appearance" class="text_pole" rows="2"
                                  placeholder="male, tall, black hair, blue eyes">${settings.userAppearance}</textarea>
                    </div>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_auto_parse" ${settings.autoParseAppearance ? 'checked' : ''}>
                        <span>Автопарсинг из карточки (если поле пустое)</span>
                    </label>
                    
                    <hr>
                    
                    <!-- КОНТЕКСТ -->
                    <h4>📖 Контекст из чата</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_clothing" ${settings.detectClothing ? 'checked' : ''}>
                        <span>Определять одежду из чата</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_scene" ${settings.includeScene ? 'checked' : ''}>
                        <span>Включать сцену из сообщения</span>
                    </label>
                    
                    <hr>
                    
                    <!-- ОТЛАДКА -->
                    <div class="rona-field">
                        <button id="rona_export_logs" class="menu_button" style="width:100%">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </button>
                    </div>
                    
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    bindEvents();
}

function bindEvents() {
    const settings = getSettings();
    
    document.getElementById('rona_enabled')?.addEventListener('change', e => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_auto')?.addEventListener('change', e => {
        settings.autoGenerate = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_use_novelai')?.addEventListener('change', e => {
        settings.useNovelAI = e.target.checked;
        document.getElementById('rona_novelai_section')?.classList.toggle('hidden', !e.target.checked);
        saveSettings();
    });
    
    document.getElementById('rona_novelai_url')?.addEventListener('input', e => {
        settings.novelaiUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_use_banana')?.addEventListener('change', e => {
        settings.useBanana = e.target.checked;
        document.getElementById('rona_banana_section')?.classList.toggle('hidden', !e.target.checked);
        saveSettings();
    });
    
    document.getElementById('rona_banana_url')?.addEventListener('input', e => {
        settings.bananaUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_positive')?.addEventListener('input', e => {
        settings.positivePrompt = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_negative')?.addEventListener('input', e => {
        settings.negativePrompt = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_style_enabled')?.addEventListener('change', e => {
        settings.fixedStyleEnabled = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_style')?.addEventListener('input', e => {
        settings.fixedStyle = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_char_appearance')?.addEventListener('input', e => {
        settings.charAppearance = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_user_appearance')?.addEventListener('input', e => {
        settings.userAppearance = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_auto_parse')?.addEventListener('change', e => {
        settings.autoParseAppearance = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_clothing')?.addEventListener('change', e => {
        settings.detectClothing = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_scene')?.addEventListener('change', e => {
        settings.includeScene = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_export_logs')?.addEventListener('click', exportLogs);
}

// ============ ИНИЦИАЛИЗАЦИЯ ============

(function init() {
    const context = SillyTavern.getContext();
    
    getSettings();
    
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToAll();
        console.log('[Rona] Загружена');
    });
    
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(addButtonsToAll, 100);
    });
    
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    
    console.log('[Rona] Инициализирована');
})();
