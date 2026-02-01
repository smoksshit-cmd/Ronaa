/**
 * Rona - Auto Image Generation Extension for SillyTavern
 * 
 * Автоматически генерирует изображения в сообщениях персонажей
 * через nano-banana и/или NovelAI прокси.
 * 
 * @author smoksshit-cmd
 * @version 1.0.0
 */

const MODULE_NAME = 'rona_image_gen';

// Отслеживание обрабатываемых сообщений
const processingMessages = new Set();

// Буфер логов для отладки
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function ronaLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    
    if (level === 'ERROR') {
        console.error('[Rona]', ...args);
    } else if (level === 'WARN') {
        console.warn('[Rona]', ...args);
    } else {
        console.log('[Rona]', ...args);
    }
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rona-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Rona');
}

// Настройки по умолчанию
const defaultSettings = Object.freeze({
    enabled: true,
    autoGenerate: true, // Автоматическая генерация
    
    // Nano-Banana настройки
    useBanana: true,
    bananaUrl: '', // формат: https://proxy.example.com/nano-banana/YOUR_KEY
    bananaAspectRatio: '2:3',
    bananaImageSize: '1K',
    
    // NovelAI настройки
    useNovelAI: false,
    novelaiUrl: '', // формат: https://proxy.example.com/novelai/YOUR_KEY
    novelaiModel: 'nai-diffusion-3',
    novelaiWidth: 832,
    novelaiHeight: 1216,
    novelaiSampler: 'k_euler',
    novelaiSteps: 28,
    novelaiScale: 5,
    
    // Общие настройки промптов
    positivePrompt: 'masterpiece, best quality, detailed, sharp focus',
    negativePrompt: 'low quality, blurry, deformed, ugly, bad anatomy, watermark, signature, text',
    fixedStyle: '',
    fixedStyleEnabled: false,
    
    // Извлечение контекста
    extractCharAppearance: true,
    extractUserAppearance: true,
    detectClothing: true,
    clothingSearchDepth: 5,
    
    // Сцена
    analyzeScene: true, // Анализировать что происходит в сцене
});

/**
 * Получить настройки расширения
 */
function getSettings() {
    const context = SillyTavern.getContext();
    
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    
    // Добавить отсутствующие ключи
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Сохранить настройки
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

/**
 * Конвертировать изображение URL в base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        ronaLog('ERROR', 'Ошибка конвертации изображения:', error);
        return null;
    }
}

/**
 * Сохранить base64 изображение в файл
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Неверный формат data URL');
    }
    
    const format = match[1];
    const base64Data = match[2];
    
    let charName = 'rona_generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'rona_generated';
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `rona_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    ronaLog('INFO', 'Изображение сохранено:', result.path);
    return result.path;
}

/**
 * Получить аватар персонажа как base64
 */
async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        
        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }
        
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToBase64(avatarUrl);
        }
        
        return null;
    } catch (error) {
        ronaLog('ERROR', 'Ошибка получения аватара персонажа:', error);
        return null;
    }
}

/**
 * Извлечь описание внешности из карточки персонажа
 */
function extractCharacterAppearance() {
    try {
        const context = SillyTavern.getContext();
        
        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }
        
        const character = context.characters?.[context.characterId];
        if (!character?.description) {
            return null;
        }
        
        const description = character.description;
        const charName = character.name || 'Character';
        
        // Паттерны для поиска внешности
        const appearancePatterns = [
            // Волосы
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            // Глаза
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            // Кожа
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            // Рост/Телосложение
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            // Возраст
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            // Черты лица
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            // Особенности (уши, хвост, рога, крылья)
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];
        
        const foundTraits = [];
        const seenTexts = new Set();
        
        for (const pattern of appearancePatterns) {
            const matches = description.matchAll(pattern);
            for (const match of matches) {
                const trait = (match[1] || match[0]).trim();
                const lowerTrait = trait.toLowerCase();
                if (trait.length > 2 && !seenTexts.has(lowerTrait)) {
                    seenTexts.add(lowerTrait);
                    foundTraits.push(trait);
                }
            }
        }
        
        // Блоки внешности
        const appearanceBlockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];
        
        for (const pattern of appearanceBlockPatterns) {
            const matches = description.matchAll(pattern);
            for (const match of matches) {
                const block = match[1].trim();
                if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                    seenTexts.add(block.toLowerCase());
                    foundTraits.push(block);
                }
            }
        }
        
        if (foundTraits.length === 0) {
            return null;
        }
        
        const appearanceText = `${charName}: ${foundTraits.join(', ')}`;
        ronaLog('INFO', `Извлечена внешность персонажа: ${appearanceText.substring(0, 150)}`);
        
        return appearanceText;
    } catch (error) {
        ronaLog('ERROR', 'Ошибка извлечения внешности персонажа:', error);
        return null;
    }
}

