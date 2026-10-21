// Safe markdown renderer for messages. Everything is escaped first; generated HTML
// is stashed behind placeholder tokens so later passes can't corrupt it.
import { esc, fmtStamp, fmtRelative, fmtFull, fmtDate, fmtTime } from './dom.js';
import { emojify, customEmojiHtml, emojiByCode, emojiHtml } from './emoji.js';
import { state, displayName, channelById, roleAttrs } from './store.js';

const TOK = '\u0001';

export function renderMarkdown(src, { serverId = null, jumbo = false, inline = false } = {}) {
  const stash = [];
  const put = (html) => `${TOK}${stash.push(html) - 1}${TOK}`;

  let s = String(src ?? '');

  // Code blocks.
  if (!inline) {
    s = s.replace(/```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g, (_, lang, code) =>
      put(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`));
  }
  // Inline code.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _b, code) => put(`<code>${esc(code)}</code>`));

  s = esc(s);

  // Mentions & references (escaped forms).
  s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => put(`<span class="mention" data-user="${id}">@${esc(displayName(Number(id), serverId))}</span>`));
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
    const role = serverId && state.servers.get(serverId)?.roles.find((r) => r.id === Number(id));
    if (!role) return put('<span class="mention">@deleted-role</span>');
    const style = role.color ? ` style="background:${role.color}22"` : '';
    return put(`<span class="mention role"${style}><span ${roleAttrs(role)}>@${esc(role.name)}</span></span>`);
  });
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
    const ch = channelById(Number(id));
    return put(`<span class="mention" data-channel="${id}">#${esc(ch?.name || 'unknown')}</span>`);
  });
  s = s.replace(/&lt;(a?):(\w{1,32}):(\d+)&gt;/g, (_, a, name, id) => put(customEmojiHtml({ id, name }, jumbo ? 'jumbo' : '')));
  s = s.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (_, ts, style) => {
    const ms = Number(ts) * 1000;
    const text = { t: fmtTime(ms), T: new Date(ms).toLocaleTimeString(), d: new Date(ms).toLocaleDateString(), D: fmtDate(ms), F: fmtFull(ms), R: fmtRelative(ms) }[style] || fmtStamp(ms);
    return put(`<span class="timestamp" title="${esc(fmtFull(ms))}">${esc(text)}</span>`);
  });
  s = s.replace(/(^|[^\w])@(everyone|here)\b/g, (_, pre, w) => `${pre}${put(`<span class="mention">@${w}</span>`)}`);

  // Masked links [text](https://...)
  s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) =>
    put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" title="${url}">${text}</a>`));
  // Autolinks (already escaped, so & is &amp;).
  s = s.replace(/&lt;(https?:\/\/[^\s<]+?)&gt;|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_~|])/g, (_, a, b) => {
    const url = a || b;
    return put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`);
  });

  // :shortcode: emoji typed by hand.
  s = s.replace(/:([a-z0-9_+-]{2,40}):/g, (m, code) => {
    const e = emojiByCode(code);
    return e ? put(emojiHtml(e.e, jumbo ? 'jumbo' : '')) : m;
  });

  // Inline formatting.
  const inlineFmt = (t) => t
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>')
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  let html;
  if (inline) html = inlineFmt(s).replace(/\n/g, ' ');
  else {
    // Block formatting per line.
    const lines = s.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = /^&gt;&gt;&gt; ?([\s\S]*)$/.exec(line))) {
        out.push(`<blockquote>${inlineFmt([m[1], ...lines.slice(i + 1)].join('\n'))}</blockquote>`);
        break;
      }
      if (/^&gt; /.test(line) || line === '&gt;') {
        const q = [];
        while (i < lines.length && (/^&gt; /.test(lines[i]) || lines[i] === '&gt;')) { q.push(lines[i].replace(/^&gt; ?/, '')); i++; }
        out.push(`<blockquote>${inlineFmt(q.join('\n'))}</blockquote>`);
        continue;
      }
      if ((m = /^(#{1,3}) (.+)$/.exec(line))) { out.push(`<h${m[1].length}>${inlineFmt(m[2])}</h${m[1].length}>`); i++; continue; }
      if ((m = /^-# (.+)$/.exec(line))) { out.push(`<div class="subtext">${inlineFmt(m[1])}</div>`); i++; continue; }
      if (/^\s*[-*] .+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*] .+/.test(lines[i])) { items.push(`<li>${inlineFmt(lines[i].replace(/^\s*[-*] /, ''))}</li>`); i++; }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }
      if (/^\s*\d{1,3}\. .+/.test(line)) {
        const start = parseInt(line, 10);
        const items = [];
        while (i < lines.length && /^\s*\d{1,3}\. .+/.test(lines[i])) { items.push(`<li>${inlineFmt(lines[i].replace(/^\s*\d{1,3}\. /, ''))}</li>`); i++; }
        out.push(`<ol start="${start}">${items.join('')}</ol>`);
        continue;
      }
      out.push(inlineFmt(line) + (i < lines.length - 1 ? '\n' : ''));
      i++;
    }
    html = out.join('').replace(/(<\/(?:blockquote|h\d|ul|ol|pre|div)>)\n/g, '$1');
  }

  html = emojify(html, jumbo ? 'jumbo' : '');
  // Restore stash (may be nested).
  const restore = (t) => t.replace(new RegExp(`${TOK}(\\d+)${TOK}`, 'g'), (_, n) => restore(stash[Number(n)]));
  return restore(html);
}

// Plain-text preview (for notifications, reply bars).
export function plainText(src, serverId) {
  return String(src || '')
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + displayName(Number(id), serverId))
    .replace(/<@&(\d+)>/g, (_, id) => '@' + (state.servers.get(serverId)?.roles.find((r) => r.id === Number(id))?.name || 'role'))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (channelById(Number(id))?.name || 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\|\|[\s\S]+?\|\|/g, '▒▒▒▒');
}
