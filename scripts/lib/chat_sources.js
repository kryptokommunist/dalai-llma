/**
 * Shared parsers for chat/message export sources.
 *
 * Used by BOTH pipelines (scripts/analyze_all.js — LLM analysis, and
 * scripts/process_data.js — sentiment/stats) so the parsing lives in one place.
 *
 * Every loader returns a NEUTRAL flat record list:
 *   { text, timestamp: Date, source, sender?, participants?, chatName? }
 * Each pipeline adapts these to its own internal shape.
 *
 * Group-chat rules (per the user's spec):
 *   - Skip any group chat the user never participated in.
 *   - Within a kept group chat, keep only messages within ±1 month of a month
 *     the user themselves sent in (windowAroundSelf). 1:1 chats keep everything.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Who "I" am across sources, for self-participation detection.
const ME = {
    names: ['marcus', 'kryptokommunist', 'you'],   // lowercased for matching
    phones: ['+4917695855565'],
    telegramUserId: '27397086',                    // from personal_information.user_id
    twitterAccountId: '32420160'
};

const MONTH_PAD_DEFAULT = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Shift a YYYY-MM key by n months (n may be negative). */
function shiftMonth(key, n) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return monthKey(d);
}

/**
 * Keep only messages whose month is within ±monthsPadding of a month the user
 * sent in. `isMine(msg)` returns true when the message was sent by the user.
 * Messages must carry a `.timestamp` Date. Returns a filtered array.
 */
function windowAroundSelf(messages, isMine, monthsPadding = MONTH_PAD_DEFAULT) {
    const myMonths = new Set();
    for (const m of messages) {
        if (m.timestamp && !isNaN(m.timestamp) && isMine(m)) {
            myMonths.add(monthKey(m.timestamp));
        }
    }
    if (myMonths.size === 0) return [];
    const keep = new Set();
    for (const mk of myMonths) {
        for (let i = -monthsPadding; i <= monthsPadding; i++) keep.add(shiftMonth(mk, i));
    }
    return messages.filter(m => m.timestamp && !isNaN(m.timestamp) && keep.has(monthKey(m.timestamp)));
}

const nameIsMine = (name) => {
    if (!name) return false;
    const n = String(name).trim().toLowerCase();
    return ME.names.includes(n) || ME.phones.some(p => n.includes(p));
};

/**
 * Parse a single Obsidian/markdown file into a neutral journal record, or null
 * if too short / undatable. Strips YAML frontmatter and wikilinks; dates from
 * `YYYY-MM-DD` in the filename, else file mtime.
 */
function parseMarkdownEntry(filePath, fileName) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        content = content.replace(/^---[\s\S]*?---\n/, '');            // frontmatter
        content = content.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1'); // wikilinks
        const trimmed = content.trim();
        if (trimmed.length < 20) return null;

        const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
        let ts;
        if (dateMatch) {
            ts = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
        } else {
            ts = fs.statSync(filePath).mtime;
        }
        if (isNaN(ts.getTime())) return null;

        return { text: trimmed.substring(0, 2000), timestamp: ts, source: 'journal' };
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// WhatsApp — directory of per-chat zips, each with chat.txt
// iOS format:  [M/D/YY, H:MM:SS AM] Sender: body     (self sender == "You")
// ---------------------------------------------------------------------------

function parseWhatsAppDate(dateStr, timeStr) {
    // dateStr like "4/13/25", timeStr like "5:46:12 PM" or "17:46:12"
    const dm = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!dm) return null;
    let [, mo, da, yr] = dm;
    if (yr.length === 2) yr = '20' + yr;
    let hh = 0, mm = 0;
    const tm = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
    if (tm) {
        hh = parseInt(tm[1], 10); mm = parseInt(tm[2], 10);
        const mer = (tm[4] || '').toLowerCase();
        if (mer === 'pm' && hh < 12) hh += 12;
        if (mer === 'am' && hh === 12) hh = 0;
    }
    const d = new Date(Number(yr), Number(mo) - 1, Number(da), hh, mm);
    return isNaN(d.getTime()) ? null : d;
}