/**
 * Получить описание персоны пользователя
 */
function getUserPersonaDescription() {
    try {
        const context = SillyTavern.getContext();
        
        if (typeof window.power_user !== 'undefined' && window.power_user.persona_description) {
            const userName = context.name1 || 'User';
            const personaText = `${userName}: ${window.power_user.persona_description}`;
            ronaLog('INFO', `Получена персона юзера: ${personaText.substring(0, 100)}`);
            return personaText;
        }
        
        return null;
    } catch (error) {
        ronaLog('ERROR', 'Ошибка получения персоны юзера:', error);
        return null;
    }
}

/**
 * Определить одежду из недавних сообщений
 */
function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0) {
            return null;
        }
        
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        const userName = context.name1 || 'User';
        
        const clothingPatterns = [
            // Английский
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:shirt|blouse|top|jacket|coat|sweater|hoodie|t-shirt|tank\s*top)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:pants|jeans|shorts|skirt|trousers|leggings)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:dress|gown|robe|uniform|suit|armor|armour)[:\s]*([^.;!?\n]{3,100})/gi,
            // Русский
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
        ];
        
        const foundClothing = [];
        const seenTexts = new Set();
        const startIndex = Math.max(0, chat.length - depth);
        
        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            
            const text = message.mes;
            const speaker = message.is_user ? userName : charName;
            
            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0;
                const matches = text.matchAll(pattern);
                for (const match of matches) {
                    const clothing = (match[1] || match[0]).trim();
                    const lowerClothing = clothing.toLowerCase();
                    
                    if (clothing.length > 3 && !seenTexts.has(lowerClothing)) {
                        seenTexts.add(lowerClothing);
                        foundClothing.push({
                            text: clothing,
                            speaker: speaker,
                            messageIndex: i
                        });
                    }
                }
            }
        }
        
        if (foundClothing.length === 0) {
            return null;
        }
        
        const charClothing = foundClothing.filter(c => c.speaker === charName).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName).map(c => c.text);
        
        let clothingText = '';
        if (charClothing.length > 0) {
            clothingText += `${charName} wearing: ${charClothing.slice(0, 3).join(', ')}. `;
        }
        if (userClothing.length > 0) {
            clothingText += `${userName} wearing: ${userClothing.slice(0, 3).join(', ')}.`;
        }
        
        ronaLog('INFO', `Определена одежда: ${clothingText.substring(0, 150)}`);
        return clothingText.trim();
    } catch (error) {
        ronaLog('ERROR', 'Ошибка определения одежды:', error);
        return null;
    }
}

/**
 * Анализировать сцену из последних сообщений
 */
