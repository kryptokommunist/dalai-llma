#!/usr/bin/env python3
"""
Preprocess large/binary data sources into lightweight JSON for process_data.js.
Run this before running process_data.js when new data is available.

Generates:
  data/gemini_prompts.json
  data/google_searches.json
  data/sent_emails.json
"""

import re
import json
import mailbox
import email.header
import email.utils
import os
import sys
from html import unescape
from datetime import datetime

DATA_DIR = os.environ.get('DATA_DIR', './data')
LLM_DIR = os.path.join(DATA_DIR, 'LLM Data')

# Central-European zone abbreviations that strptime's %Z handles inconsistently:
# on some hosts %Z silently drops the entry (ValueError), on others it parses but
# ignores the offset — either way the result is host-dependent. The rest of the
# pipeline is zone-naive (Search timestamps carry no zone at all), so we normalize
# every Gemini timestamp the same way: strip the trailing zone token and parse the
# remainder as a naive local datetime. This keeps entries that %Z would drop and
# makes the result identical across hosts.
_KNOWN_ZONES = {
    'CET', 'CEST', 'GMT', 'UTC', 'BST', 'EST', 'EDT', 'PST', 'PDT',
    'MST', 'MDT', 'CST', 'CDT', 'IST', 'JST', 'AEST', 'AEDT',
}

def parse_dt_with_zone(date_str, fmt):
    """Parse a Gemini-activity datetime whose trailing token is a zone
    abbreviation. Strip a recognized zone and parse naive so results are
    host-independent; fall back to a plain %Z parse otherwise."""
    parts = date_str.rsplit(' ', 1)
    if len(parts) == 2 and parts[1].strip().upper() in _KNOWN_ZONES:
        head = parts[0].strip()
        base_fmt = fmt.replace(' %Z', '').strip()
        return datetime.strptime(head, base_fmt)
    return datetime.strptime(date_str, fmt)

def save(data, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"  Saved {len(data)} items to {path}")


# ── Gemini ────────────────────────────────────────────────────────────────────

def preprocess_gemini():
    html_path = os.path.join(LLM_DIR, 'Google', 'Takeout', 'My Activity', 'Gemini Apps', 'MyActivity.html')
    if not os.path.exists(html_path):
        print(f"  Gemini HTML not found: {html_path}")
        return

    print("Parsing Gemini activity (streaming)...")
    items = []
    seen = set()
    chunk_size = 100_000
    overlap = 5_000

    # content-cell > Prompted\xa0<text><br>Date
    pattern = re.compile(
        r'content-cell[^>]+>Prompted\xa0(.*?)<br>\s*'
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
        r'\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}'
        r'[\s ](?:AM|PM)\s+\w+)',
        re.DOTALL
    )

    with open(html_path, errors='replace') as f:
        buf = ''
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            buf = buf[-overlap:] + chunk
            for m in pattern.finditer(buf):
                raw = unescape(m.group(1))
                text = re.sub(r'<[^>]+>', ' ', raw).replace('\xa0', ' ').strip()
                date_str = m.group(2).replace(' ', ' ').strip()
                try:
                    date = parse_dt_with_zone(date_str, '%b %d, %Y, %I:%M:%S %p %Z')
                    # Full-timestamp + 120-char prefix: two distinct long prompts
                    # at the same second no longer collapse on a 50-char prefix.
                    key = (date.isoformat(), text[:120])
                    if key not in seen and len(text) > 10:
                        seen.add(key)
                        items.append({'text': text[:800], 'timestamp': date.isoformat(), 'source': 'gemini'})
                except Exception:
                    pass

    print(f"  Found {len(items)} unique Gemini prompts")
    save(items, os.path.join(DATA_DIR, 'gemini_prompts.json'))


# ── Google Search ─────────────────────────────────────────────────────────────

def preprocess_search():
    html_path = os.path.join(LLM_DIR, 'Google', 'Takeout', 'My Activity', 'Search', 'MyActivity.html')
    if not os.path.exists(html_path):
        print(f"  Search HTML not found: {html_path}")
        return

    print("Parsing Google Search activity (streaming)...")
    items = []
    seen = set()
    chunk_size = 100_000
    overlap = 3_000

    # Two patterns — with and without anchor tag
    patterns = [
        re.compile(
            r'Searched for\s+<a[^>]+>([^<]+)</a>\s*<br>\s*'
            r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4})',
            re.DOTALL
        ),
        re.compile(
            r'Searched for\s+([^\n<]{3,200})\s*<br>\s*'
            r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4})',
            re.DOTALL
        ),
    ]

    with open(html_path, errors='replace') as f:
        buf = ''
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            buf = buf[-overlap:] + chunk
            for pat in patterns:
                for m in pat.finditer(buf):
                    query = unescape(m.group(1)).strip()
                    date_str = m.group(2).strip()
                    try:
                        date = datetime.strptime(date_str, '%b %d, %Y')
                        key = (date.isoformat(), query)
                        if key not in seen and len(query) > 2:
                            seen.add(key)
                            items.append({'text': query, 'timestamp': date.isoformat(), 'source': 'google_search'})
                    except Exception:
                        pass

    print(f"  Found {len(items)} unique searches")
    save(items, os.path.join(DATA_DIR, 'google_searches.json'))


