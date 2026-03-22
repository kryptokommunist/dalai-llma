const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration - paths relative to repo root
const DATA_DIR = process.env.DATA_DIR || './data';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const ANTHROPIC_DIR = path.join(DATA_DIR, 'anthropic');
const OPENAI_DIR = path.join(DATA_DIR, 'openai');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Find OpenAI zip file dynamically
function findOpenAIZip() {
    if (!fs.existsSync(OPENAI_DIR)) return null;
    const files = fs.readdirSync(OPENAI_DIR);
    const zip = files.find(f => f.endsWith('.zip') && f.includes('Conversations'));
    return zip ? path.join(OPENAI_DIR, zip) : null;
}
const OPENAI_ZIP_PATH = findOpenAIZip();

// Word lists for sentiment analysis (English + German)
const hopefulWords = [
    // English
    'better', 'good', 'great', 'hope', 'excited', 'looking forward', 'healing', 'progress', 'improving', 'alive', 'free', 'liberated', 'release', 'happy', 'joy', 'love', 'beautiful', 'amazing', 'wonderful', 'grateful', 'thankful', 'proud', 'peaceful', 'calm', 'confident', 'strong', 'growing', 'learning', 'understanding', 'clarity', 'trust', 'connected', 'supported', 'safe', 'magic', 'magical', 'fantastic', 'awesome', 'nice', 'fun', 'enjoying', 'enjoyed', 'relaxed', 'energized', 'motivated', 'inspired', 'creative', 'open', 'curious', 'playful',
    // German
    'besser', 'gut', 'toll', 'super', 'hoffnung', 'freude', 'glücklich', 'froh', 'schön', 'wunderbar', 'fantastisch', 'großartig', 'dankbar', 'stolz', 'friedlich', 'ruhig', 'stark', 'frei', 'befreit', 'lebendig', 'sicher', 'vertrauen', 'verbunden', 'geborgen', 'entspannt', 'motiviert', 'inspiriert', 'neugierig', 'offen', 'heilung', 'fortschritt', 'liebe', 'liebevoll', 'herzlich', 'wunderschön', 'genial', 'klasse', 'prima', 'geil', 'krass'
];
const despairWords = [
    // English
    'alone', 'scared', 'afraid', 'pain', 'hurt', 'crying', 'sobbing', 'anxious', 'worried', 'stuck', 'trapped', 'angry', 'fucking', 'fuck', 'sad', 'depressed', 'hopeless', 'helpless', 'lost', 'confused', 'overwhelmed', 'exhausted', 'tired', 'frustrated', 'disappointed', 'lonely', 'empty', 'broken', 'failed', 'hate', 'terrible', 'awful', 'horrible', 'miserable', 'suffering', 'triggered', 'dissociated', 'dissociating', 'numb', 'disconnected', 'isolated', 'rejected', 'abandoned', 'worthless', 'shame', 'guilt', 'panic', 'terror', 'dread', 'despair', 'grief', 'trauma',
    // German
    'allein', 'einsam', 'angst', 'ängstlich', 'schmerz', 'schmerzen', 'weinen', 'traurig', 'deprimiert', 'hoffnungslos', 'hilflos', 'verloren', 'verwirrt', 'überfordert', 'erschöpft', 'müde', 'frustriert', 'enttäuscht', 'wütend', 'sauer', 'hass', 'hassen', 'schrecklich', 'furchtbar', 'schlimm', 'elend', 'leid', 'leiden', 'qual', 'panik', 'verzweifelt', 'verzweiflung', 'trauer', 'schuld', 'scham', 'wertlos', 'kaputt', 'gebrochen', 'scheisse', 'scheiße', 'mist', 'kacke', 'getriggert', 'dissoziiert'
];

