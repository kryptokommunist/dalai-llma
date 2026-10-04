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
// Loaded from gitignored data/me.json or environment variables; safe generic fallbacks for public repo.
function loadMeConfig() {
    const meFile = path.join(process.env.DATA_DIR || './data', 'me.json');
    if (fs.existsSync(meFile)) {
        try {
            return JSON.parse(fs.readFileSync(meFile, 'utf8'));
        } catch (e) {
            console.warn('Warning: Could not parse data/me.json:', e.message);
        }
    }
    return {
        names: (process.env.ME_NAMES || 'me,myself,you').split(',').map(s => s.trim().toLowerCase()),
        phones: (process.env.ME_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),
        telegramUserId: process.env.TELEGRAM_USER_ID || '',
        twitterAccountId: process.env.TWITTER_ACCOUNT_ID || ''
    };
}
const ME = loadMeConfig();

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
    if (ME.names.includes(n) || ME.phones.some(p => n.includes(p))) return true;
    // Exports often decorate the display name with emoji/trailing tokens, e.g.
    // "Marcus 🥰👋🏻" — strip to word tokens and match a configured name as the
    // leading token so "marcus ..." still resolves to self. (Exact-match-only
    // previously dropped 29 self WhatsApp messages under the decorated name.)
    const tokens = n.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (tokens.length && ME.names.includes(tokens[0])) return true;
    return false;
};

/**
 * Parse a single Obsidian/markdown file into a neutral journal record, or null
 * if too short / undatable. Strips YAML frontmatter and wikilinks; dates from
 * `YYYY-MM-DD` in the filename, else file mtime.
 */
function parseMarkdownEntry(filePath, fileName) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');

        // Capture frontmatter (if any) before stripping, to recover a date.
        // Tolerate a closing `---` at EOF or without a trailing newline — many
        // Obsidian notes have only frontmatter + a short body with no newline
        // after the delimiter, which a strict `---\n` would miss.
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
        const frontmatter = fmMatch ? fmMatch[1] : '';

        content = content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, ''); // frontmatter
        content = content.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1'); // wikilinks
        const trimmed = content.trim();
        if (trimmed.length < 20) return null;

        let ts = null;
        const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
        const dmyMatch = fileName.match(/(\d{2})\.(\d{2})\.(\d{4})/); // DD.MM.YYYY (Therapy Sessions)
        if (dateMatch) {
            ts = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
        } else if (dmyMatch) {
            ts = new Date(`${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`);
        } else {
            // Fall back to a date in frontmatter (`created:`/`date:`), NOT file mtime
            // (mtime clusters everything at copy time and pollutes the time-series).
            const fmDate = frontmatter.match(/^(?:created|date)\s*:\s*(\d{4})-(\d{2})-(\d{2})/im);
            if (fmDate) ts = new Date(`${fmDate[1]}-${fmDate[2]}-${fmDate[3]}`);
        }
        // Undatable notes are excluded from the time-series rather than mis-dated.
        if (!ts || isNaN(ts.getTime())) return null;

        return { text: trimmed.substring(0, 2000), timestamp: ts, source: 'journal', isMine: true };
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// WhatsApp — directory of per-chat zips, each with chat.txt
// iOS format:  [M/D/YY, H:MM:SS AM] Sender: body     (self sender == "You")
// ---------------------------------------------------------------------------

function parseWhatsAppDate(dateStr, timeStr) {
    // dateStr like "4/13/25" (US iOS), "13/4/25" (DD/MM), or "13.04.25" (German dotted).
    // timeStr like "5:46:12 PM" or "17:46:12".
    let a, b, yr;
    const slash = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    const dot = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    let germanOrder = false;
    if (dot) {
        // German dotted dates are DD.MM.YY.
        [, a, b, yr] = dot; germanOrder = true;
    } else if (slash) {
        [, a, b, yr] = slash;
    } else {
        return null;
    }
    if (yr.length === 2) yr = '20' + yr;
    let mo, da;
    const n1 = Number(a), n2 = Number(b);
    if (germanOrder) {
        da = n1; mo = n2;                       // DD.MM
    } else if (n1 > 12 && n2 <= 12) {
        da = n1; mo = n2;                       // unambiguous DD/MM
    } else if (n2 > 12 && n1 <= 12) {
        mo = n1; da = n2;                       // unambiguous MM/DD (US default)
    } else {
        mo = n1; da = n2;                       // ambiguous → assume US MM/DD (export locale)
    }
    let hh = 0, mm = 0;
    const tm = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
    if (tm) {
        hh = parseInt(tm[1], 10); mm = parseInt(tm[2], 10);
        const mer = (tm[4] || '').toLowerCase();
        if (mer === 'pm' && hh < 12) hh += 12;
        if (mer === 'am' && hh === 12) hh = 0;
    }
    const d = new Date(Number(yr), mo - 1, da, hh, mm);
    return isNaN(d.getTime()) ? null : d;
}

