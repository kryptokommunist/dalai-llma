const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chatSources = require('./lib/chat_sources');

// Configuration
const DATA_DIR = process.env.DATA_DIR || './data';
const LLM_DATA_DIR = path.join(DATA_DIR, 'LLM Data');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ============================================================
// Word lists for sentiment analysis (English + German)
// ============================================================

const hopefulWords = [
    'better', 'good', 'great', 'hope', 'excited', 'looking forward', 'healing', 'progress',
    'improving', 'alive', 'free', 'liberated', 'release', 'happy', 'joy', 'love', 'beautiful',
    'amazing', 'wonderful', 'grateful', 'thankful', 'proud', 'peaceful', 'calm', 'confident',
    'strong', 'growing', 'learning', 'understanding', 'clarity', 'trust', 'connected', 'supported',
    'safe', 'magic', 'magical', 'fantastic', 'awesome', 'nice', 'fun', 'enjoying', 'enjoyed',
    'relaxed', 'energized', 'motivated', 'inspired', 'creative', 'open', 'curious', 'playful',
    'besser', 'gut', 'toll', 'super', 'hoffnung', 'freude', 'glücklich', 'froh', 'schön',
    'wunderbar', 'fantastisch', 'großartig', 'dankbar', 'stolz', 'friedlich', 'ruhig', 'stark',
    'frei', 'befreit', 'lebendig', 'sicher', 'vertrauen', 'verbunden', 'geborgen', 'entspannt',
    'motiviert', 'inspiriert', 'neugierig', 'offen', 'heilung', 'fortschritt', 'liebe', 'liebevoll',
    'herzlich', 'wunderschön', 'genial', 'klasse', 'prima', 'geil', 'krass'
];

const despairWords = [
    'alone', 'scared', 'afraid', 'pain', 'hurt', 'crying', 'sobbing', 'anxious', 'worried',
    'stuck', 'trapped', 'angry', 'fucking', 'fuck', 'sad', 'depressed', 'hopeless', 'helpless',
    'lost', 'confused', 'overwhelmed', 'exhausted', 'tired', 'frustrated', 'disappointed',
    'lonely', 'empty', 'broken', 'failed', 'hate', 'terrible', 'awful', 'horrible', 'miserable',
    'suffering', 'triggered', 'dissociated', 'dissociating', 'numb', 'disconnected', 'isolated',
    'rejected', 'abandoned', 'worthless', 'shame', 'guilt', 'panic', 'terror', 'dread', 'despair',
    'grief', 'trauma',
    'allein', 'einsam', 'angst', 'ängstlich', 'schmerz', 'schmerzen', 'weinen', 'traurig',
    'deprimiert', 'hoffnungslos', 'hilflos', 'verloren', 'verwirrt', 'überfordert', 'erschöpft',
    'müde', 'frustriert', 'enttäuscht', 'wütend', 'sauer', 'hass', 'hassen', 'schrecklich',
    'furchtbar', 'schlimm', 'elend', 'leid', 'leiden', 'qual', 'panik', 'verzweifelt',
    'verzweiflung', 'trauer', 'schuld', 'scham', 'wertlos', 'kaputt', 'gebrochen', 'scheisse',
    'scheiße', 'mist', 'kacke', 'getriggert', 'dissoziiert'
];

const agencyPhrases = [
    'i can', 'i will', 'i want', 'i choose', 'i decided', 'i need to', 'i am going to', 'i know',
    "i'm going to", "i'll", 'my choice', 'my decision', 'i realize', 'i understand', 'i accept',
    'i appreciate', "i'm learning", "i'm growing", 'i noticed', 'i recognize',
    'ich kann', 'ich werde', 'ich will', 'ich möchte', 'ich entscheide', 'ich habe entschieden',
    'ich weiß', 'ich verstehe', 'ich erkenne', 'ich akzeptiere', 'ich lerne', 'meine entscheidung',
    'meine wahl', 'ich merke', 'ich bemerke', 'ich realisiere'
];

const victimPhrases = [
    "i can't", 'i have to', 'i should', 'why me', "it's not fair", 'stuck', 'trapped',
    'helpless', 'hopeless', 'i must', "i'm forced", 'no choice', 'nothing i can do',
    "i don't know what to do", 'i feel like i have to',
    'ich kann nicht', 'ich muss', 'ich sollte', 'warum ich', 'nicht fair', 'gefangen',
    'hilflos', 'hoffnungslos', 'keine wahl', 'ich weiß nicht', 'ich schaffe es nicht',
    'es geht nicht', 'ich bin gezwungen'
];