# ── Sent Emails ───────────────────────────────────────────────────────────────

def decode_header_str(h):
    if not h:
        return ''
    try:
        parts = email.header.decode_header(h)
        result = ''
        for part, enc in parts:
            if isinstance(part, bytes):
                result += part.decode(enc or 'utf-8', errors='replace')
            else:
                result += str(part)
        return result.replace('\n', ' ').replace('\t', ' ').strip()
    except Exception:
        return str(h)

def html_to_text(html):
    """Crude HTML→text: drop script/style, convert <br>/<p> to newlines, strip
    remaining tags, unescape entities. Used only as a fallback when an email has
    no text/plain part (HTML-only messages otherwise yield an empty body)."""
    html = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', html)
    html = re.sub(r'(?i)<br\s*/?>', '\n', html)
    html = re.sub(r'(?i)</p\s*>', '\n', html)
    text = re.sub(r'<[^>]+>', ' ', html)
    return unescape(text)

# Reply/forward header lines leak the recipient and quoted-conversation metadata
# into the body (and thus into sentiment/word-freq). Strip them.
_REPLY_HEADER_RE = re.compile(
    r'(?im)^\s*(?:'
    r'On .{0,120}\bwrote:\s*|'                       # "On <date>, <name> wrote:"
    r'Am .{0,120}\bschrieb\b.{0,80}:\s*|'            # German "Am <date> schrieb <name>:"
    r'-{2,}\s*Forwarded message\s*-{2,}.*|'          # forwarded banner
    r'-{2,}\s*Original Message\s*-{2,}.*|'
    r'(?:From|To|Sent|Subject|Cc|Date|Von|An|Betreff|Gesendet)\s*:.*'  # quoted hdr lines
    r')$'
)

def clean_body(body):
    # Remove quoted (">") lines and leaked reply/forward header lines.
    lines = []
    for l in body.split('\n'):
        if l.strip().startswith('>'):
            continue
        if _REPLY_HEADER_RE.match(l):
            continue
        lines.append(l)
    # Collapse runs of blank lines.
    text = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines))
    return text[:600].strip()

def get_plain_text(msg):
    plain = ''
    html = ''
    try:
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                if ctype not in ('text/plain', 'text/html'):
                    continue
                try:
                    payload = part.get_payload(decode=True)
                    if payload is None:
                        continue
                    charset = part.get_content_charset() or 'utf-8'
                    decoded = payload.decode(charset, errors='replace')
                except Exception:
                    continue
                if ctype == 'text/plain' and not plain:
                    plain = decoded
                elif ctype == 'text/html' and not html:
                    html = decoded
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or 'utf-8'
                decoded = payload.decode(charset, errors='replace')
                if msg.get_content_type() == 'text/html':
                    html = decoded
                else:
                    plain = decoded
    except Exception:
        pass
    # Prefer plain text; fall back to HTML-derived text for HTML-only emails.
    body = plain if plain.strip() else html_to_text(html)
    return clean_body(body)

def preprocess_emails():
    mbox_path = os.path.join(LLM_DIR, 'Sent Items.partial.mbox', 'mbox')
    if not os.path.exists(mbox_path):
        print(f"  mbox not found: {mbox_path}")
        return

    print(f"Parsing sent emails (mailbox)...")
    mbox = mailbox.mbox(mbox_path)
    items = []
    for i, msg in enumerate(mbox):
        if i % 200 == 0:
            print(f"  Processing email {i}...", flush=True)
        try:
            date_str = msg.get('Date', '')
            try:
                date = email.utils.parsedate_to_datetime(date_str)
            except Exception:
                continue
            subject = decode_header_str(msg.get('Subject', ''))
            to = decode_header_str(msg.get('To', ''))
            body = get_plain_text(msg)
            if not body and not subject:
                continue
            text = f"Email to {to}: {subject}. {body}"
            items.append({
                'text': text[:800],
                'timestamp': date.isoformat(),
                'source': 'email_sent',
                'subject': subject,
                'to': to
            })
        except Exception:
            pass

    print(f"  Parsed {len(items)} emails")
    save(items, os.path.join(DATA_DIR, 'sent_emails.json'))


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    print(f"Working dir: {os.getcwd()}")
    preprocess_gemini()
    preprocess_search()
    preprocess_emails()
    print("\nDone! Now run: node scripts/process_data.js")