function loadWhatsApp(whatsappDir, { monthsPadding = MONTH_PAD_DEFAULT } = {}) {
    const out = [];
    if (!fs.existsSync(whatsappDir)) return out;
    const zips = fs.readdirSync(whatsappDir).filter(f => f.toLowerCase().endsWith('.zip'));
    let skippedNoSelf = 0, groupsWindowed = 0;

    const lineRe = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+([^\]]+)\]\s+([^:]+):\s?([\s\S]*)$/;

    for (const zip of zips) {
        const tmp = fs.mkdtempSync('/tmp/wa_');
        try {
            execSync(`unzip -q -o "${path.join(whatsappDir, zip)}" -d "${tmp}" 2>/dev/null || true`);
            const txtPath = path.join(tmp, 'chat.txt');
            if (!fs.existsSync(txtPath)) continue;
            const raw = fs.readFileSync(txtPath, 'utf8');

            // Parse into messages, joining multi-line bodies onto the previous msg.
            const msgs = [];
            for (const line of raw.split('\n')) {
                const m = line.match(lineRe);
                if (m) {
                    const ts = parseWhatsAppDate(m[1], m[2]);
                    msgs.push({ timestamp: ts, sender: m[3].trim(), text: m[4] });
                } else if (msgs.length && line.trim()) {
                    msgs[msgs.length - 1].text += '\n' + line;
                }
            }
            if (!msgs.length) continue;

            const senders = new Set(msgs.map(m => m.sender));
            const isGroup = senders.size > 2;
            const hasSelf = msgs.some(m => nameIsMine(m.sender));
            if (isGroup && !hasSelf) { skippedNoSelf++; continue; }

            let kept = msgs;
            if (isGroup) { kept = windowAroundSelf(msgs, m => nameIsMine(m.sender), monthsPadding); groupsWindowed++; }

            const chatName = zip.replace(/\.zip$/i, '');
            for (const m of kept) {
                if (!m.timestamp || isNaN(m.timestamp) || !m.text.trim()) continue;
                out.push({
                    text: m.text.trim().substring(0, 2000),
                    timestamp: m.timestamp,
                    source: 'whatsapp',
                    sender: m.sender,
                    chatName,
                    participants: [...senders]
                });
            }
        } catch (e) {
            // skip unreadable zip
        } finally {
            try { execSync(`rm -rf "${tmp}"`); } catch (e) {}
        }
    }
    console.log(`  WhatsApp: ${out.length} messages (${skippedNoSelf} group chats skipped — no self-participation)`);
    return out;
}

// ---------------------------------------------------------------------------
// Telegram — single result.json with chats.list[]
// ---------------------------------------------------------------------------

function flattenTelegramText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) {
        return text.map(t => (typeof t === 'string' ? t : (t && t.text) || '')).join('');
    }
    return '';
}

function loadTelegram(resultJsonPath, { monthsPadding = MONTH_PAD_DEFAULT } = {}) {
    const out = [];
    if (!fs.existsSync(resultJsonPath)) return out;
    let data;
    try { data = JSON.parse(fs.readFileSync(resultJsonPath, 'utf8')); }
    catch (e) { console.log('  Telegram: result.json unreadable'); return out; }

    const myId = 'user' + (data.personal_information?.user_id || ME.telegramUserId);
    const chats = data.chats?.list || [];
    let skippedNoSelf = 0;

    for (const chat of chats) {
        const isGroup = chat.type && chat.type !== 'personal_chat';
        const rawMsgs = (chat.messages || []).filter(m => m.type === 'message');

        const msgs = rawMsgs.map(m => ({
            timestamp: m.date_unixtime ? new Date(Number(m.date_unixtime) * 1000) : new Date(m.date),
            sender: m.from || 'unknown',
            fromId: m.from_id,
            text: flattenTelegramText(m.text)
        })).filter(m => m.text && m.text.trim() && !isNaN(m.timestamp));

        if (!msgs.length) continue;

        if (isGroup) {
            const hasSelf = msgs.some(m => m.fromId === myId);
            if (!hasSelf) { skippedNoSelf++; continue; }
        }

        let kept = msgs;
        if (isGroup) kept = windowAroundSelf(msgs, m => m.fromId === myId, monthsPadding);

        const participants = [...new Set(msgs.map(m => m.sender))];
        for (const m of kept) {
            out.push({
                text: m.text.trim().substring(0, 2000),
                timestamp: m.timestamp,
                source: 'telegram',
                sender: m.sender,
                chatName: chat.name || 'Telegram chat',
                participants
            });
        }
    }
    console.log(`  Telegram: ${out.length} messages (${skippedNoSelf} group chats skipped — no self-participation)`);
    return out;
}

