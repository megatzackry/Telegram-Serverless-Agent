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

// Cheap line-multiset diff, enough to tell the owner how big a self-edit was.
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