function analyzeCurrentScene(depth = 3) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0) {
            return 'conversation scene';
        }
        
        const startIndex = Math.max(0, chat.length - depth);
        const recentMessages = chat.slice(startIndex).map(m => m.mes).join(' ');
        
        // Ключевые слова для определения сцены
        const sceneKeywords = {
            // Локации
            'bedroom|спальн|кровать|bed': 'bedroom scene',
            'kitchen|кухн|готов': 'kitchen scene',
            'bathroom|ванн|душ|shower': 'bathroom scene',
            'street|улиц|outside|снаружи': 'outdoor street scene',
            'forest|лес|trees|деревь': 'forest scene',
            'beach|пляж|ocean|океан|море|sea': 'beach scene',
            'office|офис|работ|work': 'office scene',
            'school|школ|класс|class': 'school scene',
            'cafe|кафе|restaurant|ресторан': 'cafe/restaurant scene',
            'park|парк': 'park scene',
            'car|машин|автомобиль': 'car interior scene',
            
            // Действия
            'kiss|поцелу|целу': 'romantic kissing scene',
            'hug|обним': 'hugging scene',
            'fight|драк|бой|battle': 'action fighting scene',
            'sleep|сп[яи]т|спать': 'sleeping scene',
            'eat|ед[яи]т|есть|кушать': 'eating scene',
            'walk|гуля|прогулк': 'walking scene',
            'dance|танц': 'dancing scene',
            'read|чита': 'reading scene',
            'cook|готов': 'cooking scene',
            
            // Эмоции/Атмосфера
            'cry|плач|слез': 'emotional crying scene',
            'laugh|смех|смеёт': 'happy laughing scene',
            'angry|злост|злит': 'angry confrontation scene',
            'sad|грустн|печальн': 'sad melancholic scene',
            'happy|счастлив|радост': 'happy cheerful scene',
            'scared|страшн|испуган': 'scary tense scene',
        };
        
        const lowerText = recentMessages.toLowerCase();
        
        for (const [pattern, sceneName] of Object.entries(sceneKeywords)) {
            if (new RegExp(pattern, 'i').test(lowerText)) {
                ronaLog('INFO', `Определена сцена: ${sceneName}`);
                return sceneName;
            }
        }
        
        return 'conversation scene';
    } catch (error) {
        ronaLog('ERROR', 'Ошибка анализа сцены:', error);
        return 'conversation scene';
    }
}

/**
 * Построить полный промпт для генерации
 * Порядок:
 * 1. Positive промпт + [STYLE]
 * 2. [Character Reference: внешность]
 * 3. [User Reference: внешность]
 * 4. [Current Clothing: одежда]
 * 5. Основной промпт сцены
 * 6. [AVOID: negative]
 */
function buildFullPrompt(sceneDescription = '') {
    const settings = getSettings();
    const promptParts = [];
    
    // 1. Positive промпт и фиксированный стиль
    if (settings.positivePrompt) {
        promptParts.push(settings.positivePrompt);
    }
    
    if (settings.fixedStyleEnabled && settings.fixedStyle) {
        promptParts.push(`[STYLE: ${settings.fixedStyle}]`);
        ronaLog('INFO', `Применён фиксированный стиль: ${settings.fixedStyle}`);
    }
    
    // 2. Внешность персонажа
    if (settings.extractCharAppearance) {
        const charAppearance = extractCharacterAppearance();
        if (charAppearance) {
            promptParts.push(`[Character Reference: ${charAppearance}]`);
        }
    }
    
    // 3. Внешность юзера
    if (settings.extractUserAppearance) {
        const userAppearance = getUserPersonaDescription();
        if (userAppearance) {
            promptParts.push(`[User Reference: ${userAppearance}]`);
        }
    }
    
    // 4. Одежда
    if (settings.detectClothing) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth);
        if (clothing) {
            promptParts.push(`[Current Clothing: ${clothing}]`);
        }
    }
    
    // 5. Основной промпт сцены
    let mainScene = sceneDescription;
    if (!mainScene && settings.analyzeScene) {
        mainScene = analyzeCurrentScene();
    }
    if (mainScene) {
        promptParts.push(mainScene);
    }
    
    // 6. Negative промпт
    if (settings.negativePrompt) {
        promptParts.push(`[AVOID: ${settings.negativePrompt}]`);
    }
    
    const fullPrompt = promptParts.join('\n\n');
    ronaLog('INFO', `Построен промпт (${fullPrompt.length} символов)`);
    
    return fullPrompt;
}

/**
 * Генерация через Nano-Banana API
 */
