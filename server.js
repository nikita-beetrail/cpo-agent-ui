const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKLOG_FILE = path.join(__dirname, 'backlog.json');

function readBacklog() {
  try {
    return JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeBacklog(items) {
  fs.writeFileSync(BACKLOG_FILE, JSON.stringify(items, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const KB_PATH = path.join(__dirname, 'knowledge_base.md');
function loadKB() {
  try { return fs.readFileSync(KB_PATH, 'utf8'); } catch (_) { return ''; }
}

const PROMPTS = {
  varvara: `Ты — Варвара, персональный CPO-советник Никиты, директора по продукту аутсорс-компании Beetrail.

КОНТЕКСТ — ПРОЕКТ «ВАРВАРА»:
Варвара — это AI-помощник CPO, который Никита строит сам. Стек: Vanilla HTML + Express + Claude CLI.
Цель: персональная база знаний CPO с веб-поиском и памятью.

О Beetrail (основная работа Никиты):
- Аутсорс мобильных приложений (FlutterFlow/Flutter)
- 3 клиента: один завершает (проблемы с публикацией в сторах), второй на активной разработке, третий на T&M
- Никита в роли CPO 1 год, уровень ~1.5/3, цель — Уровень 2 + $4k/мес допродажи

Принципы ответов:
- Прямо, без воды, с конкретным действием и сроком
- Риск называть ПЕРВЫМ
- Отвечать с позиции CPO СЕРВИСНОЙ компании

Формат: **[Прямой ответ]** → **Конкретные действия:** (с владельцем и сроком) → **Риск:**`,

  hvostiki: `Ты — Варвара, продуктовый советник Никиты по проекту «Хвостики».

КОНТЕКСТ — ПРОЕКТ «ХВОСТИКИ»:
Хвостики (Tail Diary) — мобильное приложение, дневник домашних питомцев.
- Собственный продукт команды Beetrail, не клиентский
- Бюджета нет — делается силами команды
- Команда: опытные аналитики + опытные дизайнеры
- Никита — пишет приложение сам через вайб-кодинг (Claude Code + Flutter/FlutterFlow)
- Лендинг готов: hvostiki.vercel.app
- Приложение в разработке

Принципы ответов:
- Никита — не опытный разработчик, поэтому технические советы давать максимально просто
- Бюджета нет → фокус на минимальных, но рабочих решениях
- Отвечать с позиции продакт-оунера собственного продукта, не аутсорса
- Приоритет: что сделать самому быстро и проверить гипотезу

Формат: **[Прямой ответ]** → **Конкретные действия:** (с владельцем и сроком) → **Риск:**`,
};

const CLAUDE_PATH = '/usr/local/bin/claude';

function buildEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.HOME = env.HOME || '/Users/nikita';
  env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return env;
}

console.log(`[${new Date().toISOString()}] Варвара стартует на порту 3737`);

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ─── БЭКЛОГ ───────────────────────────────────────────────
app.get('/api/backlog', (req, res) => {
  res.json(readBacklog());
});

app.post('/api/backlog', (req, res) => {
  const { text, tag } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const items = readBacklog();
  const item = {
    id: Date.now().toString(),
    text: text.trim(),
    tag: tag || '',
    done: false,
    createdAt: new Date().toISOString(),
  };
  items.unshift(item);
  writeBacklog(items);
  res.json(item);
});

app.patch('/api/backlog/:id', (req, res) => {
  const items = readBacklog();
  const item = items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (req.body.done !== undefined) item.done = req.body.done;
  if (req.body.text !== undefined) item.text = req.body.text;
  if (req.body.tag !== undefined) item.tag = req.body.tag;
  writeBacklog(items);
  res.json(item);
});

app.delete('/api/backlog/:id', (req, res) => {
  const items = readBacklog();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  items.splice(idx, 1);
  writeBacklog(items);
  res.json({ ok: true });
});

app.post('/api/chat', (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  console.log(`[${new Date().toISOString()}] Запрос: "${message.slice(0, 60)}"`);

  const conversationContext = (history || [])
    .map(m => `${m.role === 'user' ? 'Никита' : 'Варвара'}: ${m.content}`)
    .join('\n');

  const fullPrompt = conversationContext
    ? `${conversationContext}\nНикита: ${message}`
    : message;

  // SSE — браузер не отвалится
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Heartbeat каждые 3 секунды пока Claude думает
  let elapsed = 0;
  const heartbeat = setInterval(() => {
    elapsed += 3;
    res.write(`data: ${JSON.stringify({ thinking: elapsed })}\n\n`);
  }, 3000);

  const project = req.body.project || 'varvara';
  const base = PROMPTS[project] || PROMPTS.varvara;
  const kb = project === 'varvara' ? '\n\n---\n\n' + loadKB() : '';
  const systemPrompt = base + kb;
  const args = ['--print', '--system-prompt', systemPrompt, fullPrompt];
  const start = Date.now();

  execFile(CLAUDE_PATH, args, { maxBuffer: 10 * 1024 * 1024, env: buildEnv(), timeout: 120000 }, (err, stdout, stderr) => {
    clearInterval(heartbeat);
    const sec = ((Date.now() - start) / 1000).toFixed(1);

    if (err) {
      console.error(`[ERROR ${sec}s] ${err.message}`);
      res.write(`data: ${JSON.stringify({ error: stderr || err.message })}\n\n`);
    } else {
      console.log(`[OK ${sec}s] ${stdout.length} символов`);
      res.write(`data: ${JSON.stringify({ text: stdout.trim() })}\n\n`);
    }
    res.end();
  });

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Варвара запущена на http://localhost:${PORT}`);
});
