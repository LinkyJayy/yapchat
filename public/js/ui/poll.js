// Poll composer.
import { $, esc, errToast } from '../dom.js';
import { icon } from '../icons.js';
import { modal } from './layers.js';
import { openPicker } from './picker.js';
import { emojiHtml, customEmojiHtml } from '../emoji.js';
import { upload } from '../api.js';

const DURATIONS = [[1, '1 hour'], [4, '4 hours'], [8, '8 hours'], [24, '24 hours'], [72, '3 days'], [168, '1 week'], [336, '2 weeks']];

export function openPollComposer(ch) {
  const answers = [{ text: '', emoji: null }, { text: '', emoji: null }];
  const m = modal({
    title: 'Create a Poll',
    body: `<div class="field"><label>Question</label><input class="input" data-q maxlength="300" placeholder="What question do you want to ask?"></div>
      <div class="field"><label>Answers</label><div data-answers></div>
        <button class="btn secondary small" data-addans type="button" style="align-self:flex-start">${icon('plus')} Add another answer</button></div>
      <div class="row wrap">
        <div class="field grow" style="margin:0"><label>Duration</label><select class="input" data-dur>${DURATIONS.map(([h, l]) => `<option value="${h}" ${h === 24 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <label class="row" style="margin-top:22px"><span class="switch"><input type="checkbox" data-multi><span></span></span> Allow multiple answers</label>
      </div>`,
    buttons: [
      { label: 'Cancel', cls: 'ghost' },
      {
        label: 'Post', action: async () => {
          const question = $('[data-q]', m.body).value.trim();
          const opts = answers.map((a) => ({ text: a.text.trim(), emoji: a.emoji })).filter((a) => a.text);
          if (!question) { errToast(new Error('Add a question.')); return false; }
          if (opts.length < 2) { errToast(new Error('Add at least 2 answers.')); return false; }
          const form = new FormData();
          form.append('poll', JSON.stringify({ question, options: opts, duration: Number($('[data-dur]', m.body).value), multi: $('[data-multi]', m.body).checked }));
          try { await upload(`/channels/${ch.id}/messages`, form); } catch (e) { errToast(e); return false; }
        },
      },
    ],
  });
  const list = $('[data-answers]', m.body);
  const draw = () => {
    list.innerHTML = answers.map((a, i) => `<div class="row" style="margin-bottom:8px">
      <button type="button" class="icon-btn" data-emo="${i}" title="Add emoji" style="width:40px;height:40px;background:var(--bg-input)">${a.emoji ? (a.emoji.startsWith('c:') ? customEmojiHtml({ id: a.emoji.slice(2), name: '' }) : emojiHtml(a.emoji)) : icon('smile')}</button>
      <input class="input grow" data-ans="${i}" maxlength="55" placeholder="Type your answer" value="${esc(a.text)}">
      ${answers.length > 2 ? `<button type="button" class="icon-btn danger" data-del="${i}" title="Remove">${icon('trash')}</button>` : ''}</div>`).join('');
    $('[data-addans]', m.body).hidden = answers.length >= 10;
  };
  draw();
  list.addEventListener('input', (e) => { const i = e.target.dataset.ans; if (i != null) answers[Number(i)].text = e.target.value; });
  list.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { answers.splice(Number(d.dataset.del), 1); return draw(); }
    const em = e.target.closest('[data-emo]');
    if (em) openPicker(em, (p) => { answers[Number(em.dataset.emo)].emoji = p.type === 'custom' ? `c:${p.emoji.id}` : p.value; draw(); }, { serverId: ch.server_id });
  });
  $('[data-addans]', m.body).onclick = () => { answers.push({ text: '', emoji: null }); draw(); list.querySelector(`[data-ans="${answers.length - 1}"]`)?.focus(); };
}