async function generateViaBanana(prompt) {
    const settings = getSettings();
    
    if (!settings.bananaUrl) {
        throw new Error('URL для Nano-Banana не настроен');
    }
    
    // Формат URL от пользователя: https://aituned.xyz/v1/nano-banana/YOUR_KEY
    // Нужно добавить: /prompt/[DESC]
    const baseUrl = settings.bananaUrl.replace(/\/$/, '');
    
    // Подготавливаем промпт: заменяем пробелы на underscores
    let cleanPrompt = prompt
        .replace(/\[STYLE:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[Character Reference:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[User Reference:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[Current Clothing:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[AVOID:\s*([^\]]+)\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Кодируем промпт для URL (пробелы → underscores)
    const encodedPrompt = cleanPrompt
        .replace(/\s+/g, '_')
        .replace(/[^\w\-_.,!?]/g, '_');
    
    const url = `${baseUrl}/prompt/${encodedPrompt}`;
    
    ronaLog('INFO', `Запрос к Nano-Banana: ${url.substring(0, 150)}...`);
    ronaLog('INFO', `Промпт (${cleanPrompt.length} символов): ${cleanPrompt.substring(0, 100)}...`);
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Accept': 'image/*, application/json'
        }
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Nano-Banana API Error (${response.status}): ${text.substring(0, 200)}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    // Если вернулось изображение напрямую
    if (contentType.includes('image/')) {
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    
    // Если вернулся JSON (Gemini формат)
    if (contentType.includes('application/json')) {
        const result = await response.json();
        
        // Gemini формат
        const candidates = result.candidates || [];
        if (candidates.length > 0) {
            const responseParts = candidates[0].content?.parts || [];
            for (const part of responseParts) {
                if (part.inlineData) {
                    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                }
                if (part.inline_data) {
                    return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
                }
            }
        }
        
        // Другие форматы
        if (result.output) {
            return `data:image/png;base64,${result.output}`;
        }
        if (result.image) {
            return `data:image/png;base64,${result.image}`;
        }
        if (result.url) {
            const imgResponse = await fetch(result.url);
            const blob = await imgResponse.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }
        
        ronaLog('WARN', 'Неизвестный формат ответа Nano-Banana:', Object.keys(result));
        throw new Error('Изображение не найдено в ответе Nano-Banana');
    }
    
    // Пробуем как blob на всякий случай
    const blob = await response.blob();
    if (blob.size > 1000) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    
    throw new Error('Неизвестный формат ответа от Nano-Banana');
}

/**
 * Генерация через NovelAI API (aituned.xyz формат)
 * 
 * Формат URL: https://aituned.xyz/v1/novelai/KEY/prompt/[DESC]
 * [DESC] - промпт с underscores вместо пробелов
 */
async function generateViaNovelAI(prompt) {
    const settings = getSettings();
    
    if (!settings.novelaiUrl) {
        throw new Error('URL для NovelAI не настроен');
    }
    
    // Формат URL от пользователя: https://aituned.xyz/v1/novelai/YOUR_KEY
    // Нужно добавить: /prompt/[DESC]
    const baseUrl = settings.novelaiUrl.replace(/\/$/, '');
    
    // Подготавливаем промпт: заменяем пробелы на underscores
    // Убираем [AVOID: ...] и другие теги, оставляем чистый промпт
    let cleanPrompt = prompt
        .replace(/\[STYLE:\s*([^\]]+)\]/gi, '$1,') // Стиль в начало
        .replace(/\[Character Reference:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[User Reference:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[Current Clothing:\s*([^\]]+)\]/gi, '$1,')
        .replace(/\[AVOID:\s*([^\]]+)\]/gi, '') // Negative убираем (для NovelAI отдельно)
        .replace(/\s+/g, ' ')
        .trim();
    
    // Кодируем промпт для URL (пробелы → underscores)
    const encodedPrompt = cleanPrompt
        .replace(/\s+/g, '_')
        .replace(/[^\w\-_.,!?]/g, '_'); // Безопасные символы
    
    const url = `${baseUrl}/prompt/${encodedPrompt}`;
    
    ronaLog('INFO', `Запрос к NovelAI: ${url.substring(0, 150)}...`);
    ronaLog('INFO', `Промпт (${cleanPrompt.length} символов): ${cleanPrompt.substring(0, 100)}...`);
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Accept': 'image/*, application/json'
        }
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`NovelAI API Error (${response.status}): ${text.substring(0, 200)}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    // Если вернулось изображение напрямую
    if (contentType.includes('image/')) {
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    
    // Если вернулся JSON
    if (contentType.includes('application/json')) {
        const result = await response.json();
        
        // Проверяем разные форматы ответа
        if (result.output) {
            return `data:image/png;base64,${result.output}`;
        }
        if (result.data?.[0]?.b64_json) {
            return `data:image/png;base64,${result.data[0].b64_json}`;
        }
        if (result.images?.[0]) {
            return `data:image/png;base64,${result.images[0]}`;
        }
        if (result.image) {
            return `data:image/png;base64,${result.image}`;
        }
        if (result.url) {
            // Если вернулся URL изображения - скачиваем
            const imgResponse = await fetch(result.url);
            const blob = await imgResponse.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }
        
        ronaLog('WARN', 'Неизвестный формат ответа NovelAI:', Object.keys(result));
        throw new Error('Изображение не найдено в ответе NovelAI');
    }
    
    // Пробуем как blob на всякий случай
    const blob = await response.blob();
    if (blob.size > 1000) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    
    throw new Error('Неизвестный формат ответа от NovelAI');
}

/**
 * Основная функция генерации
 */
async function generateImage(onStatusUpdate) {
    const settings = getSettings();
    
    if (!settings.useBanana && !settings.useNovelAI) {
        throw new Error('Не выбран ни один провайдер генерации');
    }
    
    const prompt = buildFullPrompt();
    const results = [];
    const errors = [];
    
    // Генерация через выбранные провайдеры
    if (settings.useBanana && settings.bananaUrl) {
        try {
            onStatusUpdate?.('Генерация через Nano-Banana...');
            const bananaResult = await generateViaBanana(prompt);
            results.push({ provider: 'banana', dataUrl: bananaResult });
            ronaLog('INFO', 'Nano-Banana: успех');
        } catch (error) {
            ronaLog('ERROR', 'Nano-Banana ошибка:', error.message);
            errors.push({ provider: 'banana', error: error.message });
        }
    }
    
    if (settings.useNovelAI && settings.novelaiUrl) {
        try {
            onStatusUpdate?.('Генерация через NovelAI...');
            const novelaiResult = await generateViaNovelAI(prompt);
            results.push({ provider: 'novelai', dataUrl: novelaiResult });
            ronaLog('INFO', 'NovelAI: успех');
        } catch (error) {
            ronaLog('ERROR', 'NovelAI ошибка:', error.message);
            errors.push({ provider: 'novelai', error: error.message });
        }
    }
    
    if (results.length === 0) {
        const errorMsg = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
        throw new Error(`Все провайдеры вернули ошибку: ${errorMsg}`);
    }
    
    return results;
}

/**
 * Создать placeholder загрузки
 */
function createLoadingPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'rona-loading-placeholder';
    placeholder.innerHTML = `
        <div class="rona-spinner"></div>
        <div class="rona-status">Генерация изображения...</div>
    `;
    return placeholder;
}

/**
 * Создать контейнер для изображений
 */
function createImageContainer(imagePaths) {
    const container = document.createElement('div');
    container.className = 'rona-image-container';
    
    for (const path of imagePaths) {
        const img = document.createElement('img');
        img.className = 'rona-generated-image';
        img.src = path;
        img.alt = 'Generated by Rona';
        container.appendChild(img);
    }
    
    return container;
}

/**
 * Обработать сообщение персонажа и добавить изображение
 */
async function processMessage(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled || !settings.autoGenerate) return;
    
    // Защита от дублирования
    if (processingMessages.has(messageId)) {
        ronaLog('WARN', `Сообщение ${messageId} уже обрабатывается`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    // Проверяем, что изображение ещё не сгенерировано для этого сообщения
    if (message.rona_image_generated) {
        ronaLog('INFO', `Сообщение ${messageId} уже имеет изображение`);
        return;
    }
    
    processingMessages.add(messageId);
    ronaLog('INFO', `Начало обработки сообщения ${messageId}`);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    // Добавляем placeholder
    const loadingPlaceholder = createLoadingPlaceholder();
    mesTextEl.appendChild(loadingPlaceholder);
    
    const statusEl = loadingPlaceholder.querySelector('.rona-status');
    
    try {
        const results = await generateImage((status) => {
            statusEl.textContent = status;
        });
        
        statusEl.textContent = 'Сохранение...';
        
        const imagePaths = [];
        for (const result of results) {
            const path = await saveImageToFile(result.dataUrl);
            imagePaths.push(path);
        }
        
        // Заменяем placeholder на изображения
        const imageContainer = createImageContainer(imagePaths);
        loadingPlaceholder.replaceWith(imageContainer);
        
        // Помечаем сообщение как обработанное
        message.rona_image_generated = true;
        message.rona_image_paths = imagePaths;
        
        toastr.success(`Сгенерировано изображений: ${imagePaths.length}`, 'Rona');
        
        // Сохраняем чат
        await context.saveChat();
        
    } catch (error) {
        ronaLog('ERROR', 'Ошибка генерации:', error.message);
        loadingPlaceholder.innerHTML = `
            <div class="rona-error">
                <span class="rona-error-icon">⚠️</span>
                <span class="rona-error-text">${error.message}</span>
            </div>
        `;
        toastr.error(`Ошибка: ${error.message}`, 'Rona');
    } finally {
        processingMessages.delete(messageId);
    }
}

/**
 * Перегенерировать изображение для сообщения
 */
async function regenerateImage(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Сообщение не найдено', 'Rona');
        return;
    }
    
    // Сбрасываем флаг
    message.rona_image_generated = false;
    delete message.rona_image_paths;
    
    // Удаляем существующие изображения из DOM
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement) {
        const existingImages = messageElement.querySelectorAll('.rona-image-container, .rona-loading-placeholder, .rona-error');
        existingImages.forEach(el => el.remove());
    }
    
    // Запускаем новую генерацию
    await processMessage(messageId);
}

/**
 * Добавить кнопку перегенерации в меню сообщения
 */
function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.rona-regenerate-btn')) return;
    
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button rona-regenerate-btn fa-solid fa-image interactable';
    btn.title = 'Перегенерировать изображение (Rona)';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateImage(messageId);
    });
    
    extraMesButtons.appendChild(btn);
}

/**
 * Добавить кнопки ко всем существующим сообщениям
 */
function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageElements = document.querySelectorAll('#chat .mes');
    
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
        }
    }
}

