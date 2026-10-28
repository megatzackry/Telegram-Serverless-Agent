// Pure helpers: timing, retry, text/HTML conversion, base64. Must not import errors.js (it imports this).

// Promise wrapper around setTimeout. setTimeout is undocumented in the isolate, so fall back to no delay.
export const sleep = (ms) => new Promise((resolve) => {
  if (typeof setTimeout === 'function') setTimeout(resolve, ms);
  else resolve();
});

export const toJson = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return '[unserializable]'; }
};

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Models sometimes wrap file output in ``` fences despite being told not to.
export const stripCodeFence = (text) => {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
};

// Exponential backoff with jitter that never plans past the invocation deadline.
export class Backoff {
  constructor({ maxAttempts, baseDelayMs, maxDelayMs, deadlineMs }, startedAt = Date.now()) {
    Object.assign(this, { maxAttempts, baseDelayMs, maxDelayMs, deadlineMs, startedAt });
  }

  // Delay in ms before the next attempt, or null when retrying should stop.
  nextDelay(attempt, hintMs = 0) {
    if (attempt >= this.maxAttempts) return null;
    const base = Math.min(this.maxDelayMs, Math.max(hintMs, this.baseDelayMs * 2 ** (attempt - 1)));
    const delay = base + Math.random() * this.baseDelayMs * 0.25;
    return Date.now() - this.startedAt + delay < this.deadlineMs ? delay : null;
  }
}

// shouldRetry(err) returns false to give up, otherwise a delay hint in ms (0 for none).
export async function withRetry(task, { policy, startedAt = Date.now(), shouldRetry }) {
  const backoff = new Backoff(policy, startedAt);
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      const hint = shouldRetry(err);
      const delay = hint === false ? null : backoff.nextDelay(attempt, hint);
      if (delay === null) throw err;
      await sleep(delay);
    }
  }
}

// Rich message / rich html to plain text, so past replies can be fed back as ordinary history.
export class RichText {
  static stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // RichText node (string | array | object with text/expression) to plain text.
  static plain(node) {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(RichText.plain).join('');
    if (node.text !== undefined) return RichText.plain(node.text);
    return node.expression ?? '';
  }

  // RichBlock (or array of blocks) to plain text, following the documented block types.
  static blocks(block) {
    if (block == null) return '';
    if (Array.isArray(block)) return block.map(RichText.blocks).filter(Boolean).join('\n');
    switch (block.type) {
      case 'list':
        return (block.items || [])
          .map((item) => `${item.label ?? '-'} ${RichText.blocks(item.blocks).replace(/\n/g, ' ')}`)
          .join('\n');
      case 'table':
        return (block.cells || []).map((row) => row.map((c) => RichText.plain(c.text)).join(' | ')).join('\n');
      case 'details':
        return `${RichText.plain(block.summary)}: ${RichText.blocks(block.blocks)}`;
      default:
        if (block.text !== undefined) return RichText.plain(block.text);
        if (block.blocks) return RichText.blocks(block.blocks);
        return block.expression ?? '';
    }
  }

  static fromMessage(richMessage) {
    if (!richMessage || !Array.isArray(richMessage.blocks)) return null;
    return RichText.blocks(richMessage.blocks).trim() || null;
  }
}

// The isolate has no Buffer, so UTF-8 and base64 are done by hand (GitHub's contents API speaks base64).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export class Base64 {
  static encodeUtf8(text) { return Base64.encode(Base64.utf8Bytes(text)); }
  static decodeUtf8(b64) { return Base64.utf8String(Base64.decode(b64)); }

  static utf8Bytes(text) {
    const out = [];
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  static utf8String(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i++];
      let cp;
      if (b < 0x80) cp = b;
      else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
    return out;
  }

  static encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
        + (b === undefined ? '=' : B64[(n >> 6) & 63])
        + (c === undefined ? '=' : B64[n & 63]);
    }
    return out;
  }

  static decode(b64) {
    const bytes = [];
    let buffer = 0, bits = 0;
    for (const ch of b64.replace(/[^A-Za-z0-9+/]/g, '')) {
      buffer = (buffer << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 255);
        buffer &= (1 << bits) - 1;
      }
    }
    return bytes;
  }
}

// Cheap line-multiset diff, enough to tell the user how big a self-edit was.
export class LineDiff {
  static summarize(before, after) {
    const remaining = new Map();
    for (const line of before.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of after.split('\n')) {
      const n = remaining.get(line) ?? 0;
      if (n > 0) remaining.set(line, n - 1);
      else added++;
    }
    let removed = 0;
    for (const n of remaining.values()) removed += n;
    return { added, removed };
  }
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

// Pulls one string field out of a JSON document that is still being generated, decoding escapes as far
// as the text has arrived. Used to read the "html" field of the model's structured answer mid-stream.
const JSON_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

export class JsonStringField {
  constructor(key) { this.pattern = new RegExp(`"${key}"\\s*:\\s*"`); }

  extract(buffer) {
    const start = this.pattern.exec(buffer);
    if (!start) return { value: '', closed: false };
    let out = '';
    let i = start.index + start[0].length;
    while (i < buffer.length) {
      const ch = buffer[i];
      if (ch === '"') return { value: out, closed: true };
      if (ch !== '\\') { out += ch; i++; continue; }
      const next = buffer[i + 1];
      if (next === undefined) break; // lone backslash at the end: wait for more text
      if (next === 'u') {
        const hex = buffer.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += JSON_ESCAPES[next] ?? next;
      i += 2;
    }
    return { value: out, closed: false };
  }
}