const victimPatterns = ['why me', "it's not fair", "i can't", 'helpless', 'stuck', 'trapped', 'poor me', 'nothing ever works', 'always happens to me'];
const persecutorPatterns = ['they always', 'they never', 'fault', 'blame', 'should have', "it's their", 'stupid', 'idiot', 'they ruined'];
const rescuerPatterns = ['i need to help', 'fix this', 'save', 'let me handle', "i'll take care", "don't worry", "i'll do it for"];
const empoweredPatterns = ['i choose', 'i will', 'i can', 'i decided', 'my responsibility', 'i want', 'i realize', 'i accept', 'i appreciate'];

const peoplePatterns = {
    'liliia': /\bliliia\b/gi,
    'sarah': /\bsarah\b/gi,
    'philip': /\bphilip\b/gi,
    'dennis': /\bdennis\b/gi,
    'mother': /\b(mother|mom|mum|mama)\b/gi,
    'father': /\b(father|dad|papa)\b/gi,
    'brother': /\bbrother\b/gi,
    'sister': /\bsister\b/gi,
    'therapist': /\b(therapist|therapy)\b/gi,
    'dominik': /\bdominik\b/gi,
    'geralf': /\bgeralf\b/gi,
    'julie': /\bjulie\b/gi,
    'maija': /\bmaija\b/gi,
    'julius': /\bjulius\b/gi,
    'konrad': /\bkonrad\b/gi,
    'eglantina': /\beglantina\b/gi,
    'jawad': /\bjawad\b/gi
};