// Agency patterns (English + German)
const agencyPhrases = [
    // English
    'i can', 'i will', 'i want', 'i choose', 'i decided', 'i need to', 'i am going to', 'i know', 'i\'m going to', 'i\'ll', 'my choice', 'my decision', 'i realize', 'i understand', 'i accept', 'i appreciate', 'i\'m learning', 'i\'m growing', 'i noticed', 'i recognize',
    // German
    'ich kann', 'ich werde', 'ich will', 'ich möchte', 'ich entscheide', 'ich habe entschieden', 'ich weiß', 'ich verstehe', 'ich erkenne', 'ich akzeptiere', 'ich lerne', 'meine entscheidung', 'meine wahl', 'ich merke', 'ich bemerke', 'ich realisiere'
];
const victimPhrases = [
    // English
    'i can\'t', 'i have to', 'i should', 'why me', 'it\'s not fair', 'stuck', 'trapped', 'helpless', 'hopeless', 'i must', 'i\'m forced', 'no choice', 'nothing i can do', 'i don\'t know what to do', 'i feel like i have to',
    // German
    'ich kann nicht', 'ich muss', 'ich sollte', 'warum ich', 'nicht fair', 'gefangen', 'hilflos', 'hoffnungslos', 'keine wahl', 'ich weiß nicht', 'ich schaffe es nicht', 'es geht nicht', 'ich bin gezwungen'
];

// Drama triangle patterns
const victimPatterns = ['why me', 'it\'s not fair', 'i can\'t', 'helpless', 'stuck', 'trapped', 'poor me', 'nothing ever works', 'always happens to me'];
const persecutorPatterns = ['they always', 'they never', 'fault', 'blame', 'should have', 'it\'s their', 'stupid', 'idiot', 'they ruined'];
const rescuerPatterns = ['i need to help', 'fix this', 'save', 'let me handle', 'i\'ll take care', 'don\'t worry', 'i\'ll do it for'];
const empoweredPatterns = ['i choose', 'i will', 'i can', 'i decided', 'my responsibility', 'i want', 'i realize', 'i accept', 'i appreciate'];

// People to track
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
    'julie': /\bjulie\b/gi
};