// Server-sent events: feed it text as it arrives, get back the JSON payloads of any complete events.
export class SseParser {
  constructor() { this.buffer = ''; }

  feed(text) {
    this.buffer = (this.buffer + text).replace(/\r\n/g, '\n');
    const events = [];
    let end;
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch { /* ignore a malformed event */ }
    }
    return events;
  }

  // The stream can end without a trailing blank line.
  flush() { return this.feed('\n\n'); }
}

// Body chunks may arrive as strings or as bytes (and bytes can split a multi-byte character).
export class ChunkDecoder {
  constructor() {
    this.native = typeof TextDecoder === 'function' ? new TextDecoder() : null;
    this.carry = [];
  }

  decode(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (this.native) return this.native.decode(chunk, { stream: true });
    const bytes = this.carry.concat(Array.from(chunk));
    const cut = ChunkDecoder.completeLength(bytes);
    this.carry = bytes.slice(cut);
    return Base64.utf8String(bytes.slice(0, cut));
  }

  // Length of the prefix that does not end in the middle of a UTF-8 sequence.
  static completeLength(bytes) {
    for (let back = 1; back <= Math.min(3, bytes.length); back++) {
      const b = bytes[bytes.length - back];
      if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return need > back ? bytes.length - back : bytes.length;
    }
    return bytes.length;
  }
}

// Makes half-written rich html safe to preview: drops a half-typed tag, closes whatever is still open.
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'tg-map', 'source']);

export class HtmlBalancer {
  static balance(html) {
    const lastOpen = html.lastIndexOf('<');
    const text = lastOpen > html.lastIndexOf('>') ? html.slice(0, lastOpen) : html;
    const stack = [];
    for (const m of text.matchAll(/<(\/)?([a-zA-Z][\w-]*)([^>]*?)(\/)?>/g)) {
      const [, closing, name, , selfClosing] = m;
      const tag = name.toLowerCase();
      if (selfClosing || VOID_TAGS.has(tag)) continue;
      if (closing) {
        const at = stack.lastIndexOf(tag);
        if (at !== -1) stack.length = at;
      } else {
        stack.push(tag);
      }
    }
    return text + stack.reverse().map((t) => `</${t}>`).join('');
  }
}