const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
    'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then', 'if', 'about',
    'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again',
    'further', 'once', 'any', 'because', 'being', 'even', 'get', 'got', 'having', 'like', 'make',
    'made', 'many', 'much', 'one', 'out', 'over', 'really', 'right', 'say', 'said', 'see', 'still',
    'thing', 'things', 'think', 'thought', 'time', 'up', 'us', 'want', 'way', 'well', 'went',
    'yeah', 'yes', 'yet', 'your', 'know', 'going', 'something', 'feel', 'lot', 'back', 'day',
    'im', 'dont', 'thats', 'ive', 'youre', 'didnt', 'couldnt', 'wouldnt', 'cant', 'wont', 'lets',
    'hes', 'shes', 'theyre', 'were', 'wasnt', 'werent', 'arent', 'isnt', 'hasnt', 'havent', 'hadnt',
    'doesnt', 'bit', 'maybe', 'actually', 'kind', 'around', 'part', 'shared', 'basically', 'somehow',
    'mean', 'okay', 'told', 'asked', 'seems', 'seemed', 'started', 'talking', 'saying', 'come',
    'came', 'goes', 'done', 'put', 'take', 'took', 'give', 'gave', 'looked', 'look', 'looking',
    'makes', 'making', 'getting', 'use', 'used', 'using', 'trying', 'tried', 'set', 'keep', 'kept',
    'let', 'https', 'www', 'com',
    'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'und', 'oder', 'aber', 'der', 'die', 'das',
    'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines', 'ist', 'sind', 'war',
    'waren', 'sein', 'haben', 'hat', 'hatte', 'hatten', 'wird', 'werden', 'wurde', 'wurden',
    'kann', 'konnte', 'muss', 'musste', 'soll', 'sollte', 'will', 'wollte', 'darf', 'durfte',
    'mag', 'mochte', 'nicht', 'kein', 'keine', 'keiner', 'keinem', 'keinen', 'mehr', 'noch',
    'schon', 'auch', 'nur', 'sehr', 'viel', 'wenn', 'als', 'dass', 'weil', 'damit', 'obwohl',
    'bevor', 'nachdem', 'warum', 'wie', 'was', 'wer', 'wo', 'wann', 'welche', 'welcher', 'welches',
    'dieser', 'diese', 'dieses', 'jener', 'jene', 'jenes', 'hier', 'dort', 'dann', 'jetzt',
    'immer', 'nie', 'oft', 'manchmal', 'heute', 'gestern', 'morgen', 'auf', 'aus', 'bei', 'bis',
    'durch', 'für', 'gegen', 'hinter', 'mit', 'nach', 'neben', 'ohne', 'seit', 'über', 'unter',
    'vor', 'zwischen', 'von', 'zum', 'zur', 'ins', 'ans', 'aufs', 'mich', 'dich', 'sich', 'uns',
    'euch', 'mir', 'dir', 'ihm', 'ihnen', 'mein', 'dein', 'unser', 'euer', 'nen', 'nem', 'sch',
    'hab', 'mal', 'grad', 'halt', 'echt', 'ganz', 'ja', 'nein', 'doch', 'also', 'na', 'eben',
    'wohl', 'etwa', 'zwar', 'bzw', 'usw', 'etc', 'evtl', 'ggf', 'bspw', 'zb',
    'habe', 'bin', 'bist', 'gehe', 'geht', 'gab', 'gibt', 'geben', 'gegeben', 'kommen', 'kommt',
    'kam', 'gekommen', 'gehen', 'ging', 'gegangen', 'sagen', 'sagt', 'sagte', 'gesagt', 'machen',
    'macht', 'machte', 'gemacht', 'lassen', 'ließ', 'wissen', 'weiß', 'wusste', 'sehen', 'sieht',
    'sah', 'gesehen', 'finden', 'findet', 'fand', 'gefunden', 'stehen', 'steht', 'stand',
    'gestanden', 'liegen', 'liegt', 'lag', 'gelegen', 'bleiben', 'bleibt', 'blieb', 'geblieben',
    'denken', 'denkt', 'dachte', 'gedacht', 'glauben', 'glaubt', 'glaubte', 'geglaubt', 'halten',
    'hielt', 'gehalten', 'nennen', 'nennt', 'nannte', 'genannt', 'zeigen', 'zeigt', 'zeigte',
    'gezeigt', 'sprechen', 'spricht', 'sprach', 'gesprochen', 'bringen', 'bringt', 'brachte',
    'gebracht', 'leben', 'lebt', 'lebte', 'gelebt', 'fahren', 'fuhr', 'gefahren', 'meinen', 'meint',
    'meinte', 'gemeint', 'fragen', 'fragt', 'fragte', 'gefragt', 'kennen', 'kennt', 'kannte',
    'gekannt', 'gerne', 'herr', 'frau', 'freundlichen', 'abend',
    'don', 've', 'll', 're', 'didn', 'doesn', 'wouldn', 'couldn', 'shouldn', 'wasn', 'weren',
    'isn', 'aren', 'hasn', 'haven', 'hadn', 'won', 'ain', 'kinda', 'gonna', 'wanna', 'gotta',
    'lotta', 'sorta', 'outta', 'dunno', 'lemme', 'gimme', 'sent', 'marcus', 'iphone', 'lieben',
    'grüßen', 'viele'
]);

// ============================================================
// Helpers
// ============================================================

function parseDate(timestamp) {
    if (typeof timestamp === 'number') {
        return new Date(timestamp * 1000);
    }
    return new Date(timestamp);
}