// Stopwords for word cloud (English + German)
const stopwords = new Set([
    // English stopwords
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then', 'if', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'once', 'any', 'because', 'being', 'even', 'get', 'got', 'having', 'like', 'make', 'made', 'many', 'much', 'one', 'out', 'over', 'really', 'right', 'say', 'said', 'see', 'still', 'thing', 'things', 'think', 'thought', 'time', 'up', 'us', 'want', 'way', 'well', 'went', 'yeah', 'yes', 'yet', 'your', 'know', 'going', 'something', 'feel', 'lot', 'back', 'day', 'im', 'dont', 'thats', 'ive', 'youre', 'didnt', 'couldnt', 'wouldnt', 'cant', 'wont', 'lets', 'hes', 'shes', 'theyre', 'were', 'wasnt', 'werent', 'arent', 'isnt', 'hasnt', 'havent', 'hadnt', 'doesnt', 'didnt', 'theres', 'heres', 'whats', 'whos', 'whens', 'wheres', 'whys', 'hows', 'bit', 'maybe', 'actually', 'kind', 'around', 'part', 'shared', 'basically', 'somehow', 'mean', 'okay', 'told', 'asked', 'seems', 'seemed', 'started', 'talking', 'saying', 'went', 'come', 'came', 'goes', 'done', 'put', 'take', 'took', 'give', 'gave', 'looked', 'look', 'looking', 'makes', 'making', 'getting', 'use', 'used', 'using', 'trying', 'tried', 'set', 'keep', 'kept', 'let', 'https', 'www', 'com',
    // German stopwords
    'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'und', 'oder', 'aber', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines', 'ist', 'sind', 'war', 'waren', 'sein', 'haben', 'hat', 'hatte', 'hatten', 'wird', 'werden', 'wurde', 'wurden', 'kann', 'konnte', 'muss', 'musste', 'soll', 'sollte', 'will', 'wollte', 'darf', 'durfte', 'mag', 'mochte', 'nicht', 'kein', 'keine', 'keiner', 'keinem', 'keinen', 'mehr', 'noch', 'schon', 'auch', 'nur', 'sehr', 'viel', 'wenn', 'als', 'dass', 'weil', 'damit', 'obwohl', 'bevor', 'nachdem', 'warum', 'wie', 'was', 'wer', 'wo', 'wann', 'welche', 'welcher', 'welches', 'dieser', 'diese', 'dieses', 'jener', 'jene', 'jenes', 'hier', 'dort', 'dann', 'jetzt', 'immer', 'nie', 'oft', 'manchmal', 'heute', 'gestern', 'morgen', 'auf', 'aus', 'bei', 'bis', 'durch', 'für', 'gegen', 'hinter', 'mit', 'nach', 'neben', 'ohne', 'seit', 'über', 'unter', 'vor', 'zwischen', 'von', 'zum', 'zur', 'ins', 'ans', 'aufs', 'mich', 'dich', 'sich', 'uns', 'euch', 'mir', 'dir', 'ihm', 'ihr', 'ihnen', 'mein', 'dein', 'sein', 'unser', 'euer', 'nen', 'nem', 'sch', 'hab', 'mal', 'grad', 'halt', 'echt', 'ganz', 'ja', 'nein', 'doch', 'also', 'na', 'eben', 'wohl', 'etwa', 'zwar', 'bzw', 'usw', 'etc', 'evtl', 'ggf', 'bspw', 'zb',
    // More German verbs and common words
    'habe', 'bin', 'bist', 'gehe', 'geht', 'gab', 'gibt', 'geben', 'gegeben', 'kommen', 'kommt', 'kam', 'gekommen', 'gehen', 'ging', 'gegangen', 'sagen', 'sagt', 'sagte', 'gesagt', 'machen', 'macht', 'machte', 'gemacht', 'lassen', 'ließ', 'wissen', 'weiß', 'wusste', 'sehen', 'sieht', 'sah', 'gesehen', 'finden', 'findet', 'fand', 'gefunden', 'stehen', 'steht', 'stand', 'gestanden', 'liegen', 'liegt', 'lag', 'gelegen', 'bleiben', 'bleibt', 'blieb', 'geblieben', 'denken', 'denkt', 'dachte', 'gedacht', 'glauben', 'glaubt', 'glaubte', 'geglaubt', 'halten', 'hielt', 'gehalten', 'nennen', 'nennt', 'nannte', 'genannt', 'zeigen', 'zeigt', 'zeigte', 'gezeigt', 'sprechen', 'spricht', 'sprach', 'gesprochen', 'bringen', 'bringt', 'brachte', 'gebracht', 'leben', 'lebt', 'lebte', 'gelebt', 'fahren', 'fuhr', 'gefahren', 'meinen', 'meint', 'meinte', 'gemeint', 'fragen', 'fragt', 'fragte', 'gefragt', 'kennen', 'kennt', 'kannte', 'gekannt', 'gerne', 'herr', 'frau', 'freundlichen', 'glich', 'ltnis', 'bernahme', 'bergabeprotokoll', 'abend',
    // Contractions and artifacts
    'don', 've', 'll', 're', 'didn', 'doesn', 'wouldn', 'couldn', 'shouldn', 'wasn', 'weren', 'isn', 'aren', 'hasn', 'haven', 'hadn', 'won', 'ain', 'de__', '__aiden', 'kinda', 'gonna', 'wanna', 'gotta', 'lotta', 'sorta', 'outta', 'dunno', 'lemme', 'gimme'
]);

// Helper functions
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
    const year = d.getFullYear();
    return `${year}-W${weekNum.toString().padStart(2, '0')}`;
}