/**
 * Обработчик события нового сообщения
 */
async function onMessageRendered(messageId) {
    ronaLog('INFO', `Событие: сообщение ${messageId} отрендерено`);
    
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    // Добавляем кнопку перегенерации
    if (message && !message.is_user) {
        addRegenerateButton(messageElement, messageId);
    }
    
    // Автогенерация
    if (settings.autoGenerate && message && !message.is_user) {
        await processMessage(messageId);
    }
}

/**
 * Создать UI настроек
 */
function createSettingsUI() {
    const settings = getSettings();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[Rona] Контейнер настроек не найден');
        return;
    }
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎨 Rona - Auto Image Generation</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="rona-settings">
                    <!-- Основные переключатели -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить Rona</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_auto_generate" ${settings.autoGenerate ? 'checked' : ''}>
                        <span>Автоматическая генерация</span>
                    </label>
                    
                    <hr>
                    
                    <!-- ВЫБОР ПРОВАЙДЕРА -->
                    <h4>🔌 Провайдеры генерации</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_use_banana" ${settings.useBanana ? 'checked' : ''}>
                        <span>Использовать Nano-Banana</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_use_novelai" ${settings.useNovelAI ? 'checked' : ''}>
                        <span>Использовать NovelAI</span>
                    </label>
                    
                    <p class="hint">Выберите один или оба провайдера. При выборе обоих - будут сгенерированы 2 изображения.</p>
                    
                    <hr>
                    
                    <!-- NANO-BANANA НАСТРОЙКИ -->
                    <div id="rona_banana_section" class="${!settings.useBanana ? 'hidden' : ''}">
                        <h4>🍌 Nano-Banana</h4>
                        
                        <div class="flex-col">
                            <label for="rona_banana_url">URL (формат: https://aituned.xyz/v1/nano-banana/YOUR_KEY)</label>
                            <input type="text" id="rona_banana_url" class="text_pole" 
                                   value="${settings.bananaUrl}" 
                                   placeholder="https://aituned.xyz/v1/nano-banana/sk_aituned_xxx">
                        </div>
                        <p class="hint">Промпт отправляется через URL с подчёркиваниями вместо пробелов</p>
                        
                        <hr>
                    </div>
                    
                    <!-- NOVELAI НАСТРОЙКИ -->
                    <div id="rona_novelai_section" class="${!settings.useNovelAI ? 'hidden' : ''}">
                        <h4>✨ NovelAI</h4>
                        
                        <div class="flex-col">
                            <label for="rona_novelai_url">URL (формат: https://aituned.xyz/v1/novelai/YOUR_KEY)</label>
                            <input type="text" id="rona_novelai_url" class="text_pole" 
                                   value="${settings.novelaiUrl}" 
                                   placeholder="https://aituned.xyz/v1/novelai/sk_aituned_xxx">
                        </div>
                        <p class="hint">Промпт отправляется через URL с подчёркиваниями вместо пробелов</p>
                        
                        <hr>
                    </div>
                    
                    <!-- ПРОМПТЫ -->
                    <h4>📝 Промпты</h4>
                    
                    <div class="flex-col">
                        <label for="rona_positive_prompt">Positive промпт</label>
                        <textarea id="rona_positive_prompt" class="text_pole" rows="2" 
                                  placeholder="masterpiece, best quality, detailed...">${settings.positivePrompt || ''}</textarea>
                    </div>
                    
                    <div class="flex-col">
                        <label for="rona_negative_prompt">Negative промпт</label>
                        <textarea id="rona_negative_prompt" class="text_pole" rows="2" 
                                  placeholder="low quality, blurry, deformed...">${settings.negativePrompt || ''}</textarea>
                    </div>
                    
                    <hr>
                    
                    <!-- ФИКСИРОВАННЫЙ СТИЛЬ -->
                    <h4>🎨 Фиксированный стиль</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
                        <span>Включить фиксированный стиль</span>
                    </label>
                    
                    <div class="flex-col">
                        <label for="rona_fixed_style">Стиль</label>
                        <input type="text" id="rona_fixed_style" class="text_pole" 
                               value="${settings.fixedStyle || ''}" 
                               placeholder="Anime Lycoris Recoil style, detailed lighting...">
                    </div>
                    <p class="hint">Примеры: "Avatar movie style", "Cyberpunk 2077 style", "Studio Ghibli style"</p>
                    
                    <hr>
                    
                    <!-- ИЗВЛЕЧЕНИЕ КОНТЕКСТА -->
                    <h4>👤 Извлечение контекста</h4>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_extract_char" ${settings.extractCharAppearance ? 'checked' : ''}>
                        <span>Извлекать внешность из карточки {{char}}</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_extract_user" ${settings.extractUserAppearance ? 'checked' : ''}>
                        <span>Извлекать внешность из персоны {{user}}</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
                        <span>Определять одежду из чата</span>
                    </label>
                    
                    <div class="flex-row">
                        <label for="rona_clothing_depth">Глубина поиска одежды (сообщений)</label>
                        <input type="number" id="rona_clothing_depth" class="text_pole flex1" 
                               value="${settings.clothingSearchDepth}" min="1" max="20">
                    </div>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="rona_analyze_scene" ${settings.analyzeScene ? 'checked' : ''}>
                        <span>Анализировать текущую сцену</span>
                    </label>
                    
                    <hr>
                    
                    <!-- ОТЛАДКА -->
                    <h4>🔧 Отладка</h4>
                    
                    <div class="flex-row">
                        <div id="rona_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    bindSettingsEvents();
}

/**
 * Привязать обработчики событий настроек
 */
function bindSettingsEvents() {
    const settings = getSettings();
    
    // Основные переключатели
    document.getElementById('rona_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_auto_generate')?.addEventListener('change', (e) => {
        settings.autoGenerate = e.target.checked;
        saveSettings();
    });
    
    // Провайдеры
    document.getElementById('rona_use_banana')?.addEventListener('change', (e) => {
        settings.useBanana = e.target.checked;
        saveSettings();
        document.getElementById('rona_banana_section')?.classList.toggle('hidden', !e.target.checked);
    });
    
    document.getElementById('rona_use_novelai')?.addEventListener('change', (e) => {
        settings.useNovelAI = e.target.checked;
        saveSettings();
        document.getElementById('rona_novelai_section')?.classList.toggle('hidden', !e.target.checked);
    });
    
    // Nano-Banana настройки
    document.getElementById('rona_banana_url')?.addEventListener('input', (e) => {
        settings.bananaUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_banana_aspect')?.addEventListener('change', (e) => {
        settings.bananaAspectRatio = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_banana_size')?.addEventListener('change', (e) => {
        settings.bananaImageSize = e.target.value;
        saveSettings();
    });
    
    // NovelAI настройки
    document.getElementById('rona_novelai_url')?.addEventListener('input', (e) => {
        settings.novelaiUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_novelai_model')?.addEventListener('change', (e) => {
        settings.novelaiModel = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_novelai_width')?.addEventListener('input', (e) => {
        settings.novelaiWidth = parseInt(e.target.value) || 832;
        saveSettings();
    });
    
    document.getElementById('rona_novelai_height')?.addEventListener('input', (e) => {
        settings.novelaiHeight = parseInt(e.target.value) || 1216;
        saveSettings();
    });
    
    document.getElementById('rona_novelai_steps')?.addEventListener('input', (e) => {
        settings.novelaiSteps = parseInt(e.target.value) || 28;
        saveSettings();
    });
    
    document.getElementById('rona_novelai_scale')?.addEventListener('input', (e) => {
        settings.novelaiScale = parseFloat(e.target.value) || 5;
        saveSettings();
    });
    
    // Промпты
    document.getElementById('rona_positive_prompt')?.addEventListener('input', (e) => {
        settings.positivePrompt = e.target.value;
        saveSettings();
    });
    
    document.getElementById('rona_negative_prompt')?.addEventListener('input', (e) => {
        settings.negativePrompt = e.target.value;
        saveSettings();
    });
    
    // Фиксированный стиль
    document.getElementById('rona_fixed_style_enabled')?.addEventListener('change', (e) => {
        settings.fixedStyleEnabled = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_fixed_style')?.addEventListener('input', (e) => {
        settings.fixedStyle = e.target.value;
        saveSettings();
    });
    
    // Извлечение контекста
    document.getElementById('rona_extract_char')?.addEventListener('change', (e) => {
        settings.extractCharAppearance = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_extract_user')?.addEventListener('change', (e) => {
        settings.extractUserAppearance = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_detect_clothing')?.addEventListener('change', (e) => {
        settings.detectClothing = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('rona_clothing_depth')?.addEventListener('input', (e) => {
        settings.clothingSearchDepth = parseInt(e.target.value) || 5;
        saveSettings();
    });
    
    document.getElementById('rona_analyze_scene')?.addEventListener('change', (e) => {
        settings.analyzeScene = e.target.checked;
        saveSettings();
    });
    
    // Экспорт логов
    document.getElementById('rona_export_logs')?.addEventListener('click', exportLogs);
}

/**
 * Инициализация расширения
 */
(function init() {
    const context = SillyTavern.getContext();
    
    ronaLog('INFO', 'Инициализация Rona...');
    
    // Загрузка настроек
    getSettings();
    
    // Создание UI при готовности приложения
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        ronaLog('INFO', 'Rona загружена');
        console.log('[Rona] Расширение инициализировано');
    });
    
    // При смене чата - добавить кнопки
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        ronaLog('INFO', 'CHAT_CHANGED - добавление кнопок');
        setTimeout(() => {
            addButtonsToExistingMessages();
        }, 100);
    });
    
    // Обработка новых сообщений
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    
    ronaLog('INFO', 'Rona инициализирована');
})();