function getWeekKey(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${d.getFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
}

function getMonthKey(date) {
    const d = new Date(date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

function countPatterns(text, patterns) {
    let count = 0;
    const lower = text.toLowerCase();
    for (const p of patterns) {
        const regex = new RegExp(p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const m = lower.match(regex);
        if (m) count += m.length;
    }
    return count;
}

function calculateSentiment(text) {
    const lower = text.toLowerCase();
    let hopeful = 0, despair = 0;
    for (const w of hopefulWords) {
        const m = lower.match(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
        if (m) hopeful += m.length;
    }
    for (const w of despairWords) {
        const m = lower.match(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
        if (m) despair += m.length;
    }
    const total = hopeful + despair;
    return total === 0 ? 0 : (hopeful - despair) / total;
}

function calculateAgency(text) {
    const agency = countPatterns(text, agencyPhrases);
    const victim = countPatterns(text, victimPhrases);
    const total = agency + victim;
    return total === 0 ? 50 : Math.round((agency / total) * 100);
}

function calculateDramaTriangle(text) {
    return {
        victim: countPatterns(text, victimPatterns),
        persecutor: countPatterns(text, persecutorPatterns),
        rescuer: countPatterns(text, rescuerPatterns),
        empowered: countPatterns(text, empoweredPatterns)
    };
}

function getWordFrequencies(text) {
    const words = text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w) && !/^\d+$/.test(w));
    const freq = {};
    for (const word of words) freq[word] = (freq[word] || 0) + 1;
    return freq;
}

function countPeople(text) {
    const counts = {};
    for (const [person, regex] of Object.entries(peoplePatterns)) {
        const matches = text.match(regex);
        if (matches) counts[person] = matches.length;
    }
    return counts;
}

// ============================================================
// Data Loaders
// ============================================================

function loadAnthropicConversations() {
    // Prefer the newer/larger export in LLM Data dir
    const paths = [
        path.join(LLM_DATA_DIR, 'Anthropic', 'conversations.json'),
        path.join(DATA_DIR, 'anthropic', 'conversations.json')
    ];

    let data = [];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            // Merge, dedup by uuid
            const existing = new Set(data.map(c => c.uuid));
            for (const c of raw) {
                if (!existing.has(c.uuid)) {
                    data.push(c);
                    existing.add(c.uuid);
                }
            }
            console.log(`  Loaded ${raw.length} Anthropic convos from ${path.relative('.', p)}`);
        }
    }

    const conversations = [];
    for (const conv of data) {
        const messages = (conv.chat_messages || [])
            .filter(m => m.sender === 'human' && m.text)
            .map(m => ({ text: m.text, timestamp: parseDate(m.created_at), role: 'user' }));
        if (messages.length > 0) {
            conversations.push({
                id: conv.uuid, title: conv.name || 'Untitled',
                created: parseDate(conv.created_at), messages, source: 'anthropic'
            });
        }
    }
    console.log(`  → ${conversations.length} Anthropic conversations total`);
    return conversations;
}

function loadOpenAIConversations() {
    const zipPaths = [
        path.join(DATA_DIR, 'openai', 'Conversations__user-72Z3CkLVIml90oBeXtTAY3Yv-chatgpt-0001.zip'),
        path.join(LLM_DATA_DIR, 'OpenAI-export', 'Conversations__user-72Z3CkLVIml90oBeXtTAY3Yv-chatgpt-0001.zip')
    ];

    const conversations = [];
    const seenIds = new Set();

    for (const zipPath of zipPaths) {
        if (!fs.existsSync(zipPath)) continue;
        const tempDir = `/tmp/openai_extract_${Date.now()}`;
        try {
            execSync(`rm -rf "${tempDir}" && mkdir -p "${tempDir}"`);
            execSync(`unzip -q "${zipPath}" "conversations-*.json" -d "${tempDir}" 2>/dev/null || true`);
            const files = fs.readdirSync(tempDir).filter(f => f.startsWith('conversations-') && f.endsWith('.json'));
            let count = 0;
            for (const file of files) {
                const data = JSON.parse(fs.readFileSync(path.join(tempDir, file), 'utf8'));
                for (const conv of data) {
                    if (seenIds.has(conv.id)) continue;
                    seenIds.add(conv.id);
                    const messages = [];
                    if (conv.mapping) {
                        for (const node of Object.values(conv.mapping)) {
                            if (node.message?.author?.role === 'user' && node.message?.content?.parts) {
                                const text = node.message.content.parts.filter(p => typeof p === 'string').join(' ');
                                if (text.trim()) {
                                    messages.push({ text, timestamp: parseDate(node.message.create_time || conv.create_time), role: 'user' });
                                }
                            }
                        }
                    }
                    if (messages.length > 0) {
                        messages.sort((a, b) => a.timestamp - b.timestamp);
                        conversations.push({
                            id: conv.id, title: conv.title || 'Untitled',
                            created: parseDate(conv.create_time), messages, source: 'openai'
                        });
                        count++;
                    }
                }
            }
            console.log(`  Loaded ${count} OpenAI convos from ${path.relative('.', zipPath)}`);
        } finally {
            execSync(`rm -rf "${tempDir}"`);
        }
    }
    console.log(`  → ${conversations.length} OpenAI conversations total`);
    return conversations;
}

function loadGeminiConversations() {
    // Load from pre-processed JSON (generated by python preprocess step)
    const jsonPath = path.join(DATA_DIR, 'gemini_prompts.json');
    if (!fs.existsSync(jsonPath)) {
        console.log('  Gemini: run "python3 scripts/preprocess_data.py" first');
        return [];
    }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const conversations = data.map((item, i) => {
        const date = new Date(item.timestamp);
        return {
            id: `gemini-${i}`, title: item.text.substring(0, 60),
            created: date,
            messages: [{ text: item.text, timestamp: date, role: 'user' }],
            source: 'gemini'
        };
    }).filter(c => !isNaN(c.created.getTime()));
    console.log(`  → ${conversations.length} Gemini prompts loaded`);
    return conversations;
}

function loadGoogleSearchActivity() {
    const jsonPath = path.join(DATA_DIR, 'google_searches.json');
    if (!fs.existsSync(jsonPath)) {
        console.log('  Google Search: run "python3 scripts/preprocess_data.py" first');
        return [];
    }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const searches = data.map((item, i) => {
        const date = new Date(item.timestamp);
        return {
            id: `search-${i}`, title: `Search: ${item.text}`,
            created: date,
            messages: [{ text: item.text, timestamp: date, role: 'user' }],
            source: 'google_search'
        };
    }).filter(c => !isNaN(c.created.getTime()));
    console.log(`  → ${searches.length} Google searches loaded`);
    return searches;
}

function loadSentEmails() {
    const jsonPath = path.join(DATA_DIR, 'sent_emails.json');
    if (!fs.existsSync(jsonPath)) {
        console.log('  Sent emails: run "python3 scripts/preprocess_data.py" first');
        return [];
    }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const emails = data.map((item, i) => {
        const date = new Date(item.timestamp);
        return {
            id: `email-${i}`,
            title: item.subject || `Email to ${item.to}`,
            created: date,
            messages: [{ text: item.text, timestamp: date, role: 'user' }],
            source: 'email_sent',
            metadata: { to: item.to, subject: item.subject }
        };
    }).filter(c => !isNaN(c.created.getTime()));
    console.log(`  → ${emails.length} sent emails loaded`);
    return emails;
}

function loadBeingJournals() {
    const beingDir = path.join(LLM_DATA_DIR, 'being');
    if (!fs.existsSync(beingDir)) return [];

    const entries = [];
    const seenDates = new Set();

    // Load daily notes
    const dailyDir = path.join(beingDir, 'Daily');
    if (fs.existsSync(dailyDir)) {
        for (const file of fs.readdirSync(dailyDir)) {
            if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
            const dateStr = file.replace('.md', '');
            if (seenDates.has(dateStr)) continue;
            seenDates.add(dateStr);
            try {
                const date = new Date(dateStr);
                if (isNaN(date.getTime())) continue;
                const text = fs.readFileSync(path.join(dailyDir, file), 'utf8');
                if (text.trim().length < 20) continue;
                const clean = text.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/#+\s/g, '').replace(/-\s\[.\]\s/g, '').trim();
                entries.push({
                    id: `journal-${dateStr}`,
                    title: `Journal ${dateStr}`,
                    created: date,
                    messages: [{ text: clean.substring(0, 1500), timestamp: date, role: 'user' }],
                    source: 'journal'
                });
            } catch (e) { /* skip */ }
        }
        console.log(`  Loaded ${entries.length} daily journal entries`);
    }

    // Load livingfully entries
    const livingDir = path.join(beingDir, 'livingfully');
    let livingCount = 0;
    if (fs.existsSync(livingDir)) {
        for (const file of fs.readdirSync(livingDir)) {
            if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
            const dateStr = file.replace('.md', '');
            if (seenDates.has(dateStr)) continue;
            seenDates.add(dateStr);
            try {
                const date = new Date(dateStr);
                if (isNaN(date.getTime())) continue;
                const text = fs.readFileSync(path.join(livingDir, file), 'utf8');
                if (text.trim().length < 30) continue;
                // Strip YAML frontmatter
                const stripped = text.replace(/^---[\s\S]+?---\n/, '').trim();
                if (stripped.length < 20) continue;
                entries.push({
                    id: `livingfully-${dateStr}`,
                    title: `Livingfully ${dateStr}`,
                    created: date,
                    messages: [{ text: stripped.substring(0, 1500), timestamp: date, role: 'user' }],
                    source: 'journal'
                });
                livingCount++;
            } catch (e) { /* skip */ }
        }
        console.log(`  Loaded ${livingCount} livingfully journal entries`);
    }

    // Load therapy session notes
    const therapyDir = path.join(beingDir, 'Therapy Sessions');
    if (fs.existsSync(therapyDir)) {
        for (const file of fs.readdirSync(therapyDir)) {
            if (!file.endsWith('.md')) continue;
            try {
                const content = fs.readFileSync(path.join(therapyDir, file), 'utf8');
                const dateMatch = file.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                let date;
                if (dateMatch) {
                    date = new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`);
                } else {
                    date = new Date();
                }
                if (content.trim().length > 20) {
                    entries.push({
                        id: `therapy-${file}`,
                        title: `Therapy: ${file.replace('.md', '')}`,
                        created: date,
                        messages: [{ text: content.substring(0, 1500), timestamp: date, role: 'user' }],
                        source: 'journal'
                    });
                }
            } catch (e) { /* skip */ }
        }
    }

    console.log(`  → ${entries.length} journal/personal entries total`);
    return entries;
}

// Adapt neutral chat-source records {text, timestamp, source, sender, participants, chatName}
// into this pipeline's conversation-object shape.
function adaptChatRecords(records, titlePrefix) {
    return records.map((r, i) => ({
        id: `${r.source}-${r.timestamp.getTime()}-${i}`,
        title: r.chatName ? `${titlePrefix}: ${r.chatName}` : titlePrefix,
        created: r.timestamp,
        messages: [{ text: r.text, timestamp: r.timestamp, role: 'user' }],
        source: r.source,
        metadata: { sender: r.sender, participants: r.participants, chat: r.chatName }
    })).filter(c => c.created instanceof Date && !isNaN(c.created.getTime()));
}

function loadNewChatSources() {
    const whatsapp = chatSources.loadWhatsApp(path.join(LLM_DATA_DIR, 'Whatsapp export'));
    const telegram = chatSources.loadTelegram(path.join(LLM_DATA_DIR, 'Telegram_Export_2026-09-28', 'result.json'));
    const twitterDir = fs.existsSync(LLM_DATA_DIR)
        ? fs.readdirSync(LLM_DATA_DIR).find(d => d.startsWith('twitter-'))
        : null;
    const twitter = twitterDir ? chatSources.loadTwitter(path.join(LLM_DATA_DIR, twitterDir, 'data')) : [];
    const beingExtra = chatSources.loadBeingVaultExtra(path.join(LLM_DATA_DIR, 'being'));
    return [
        ...adaptChatRecords(whatsapp, 'WhatsApp'),
        ...adaptChatRecords(telegram, 'Telegram'),
        ...adaptChatRecords(twitter, 'Twitter'),
        ...adaptChatRecords(beingExtra, 'Note')
    ];
}

// ============================================================
// Main Processing
// ============================================================

function processData() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   DalaiLLMA — Multi-Source Data Processor        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('Loading data sources...');
    const anthropicConvs = loadAnthropicConversations();
    const openaiConvs = loadOpenAIConversations();
    const geminiConvs = loadGeminiConversations();
    const searchConvs = loadGoogleSearchActivity();
    const emailConvs = loadSentEmails();
    const journalEntries = loadBeingJournals();
    const newChatConvs = loadNewChatSources();

    const allConversations = [
        ...anthropicConvs, ...openaiConvs, ...geminiConvs,
        ...searchConvs, ...emailConvs, ...journalEntries,
        ...newChatConvs
    ];
    allConversations.sort((a, b) => a.created - b.created);

    const validConvs = allConversations.filter(c => !isNaN(c.created.getTime()));
    console.log(`\nTotal sources: ${validConvs.length} entries`);
    console.log(`  Anthropic: ${anthropicConvs.length}`);
    console.log(`  OpenAI: ${openaiConvs.length}`);
    console.log(`  Gemini: ${geminiConvs.length}`);
    console.log(`  Google Search: ${searchConvs.length}`);
    console.log(`  Sent Emails: ${emailConvs.length}`);
    console.log(`  Journals: ${journalEntries.length}`);
    console.log(`  New chat sources (WhatsApp/Telegram/Twitter/Notes): ${newChatConvs.length}`);

    const startDate = validConvs[0]?.created;
    const endDate = validConvs[validConvs.length - 1]?.created;
    if (startDate) console.log(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    // Aggregate by week and month
    const weeklyData = {};
    const monthlyData = {};
    const allWordFreq = {};
    const wordFreqByMonth = {};
    const peopleData = {};
    const dramaByMonth = {};
    const sourcesByMonth = {};
    const events = [];

    for (const conv of validConvs) {
        const monthKey = getMonthKey(conv.created);

        if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = { messages: 0, text: '', conversations: 0, titles: [], bySource: {} };
        }
        if (!wordFreqByMonth[monthKey]) wordFreqByMonth[monthKey] = {};
        if (!dramaByMonth[monthKey]) dramaByMonth[monthKey] = { victim: 0, persecutor: 0, rescuer: 0, empowered: 0 };
        if (!sourcesByMonth[monthKey]) sourcesByMonth[monthKey] = {};

        monthlyData[monthKey].conversations++;
        monthlyData[monthKey].titles.push(conv.title);
        sourcesByMonth[monthKey][conv.source] = (sourcesByMonth[monthKey][conv.source] || 0) + 1;

        for (const msg of conv.messages) {
            if (!msg.text) continue;
            const weekKey = getWeekKey(msg.timestamp || conv.created);
            const msgMonth = getMonthKey(msg.timestamp || conv.created);

            if (!weeklyData[weekKey]) weeklyData[weekKey] = { messages: 0, text: '', sentiment: 0, agency: 0 };
            if (!monthlyData[msgMonth]) {
                monthlyData[msgMonth] = { messages: 0, text: '', conversations: 0, titles: [], bySource: {} };
            }

            weeklyData[weekKey].messages++;
            weeklyData[weekKey].text += ' ' + msg.text;
            monthlyData[msgMonth].messages++;
            monthlyData[msgMonth].text += ' ' + msg.text;

            // Word frequencies (skip for search - too many fragments)
            if (conv.source !== 'google_search') {
                const wordFreq = getWordFrequencies(msg.text);
                for (const [word, count] of Object.entries(wordFreq)) {
                    allWordFreq[word] = (allWordFreq[word] || 0) + count;
                    if (!wordFreqByMonth[msgMonth]) wordFreqByMonth[msgMonth] = {};
                    wordFreqByMonth[msgMonth][word] = (wordFreqByMonth[msgMonth][word] || 0) + count;
                }
            }

            // People
            const peopleMentions = countPeople(msg.text);
            for (const [person, count] of Object.entries(peopleMentions)) {
                if (!peopleData[person]) peopleData[person] = { total: 0, byMonth: {}, sentiment: 0, textSamples: [] };
                peopleData[person].total += count;
                peopleData[person].byMonth[msgMonth] = (peopleData[person].byMonth[msgMonth] || 0) + count;
                if (count > 0 && peopleData[person].textSamples.length < 10) {
                    peopleData[person].textSamples.push(msg.text.substring(0, 200));
                }
            }

            // Drama triangle
            if (!dramaByMonth[msgMonth]) dramaByMonth[msgMonth] = { victim: 0, persecutor: 0, rescuer: 0, empowered: 0 };
            const drama = calculateDramaTriangle(msg.text);
            dramaByMonth[msgMonth].victim += drama.victim;
            dramaByMonth[msgMonth].persecutor += drama.persecutor;
            dramaByMonth[msgMonth].rescuer += drama.rescuer;
            dramaByMonth[msgMonth].empowered += drama.empowered;
        }

        // Detect events from titles
        const titleLower = conv.title.toLowerCase();
        const eventCategories = [
            { kw: ['therapy', 'therapist', 'ifs', 'session'], cat: 'therapy' },
            { kw: ['breakup', 'break up', 'ending', 'relationship', 'liliia', 'beziehung'], cat: 'relationship' },
            { kw: ['job', 'work', 'interview', 'werkstudent', 'bewerbung', 'rolls royce', 'sap'], cat: 'work' },
            { kw: ['doctor', 'hospital', 'injury', 'sick', 'health', 'arzt', 'fuss', 'foot', 'op'], cat: 'health' },
            { kw: ['travel', 'trip', 'train', 'flight', 'bali', 'garbicz', 'retreat'], cat: 'travel' },
            { kw: ['birthday', 'wedding', 'family', 'geburtstag', 'moving', 'umzug', 'wohnung'], cat: 'life' }
        ];
        for (const { kw, cat } of eventCategories) {
            if (kw.some(k => titleLower.includes(k))) {
                events.push({
                    date: conv.created.toISOString().split('T')[0],
                    title: conv.title,
                    category: cat,
                    source: conv.source
                });
                break;
            }
        }
    }

    // Calculate weekly/monthly metrics
    const weeks = Object.keys(weeklyData).sort();
    const months = Object.keys(monthlyData).sort((a, b) => {
        const [ma, ya] = a.split(' ');
        const [mb, yb] = b.split(' ');
        return new Date(`${ma} 1, ${ya}`) - new Date(`${mb} 1, ${yb}`);
    });

    const weeklyResults = [];
    for (const week of weeks) {
        const data = weeklyData[week];
        if (data.messages > 0) {
            const sentiment = calculateSentiment(data.text);
            const agency = calculateAgency(data.text);
            const wellbeing = Math.round(50 + sentiment * 45 + (agency - 50) * 0.15);
            weeklyResults.push({
                week, sentiment: Math.round(sentiment * 100) / 100,
                agency, wellbeing: Math.min(100, Math.max(0, wellbeing)),
                messages: data.messages
            });
        }
    }

    const monthlyResults = [];
    const monthSummaries = {};
    for (const month of months) {
        const data = monthlyData[month];
        if (data.messages > 0) {
            const sentiment = calculateSentiment(data.text);
            const agency = calculateAgency(data.text);
            const wellbeing = Math.round(50 + sentiment * 45 + (agency - 50) * 0.15);
            monthSummaries[month] = {
                topics: [...new Set(data.titles.slice(0, 20))],
                keyConversations: data.titles.filter(t => t.length > 10).slice(0, 5),
                themes: data.titles.slice(0, 3).join(', '),
                sources: sourcesByMonth[month] || {}
            };
            monthlyResults.push({
                month, sentiment: Math.round(sentiment * 100) / 100,
                agency, wellbeing: Math.min(100, Math.max(0, wellbeing)),
                messages: data.messages, conversations: data.conversations,
                sources: sourcesByMonth[month] || {}
            });
        }
    }

    // People sentiment
    for (const [person, data] of Object.entries(peopleData)) {
        let totalSentiment = 0;
        for (const sample of data.textSamples) totalSentiment += calculateSentiment(sample);
        data.sentiment = data.textSamples.length > 0
            ? Math.round((totalSentiment / data.textSamples.length) * 100) / 100 : 0;
        delete data.textSamples;
    }

    // Word frequencies
    const formattedWordFreq = {
        all: Object.entries(allWordFreq).sort((a, b) => b[1] - a[1]).slice(0, 100)
    };
    for (const [month, freq] of Object.entries(wordFreqByMonth)) {
        formattedWordFreq[month] = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 50);
    }

    // Dedup events
    const uniqueEvents = [];
    const seenEvents = new Set();
    for (const evt of events) {
        const key = `${evt.date}-${evt.category}`;
        if (!seenEvents.has(key)) { seenEvents.add(key); uniqueEvents.push(evt); }
    }

    const output = {
        metadata: {
            generated: new Date().toISOString(),
            dateRange: { start: startDate?.toISOString(), end: endDate?.toISOString() },
            totalConversations: validConvs.length,
            totalMessages: Object.values(weeklyData).reduce((s, w) => s + w.messages, 0),
            sources: {
                anthropic: anthropicConvs.length,
                openai: openaiConvs.length,
                gemini: geminiConvs.length,
                google_search: searchConvs.length,
                email_sent: emailConvs.length,
                journal: journalEntries.length
            }
        },
        weeklyData: weeklyResults,
        monthlyData: monthlyResults,
        peopleData,
        events: uniqueEvents.slice(0, 500),
        wordFrequencies: formattedWordFreq,
        dramaTriangle: dramaByMonth,
        monthSummaries
    };

    const outputPath = path.join(OUTPUT_DIR, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`\n✓ Written to ${outputPath}`);
    console.log(`  ${weeklyResults.length} weeks of data`);
    console.log(`  ${monthlyResults.length} months of data`);
    console.log(`  ${Object.keys(peopleData).length} people tracked`);
    console.log(`  ${uniqueEvents.length} events detected`);
}

processData();
