// Snake! Unlocked with the Konami code.
import { el } from './dom.js';
import { layer } from './ui/layers.js';
import { isApple, emojiUrl } from './emoji.js';

const N = 20; // grid cells per side
const HS_KEY = 'yapper_snake_best';

const loadImg = (src) => { const i = new Image(); i.src = src; return i; };

export function playSnake() {
  if (document.querySelector('.snake-wrap')) return;
  const root = el(`<div class="lightbox snake-wrap" role="dialog" aria-label="Snake">
    <div class="snake-box">
      <div class="snake-top"><b>🐍 Yapper Snake</b><span class="grow"></span><span>Score <b data-score>0</b></span><span>Best <b data-best>0</b></span>
        <button class="icon-btn" data-close aria-label="Close" style="color:#fff">✕</button></div>
      <canvas width="400" height="400"></canvas>
      <div class="snake-msg" data-msg></div>
      <div class="snake-help">Arrows / WASD or swipe to move · Space to pause · Esc to quit</div>
    </div></div>`);
  const entry = layer(root, { outsideClose: false, onClose: stop });
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const msg = root.querySelector('[data-msg]');
  const scoreEl = root.querySelector('[data-score]');
  const bestEl = root.querySelector('[data-best]');
  root.querySelector('[data-close]').onclick = () => entry.close();

  const bear = loadImg('/icons/logo.png');
  const apple = isApple ? null : loadImg(emojiUrl('🍎'));
  let best = 0;
  try { best = Number(localStorage.getItem(HS_KEY)) || 0; } catch { /* ignore */ }
  bestEl.textContent = best;

  let snake, dir, queue, food, score, timer, paused, over;

  function reset() {
    snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
    dir = { x: 1, y: 0 };
    queue = [];
    score = 0;
    paused = false;
    over = false;
    scoreEl.textContent = '0';
    placeFood();
    msg.textContent = '';
    schedule();
    draw();
  }

  function placeFood() {
    do { food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }; }
    while (snake.some((s) => s.x === food.x && s.y === food.y));
  }

  const speed = () => Math.max(55, 140 - score * 4);
  function schedule() { clearTimeout(timer); timer = setTimeout(tick, speed()); }

  function tick() {
    if (paused || over) return;
    const next = queue.shift();
    if (next) dir = next;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const hitWall = head.x < 0 || head.y < 0 || head.x >= N || head.y >= N;
    const ate = head.x === food.x && head.y === food.y;
    const body = ate ? snake : snake.slice(0, -1);
    if (hitWall || body.some((s) => s.x === head.x && s.y === head.y)) return gameOver();
    snake = [head, ...body];
    if (ate) {
      score++;
      scoreEl.textContent = score;
      if (score > best) { best = score; bestEl.textContent = best; try { localStorage.setItem(HS_KEY, String(best)); } catch { /* ignore */ } }
      if (snake.length === N * N) return gameOver(true);
      placeFood();
    }
    draw();
    schedule();
  }

  function gameOver(won = false) {
    over = true;
    clearTimeout(timer);
    draw();
    msg.innerHTML = `${won ? 'You win! 🏆' : 'Game over!'} Score: <b>${score}</b><br><button class="btn" data-again style="margin-top:10px">Play again</button>`;
    msg.querySelector('[data-again]').onclick = reset;
  }

  function draw() {
    const c = canvas.width / N;
    ctx.fillStyle = '#101715';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(160,255,215,0.04)';
    for (let y = 0; y < N; y++) for (let x = (y % 2); x < N; x += 2) ctx.fillRect(x * c, y * c, c, c);
    // Food
    if (apple?.complete && apple.naturalWidth) ctx.drawImage(apple, food.x * c + 1, food.y * c + 1, c - 2, c - 2);
    else { ctx.font = `${c - 4}px "Apple Color Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🍎', food.x * c + c / 2, food.y * c + c / 2 + 1); }
    // Body
    snake.forEach((s, i) => {
      if (i === 0) return;
      const t = i / snake.length;
      ctx.fillStyle = `hsl(157, 100%, ${41 - t * 14}%)`;
      ctx.beginPath();
      ctx.roundRect(s.x * c + 2, s.y * c + 2, c - 4, c - 4, 5);
      ctx.fill();
    });
    // Head = the Yapper bear
    const h = snake[0];
    if (bear.complete && bear.naturalWidth) ctx.drawImage(bear, h.x * c - 2, h.y * c - 2, c + 4, c + 4);
    else { ctx.fillStyle = '#00d087'; ctx.fillRect(h.x * c, h.y * c, c, c); }
    if (paused && !over) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 28px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Paused', canvas.width / 2, canvas.height / 2);
    }
  }

  function turn(x, y) {
    const last = queue[queue.length - 1] || dir;
    if ((x === -last.x && y === -last.y) || (x === last.x && y === last.y)) return;
    if (queue.length < 3) queue.push({ x, y });
  }

  const DIRS = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  function onKey(e) {
    if (e.key === 'Escape') return; // handled by the layer stack
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (DIRS[k]) { turn(...DIRS[k]); }
    else if (k === ' ' || k === 'p') { if (!over) { paused = !paused; if (!paused) schedule(); draw(); } }
    else if (k === 'r') reset();
    else return;
    // Keep keys from reaching the rest of the app while playing.
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  window.addEventListener('keydown', onKey, true);

  let touch = null;
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) { if (!over) { paused = !paused; if (!paused) schedule(); draw(); } return; }
    if (Math.abs(dx) > Math.abs(dy)) turn(Math.sign(dx), 0); else turn(0, Math.sign(dy));
  });

  function stop() {
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
  }

  bear.onload = draw;
  if (apple) apple.onload = draw;
  reset();
}
