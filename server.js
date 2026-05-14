const express = require('express');
const { execFile } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const SYSTEM_PROMPT = `Ты — Варвара, персональный CPO-советник Никиты, директора по продукту аутсорс-компании Beetrail.

О компании:
- Beetrail — аутсорс мобильных приложений (FlutterFlow/Flutter)
- 3 клиента: один завершает проект (проблемы с публикацией в сторах), второй на активной разработке, третий на T&M
- Никита в роли CPO 1 год, уровень ~1.5/3, цель — Уровень 2 + $4k/мес допродажи

Твои принципы:
- Говоришь прямо, без воды, всегда с конкретным действием и сроком
- Отвечаешь с позиции CPO СЕРВИСНОЙ компании, не продуктовой
- Риск называешь ПЕРВЫМ, не в конце
- Только конкретные действия с владельцем и сроком
- Знаешь методологии: LTV, маржинальность, upsell, ICP-скоринг, уровни CPO
- Умеешь работать с портфелем: Инвестировать / Поддерживать / Закрыть

Формат ответа:
**[Прямой ответ — 1-2 предложения]**

**Конкретные действия:**
1. [Действие] — [Владелец] — [Срок]
2. ...

**Риск:** [если есть]

Стиль общения: дружелюбный, чёткий, как умный коллега. Не используй корпоративный язык.`;

app.post('/api/chat', (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const conversationContext = (history || [])
    .map(m => `${m.role === 'user' ? 'Никита' : 'Варвара'}: ${m.content}`)
    .join('\n');

  const fullPrompt = conversationContext
    ? `${conversationContext}\nНикита: ${message}`
    : message;

  const args = ['--print', '--system-prompt', SYSTEM_PROMPT, fullPrompt];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const proc = execFile('/usr/local/bin/claude', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      res.write(`data: ${JSON.stringify({ error: 'Ошибка выполнения Claude CLI' })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ done: true, text: stdout.trim() })}\n\n`);
    }
    res.end();
  });
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`Варвара запущена на http://localhost:${PORT}`);
});