function loadWhatsApp(whatsappDir, { monthsPadding = MONTH_PAD_DEFAULT } = {}) {
    const out = [];
    if (!fs.existsSync(whatsappDir)) return out;
    const zips = fs.readdirSync(whatsappDir).filter(f => f.toLowerCase().endsWith('.zip'));
    let skippedNoSelf = 0, groupsWindowed = 0;

    const lineRe = /^\[(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+([^\]]+)\]\s+([^:]+):\s?([\s\S]*)$/;

    for (const zip of zips) {
        const tmp = fs.mkdtempSync('/tmp/wa_');
        try {
            execSync(`unzip -q -o "${path.join(whatsappDir, zip)}" -d "${tmp}" 2>/dev/null || true`);
            const txtPath = path.join(tmp, 'chat.txt');
            if (!fs.existsSync(txtPath)) continue;
            const raw = fs.readFileSync(txtPath, 'utf8');

            // Parse into messages, joining multi-line bodies onto the previous msg.
            const msgs = [];
            // Dated system lines like "[9/11/25, 9:37:21 PM] - [Call]" and the
            // "Messages and calls are end-to-end encrypted…" header have no
            // "Sender:" so they don't match lineRe; without this guard they'd be
            // appended verbatim into the previous real message, injecting
            // timestamps/[Call] noise into its text.
            const sysLineRe = /^\[\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+[^\]]+\]\s*-?\s*/;
            const encNoticeRe = /end-to-end encrypted/i;
            for (const line of raw.split('\n')) {
                const m = line.match(lineRe);
                if (m) {
                    const ts = parseWhatsAppDate(m[1], m[2]);
                    msgs.push({ timestamp: ts, sender: m[3].trim(), text: m[4] });
                } else if (msgs.length && line.trim()) {
                    // Only join genuine continuation lines; drop dated system lines
                    // and the encryption notice.
                    if (sysLineRe.test(line) || encNoticeRe.test(line)) continue;
                    msgs[msgs.length - 1].text += '\n' + line;
                }
            }
            if (!msgs.length) continue;

            const senders = new Set(msgs.map(m => m.sender));
            const isGroup = senders.size > 2;
            const hasSelf = msgs.some(m => nameIsMine(m.sender));
            if (isGroup && !hasSelf) { skippedNoSelf++; continue; }
            if (!isGroup && !hasSelf) {
                console.warn(`  WhatsApp: 1:1 chat "${zip.replace(/\.zip$/i, '')}" has no self-sender match (check ME.names) — its messages will all be dropped as non-self`);
            }

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
                    isMine: nameIsMine(m.sender),
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

    const selfUserId = data.personal_information?.user_id || ME.telegramUserId;
    if (!selfUserId) {
        console.warn('  Telegram: no self user id (personal_information.user_id or ME.telegramUserId empty) — no messages can be attributed to self; all marked isMine:false');
    }
    // Telegram exports store from_id either as a bare numeric id (e.g. 27397086)
    // or prefixed ("user27397086"), depending on export version. Match BOTH by
    // normalizing: strip a leading "user" and compare the digits. The old code
    // only built the prefixed form and compared with ===, which matched 0 of the
    // self messages in bare-id exports → every message mislabeled isMine:false.
    const selfIdDigits = selfUserId ? String(selfUserId).replace(/^user/i, '') : null;
    const isSelfFromId = (fromId) =>
        selfIdDigits !== null && fromId != null &&
        String(fromId).replace(/^user/i, '') === selfIdDigits;
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
            const hasSelf = msgs.some(m => isSelfFromId(m.fromId));
            if (!hasSelf) { skippedNoSelf++; continue; }
        }

        let kept = msgs;
        if (isGroup) kept = windowAroundSelf(msgs, m => isSelfFromId(m.fromId), monthsPadding);

        const participants = [...new Set(msgs.map(m => m.sender))];
        for (const m of kept) {
            out.push({
                text: m.text.trim().substring(0, 2000),
                timestamp: m.timestamp,
                source: 'telegram',
                sender: m.sender,
                isMine: isSelfFromId(m.fromId),
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
        out.push({ text: text.substring(0, 2000), timestamp: ts, source: 'twitter', sender: 'kryptokommunist', isMine: true });
        tweetCount++;
    }

    // Direct messages (1:1 or group the user is inherently a party to → keep all).
    // Twitter exports split these across direct-messages.js (1:1) and
    // direct-messages-group.js (group DMs); load both so group-DM content isn't lost.
    const dmFiles = ['direct-messages.js', 'direct-messages-group.js'];
    const dms = dmFiles.flatMap(f => readYTD(path.join(dataDir, f)));
    if (dms.length && !ME.twitterAccountId) {
        console.warn('  Twitter: ME.twitterAccountId is empty — cannot tell which DM messages are self; all DMs marked isMine:false');
    }
    let dmCount = 0;
    for (const conv of dms) {
        const c = conv.dmConversation || conv;
        for (const mw of (c.messages || [])) {
            const m = mw.messageCreate;
            if (!m || !m.text) continue;
            const ts = new Date(m.createdAt || m.created_at);
            if (isNaN(ts.getTime())) continue;
            const mine = Boolean(ME.twitterAccountId) && String(m.senderId) === ME.twitterAccountId;
            out.push({
                text: m.text.substring(0, 2000),
                timestamp: ts,
                source: 'twitter_dm',
                sender: mine ? 'me' : String(m.senderId),
                isMine: mine,
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