// ---------------------------------------------------------------------------
// Twitter — tweets.js + direct-messages.js (window.YTD.<name>.partN = [ ... ])
// ---------------------------------------------------------------------------

function readYTD(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        let s = fs.readFileSync(filePath, 'utf8');
        s = s.replace(/^\s*window\.YTD\.[^=]+=\s*/, ''); // strip JS assignment prefix
        return JSON.parse(s);
    } catch (e) {
        return [];
    }
}

function loadTwitter(dataDir) {
    const out = [];
    if (!dataDir || !fs.existsSync(dataDir)) return out;

    // Own tweets (exclude retweets — they aren't the user's words).
    const tweets = readYTD(path.join(dataDir, 'tweets.js'));
    let tweetCount = 0;
    for (const row of tweets) {
        const t = row.tweet || row;
        const text = t.full_text || t.text;
        if (!text || t.retweeted || /^RT @/.test(text)) continue;
        const ts = new Date(t.created_at);
        if (isNaN(ts.getTime())) continue;
        out.push({ text: text.substring(0, 2000), timestamp: ts, source: 'twitter', sender: 'kryptokommunist' });
        tweetCount++;
    }

    // Direct messages (1:1 or group the user is inherently a party to → keep all).
    const dms = readYTD(path.join(dataDir, 'direct-messages.js'));
    let dmCount = 0;
    for (const conv of dms) {
        const c = conv.dmConversation || conv;
        for (const mw of (c.messages || [])) {
            const m = mw.messageCreate;
            if (!m || !m.text) continue;
            const ts = new Date(m.createdAt || m.created_at);
            if (isNaN(ts.getTime())) continue;
            const mine = String(m.senderId) === ME.twitterAccountId;
            out.push({
                text: m.text.substring(0, 2000),
                timestamp: ts,
                source: 'twitter_dm',
                sender: mine ? 'me' : String(m.senderId),
                chatName: c.conversationId
            });
            dmCount++;
        }
    }
    console.log(`  Twitter: ${tweetCount} tweets + ${dmCount} DM messages`);
    return out;
}

// ---------------------------------------------------------------------------
// Obsidian "being" vault — the content NOT already covered by the existing
// Daily / livingfully / Therapy Sessions loaders.
// ---------------------------------------------------------------------------

const BEING_ALREADY_LOADED = new Set(['Daily', 'livingfully', 'Therapy Sessions']);
const BEING_EXCLUDE_DIRS = new Set(['.obsidian', '.claude', 'files']);
const BEING_EXCLUDE_FILES = new Set(['All_Notes_Merged.md', 'files.txt']);

function loadBeingVaultExtra(beingDir) {
    const out = [];
    if (!fs.existsSync(beingDir)) return out;

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (BEING_EXCLUDE_DIRS.has(entry.name)) continue;
                walk(full);
            } else if (entry.name.endsWith('.md')) {
                if (BEING_EXCLUDE_FILES.has(entry.name)) continue;
                if (/All_Notes_Merged/i.test(entry.name)) continue;
                const rec = parseMarkdownEntry(full, entry.name);
                if (rec) out.push(rec);
            }
        }
    };

    // Root-level .md files + the extra content subdirs (skip already-loaded ones).
    for (const entry of fs.readdirSync(beingDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
            if (BEING_ALREADY_LOADED.has(entry.name) || BEING_EXCLUDE_DIRS.has(entry.name)) continue;
            walk(path.join(beingDir, entry.name));
        } else if (entry.name.endsWith('.md')) {
            if (BEING_EXCLUDE_FILES.has(entry.name) || /All_Notes_Merged/i.test(entry.name)) continue;
            const rec = parseMarkdownEntry(path.join(beingDir, entry.name), entry.name);
            if (rec) out.push(rec);
        }
    }
    console.log(`  Being vault (extra): ${out.length} notes`);
    return out;
}

module.exports = {
    ME,
    windowAroundSelf,
    parseMarkdownEntry,
    loadWhatsApp,
    loadTelegram,
    loadTwitter,
    loadBeingVaultExtra
};