function getMonthKey(date) {
    const d = new Date(date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

function countPatterns(text, patterns) {
    let count = 0;
    const lowerText = text.toLowerCase();
    for (const pattern of patterns) {
        const regex = new RegExp(pattern.toLowerCase(), 'gi');
        const matches = lowerText.match(regex);
        if (matches) count += matches.length;
    }
    return count;
}

function calculateSentiment(text) {
    const lowerText = text.toLowerCase();
    let hopeful = 0, despair = 0;

    for (const word of hopefulWords) {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) hopeful += matches.length;
    }

    for (const word of despairWords) {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) despair += matches.length;
    }

    const total = hopeful + despair;
    if (total === 0) return 0;
    return (hopeful - despair) / total;
}

function calculateAgency(text) {
    const lowerText = text.toLowerCase();
    const agency = countPatterns(text, agencyPhrases);
    const victim = countPatterns(text, victimPhrases);
    const total = agency + victim;
    if (total === 0) return 50;
    return Math.round((agency / total) * 100);
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
    for (const word of words) {
        freq[word] = (freq[word] || 0) + 1;
    }
    return freq;
}

function countPeople(text) {
    const counts = {};
    for (const [person, regex] of Object.entries(peoplePatterns)) {
        const matches = text.match(regex);
        if (matches) {
            counts[person] = matches.length;
        }
    }
    return counts;
}

// Load Anthropic conversations
function loadAnthropicConversations() {
    const filePath = path.join(ANTHROPIC_DIR, 'conversations.json');
    console.log('Loading Anthropic conversations...');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`Loaded ${data.length} Anthropic conversations`);

    const conversations = [];
    for (const conv of data) {
        const messages = [];
        if (conv.chat_messages) {
            for (const msg of conv.chat_messages) {
                if (msg.sender === 'human' && msg.text) {
                    messages.push({
                        text: msg.text,
                        timestamp: parseDate(msg.created_at),
                        role: 'user'
                    });
                }
            }
        }
        if (messages.length > 0) {
            conversations.push({
                id: conv.uuid,
                title: conv.name || 'Untitled',
                created: parseDate(conv.created_at),
                messages,
                source: 'anthropic'
            });
        }
    }
    return conversations;
}

// Load OpenAI conversations
function loadOpenAIConversations() {
    console.log('Loading OpenAI conversations...');

    // Extract JSON files from zip
    const tempDir = '/tmp/openai_extract';
    execSync(`rm -rf ${tempDir} && mkdir -p ${tempDir}`);
    execSync(`unzip -q "${OPENAI_ZIP_PATH}" "conversations-*.json" -d ${tempDir}`, { cwd: process.cwd() });

    const conversations = [];
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith('conversations-') && f.endsWith('.json'));

    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(tempDir, file), 'utf8'));
        for (const conv of data) {
            const messages = [];
            if (conv.mapping) {
                for (const [id, node] of Object.entries(conv.mapping)) {
                    if (node.message && node.message.author?.role === 'user' && node.message.content?.parts) {
                        const text = node.message.content.parts.filter(p => typeof p === 'string').join(' ');
                        if (text) {
                            messages.push({
                                text,
                                timestamp: parseDate(node.message.create_time),
                                role: 'user'
                            });
                        }
                    }
                }
            }
            if (messages.length > 0) {
                // Sort messages by timestamp
                messages.sort((a, b) => a.timestamp - b.timestamp);
                conversations.push({
                    id: conv.id,
                    title: conv.title || 'Untitled',
                    created: parseDate(conv.create_time),
                    messages,
                    source: 'openai'
                });
            }
        }
    }

    console.log(`Loaded ${conversations.length} OpenAI conversations`);
    execSync(`rm -rf ${tempDir}`);
    return conversations;
}

// Main processing
function processData() {
    // Load all conversations
    const anthropicConvs = loadAnthropicConversations();
    const openaiConvs = loadOpenAIConversations();
    const allConversations = [...anthropicConvs, ...openaiConvs];

    console.log(`Total conversations: ${allConversations.length}`);

    // Sort by date
    allConversations.sort((a, b) => a.created - b.created);

    // Get date range
    const startDate = allConversations[0].created;
    const endDate = allConversations[allConversations.length - 1].created;
    console.log(`Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // Aggregate data by week and month
    const weeklyData = {};
    const monthlyData = {};
    const allWordFreq = {};
    const wordFreqByMonth = {};
    const peopleData = {};
    const dramaByMonth = {};
    const monthSummaries = {};
    const events = [];

    for (const conv of allConversations) {
        const weekKey = getWeekKey(conv.created);
        const monthKey = getMonthKey(conv.created);

        // Initialize data structures
        if (!weeklyData[weekKey]) {
            weeklyData[weekKey] = { messages: 0, text: '', sentiment: 0, agency: 0 };
        }
        if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = { messages: 0, text: '', conversations: 0, titles: [] };
        }
        if (!wordFreqByMonth[monthKey]) {
            wordFreqByMonth[monthKey] = {};
        }
        if (!dramaByMonth[monthKey]) {
            dramaByMonth[monthKey] = { victim: 0, persecutor: 0, rescuer: 0, empowered: 0 };
        }

        // Aggregate messages
        monthlyData[monthKey].conversations++;
        monthlyData[monthKey].titles.push(conv.title);

        for (const msg of conv.messages) {
            const msgWeek = getWeekKey(msg.timestamp);
            const msgMonth = getMonthKey(msg.timestamp);

            if (!weeklyData[msgWeek]) {
                weeklyData[msgWeek] = { messages: 0, text: '', sentiment: 0, agency: 0 };
            }
            if (!monthlyData[msgMonth]) {
                monthlyData[msgMonth] = { messages: 0, text: '', conversations: 0, titles: [] };
            }

            weeklyData[msgWeek].messages++;
            weeklyData[msgWeek].text += ' ' + msg.text;

            monthlyData[msgMonth].messages++;
            monthlyData[msgMonth].text += ' ' + msg.text;

            // Word frequencies
            const wordFreq = getWordFrequencies(msg.text);
            for (const [word, count] of Object.entries(wordFreq)) {
                allWordFreq[word] = (allWordFreq[word] || 0) + count;
                if (!wordFreqByMonth[msgMonth]) wordFreqByMonth[msgMonth] = {};
                wordFreqByMonth[msgMonth][word] = (wordFreqByMonth[msgMonth][word] || 0) + count;
            }

            // People mentions
            const peopleMentions = countPeople(msg.text);
            for (const [person, count] of Object.entries(peopleMentions)) {
                if (!peopleData[person]) {
                    peopleData[person] = { total: 0, byMonth: {}, sentiment: 0, textSamples: [] };
                }
                peopleData[person].total += count;
                peopleData[person].byMonth[msgMonth] = (peopleData[person].byMonth[msgMonth] || 0) + count;
                if (count > 0 && peopleData[person].textSamples.length < 10) {
                    peopleData[person].textSamples.push(msg.text.substring(0, 200));
                }
            }

            // Drama triangle
            if (!dramaByMonth[msgMonth]) {
                dramaByMonth[msgMonth] = { victim: 0, persecutor: 0, rescuer: 0, empowered: 0 };
            }
            const drama = calculateDramaTriangle(msg.text);
            dramaByMonth[msgMonth].victim += drama.victim;
            dramaByMonth[msgMonth].persecutor += drama.persecutor;
            dramaByMonth[msgMonth].rescuer += drama.rescuer;
            dramaByMonth[msgMonth].empowered += drama.empowered;
        }

        // Detect significant events from titles (both Anthropic and OpenAI)
        const titleLower = conv.title.toLowerCase();
        if (titleLower.includes('therapy') || titleLower.includes('therapist')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'therapy', source: conv.source });
        } else if (titleLower.includes('breakup') || titleLower.includes('break up') || titleLower.includes('ending') || titleLower.includes('relationship')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'relationship', source: conv.source });
        } else if (titleLower.includes('job') || titleLower.includes('work') || titleLower.includes('interview')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'work', source: conv.source });
        } else if (titleLower.includes('doctor') || titleLower.includes('hospital') || titleLower.includes('injury') || titleLower.includes('sick') || titleLower.includes('health')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'health', source: conv.source });
        } else if (titleLower.includes('travel') || titleLower.includes('trip') || titleLower.includes('train') || titleLower.includes('flight')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'travel', source: conv.source });
        } else if (titleLower.includes('birthday') || titleLower.includes('wedding') || titleLower.includes('family')) {
            events.push({ date: conv.created.toISOString().split('T')[0], title: conv.title, category: 'social', source: conv.source });
        }
    }

    // Calculate sentiment and agency for each period
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
                week,
                sentiment: Math.round(sentiment * 100) / 100,
                agency,
                wellbeing: Math.min(100, Math.max(0, wellbeing)),
                messages: data.messages
            });
        }
    }

    const monthlyResults = [];
    for (const month of months) {
        const data = monthlyData[month];
        if (data.messages > 0) {
            const sentiment = calculateSentiment(data.text);
            const agency = calculateAgency(data.text);
            const wellbeing = Math.round(50 + sentiment * 45 + (agency - 50) * 0.15);

            // Create month summary
            monthSummaries[month] = {
                topics: [...new Set(data.titles.slice(0, 20))],
                keyConversations: data.titles.filter(t => t.length > 10).slice(0, 5),
                themes: data.titles.slice(0, 3).join(', ')
            };

            monthlyResults.push({
                month,
                sentiment: Math.round(sentiment * 100) / 100,
                agency,
                wellbeing: Math.min(100, Math.max(0, wellbeing)),
                messages: data.messages,
                conversations: data.conversations
            });
        }
    }

    // Calculate people sentiment
    for (const [person, data] of Object.entries(peopleData)) {
        let totalSentiment = 0;
        for (const sample of data.textSamples) {
            totalSentiment += calculateSentiment(sample);
        }
        data.sentiment = data.textSamples.length > 0 ?
            Math.round((totalSentiment / data.textSamples.length) * 100) / 100 : 0;
        delete data.textSamples; // Remove to save space
    }

    // Format word frequencies
    const formattedWordFreq = {
        all: Object.entries(allWordFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 100)
    };

    for (const [month, freq] of Object.entries(wordFreqByMonth)) {
        formattedWordFreq[month] = Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50);
    }

    // Deduplicate events
    const uniqueEvents = [];
    const seenDates = new Set();
    for (const event of events) {
        const key = `${event.date}-${event.category}`;
        if (!seenDates.has(key)) {
            seenDates.add(key);
            uniqueEvents.push(event);
        }
    }

    // Build final output
    const output = {
        metadata: {
            generated: new Date().toISOString(),
            dateRange: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            },
            totalConversations: allConversations.length,
            totalMessages: Object.values(weeklyData).reduce((sum, w) => sum + w.messages, 0),
            sources: {
                anthropic: anthropicConvs.length,
                openai: openaiConvs.length
            }
        },
        weeklyData: weeklyResults,
        monthlyData: monthlyResults,
        peopleData,
        events: uniqueEvents.slice(0, 50),
        wordFrequencies: formattedWordFreq,
        dramaTriangle: dramaByMonth,
        monthSummaries
    };

    // Write output
    const outputPath = path.join(OUTPUT_DIR, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\nData written to ${outputPath}`);
    console.log(`- ${weeklyResults.length} weeks of data`);
    console.log(`- ${monthlyResults.length} months of data`);
    console.log(`- ${Object.keys(peopleData).length} people tracked`);
    console.log(`- ${uniqueEvents.length} events detected`);
}

processData();
