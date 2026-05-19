const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const KB_PATH = path.join(__dirname, 'knowledge_base.md');
const CLAUDE_PATH = '/usr/local/bin/claude';

function readProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (_) { return []; }
}
function writeProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}
function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch (_) { return []; }
}
function writeTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}
function loadKB() {
  try { return fs.readFileSync(KB_PATH, 'utf8'); } catch (_) { return ''; }
}
function buildEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.HOME = env.HOME || '/Users/nikita';
  env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return env;
}

const TASK_ACTION_INSTRUCTION = `

Если пользователь просит создать задачу, занести в бэклог, добавить задачу или запомнить что-то как задачу — после своего ответа добавь в самый конец специальный блок (только если нужно создать задачу, иначе не добавляй):
%%ACTION:CREATE_TASK%%{"title":"точное название задачи"}%%END%%`;

console.log(`[${new Date().toISOString()}] Варвара стартует на порту 3737`);

// ─── PROJECTS ────────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => res.json(readProjects()));

app.post('/api/projects', (req, res) => {
  const { name, icon } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const projects = readProjects();
  const project = {
    id: Date.now().toString(),
    name: name.trim(),
    icon: icon || '📁',
    systemPrompt: `Ты — Варвара, советник Никиты по проекту «${name.trim()}».`,
    useKnowledgeBase: false,
    columns: ['Бэклог', 'Анализ', 'Review анализа', 'ТЗ', 'Review ТЗ',
              'Ожидает разработки', 'В разработке', 'Ожидает тестирования',
              'Тестирование', 'Review кода', 'Продакшн']
  };
  projects.push(project);
  writeProjects(projects);
  res.json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  ['name', 'icon', 'columns', 'systemPrompt', 'useKnowledgeBase'].forEach(k => {
    if (req.body[k] !== undefined) project[k] = req.body[k];
  });
  writeProjects(projects);
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  projects.splice(idx, 1);
  writeProjects(projects);
  const tasks = readTasks().filter(t => t.projectId !== req.params.id);
  writeTasks(tasks);
  res.json({ ok: true });
});

// ─── TASKS ───────────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const { projectId } = req.query;
  const tasks = readTasks();
  res.json(projectId ? tasks.filter(t => t.projectId === projectId) : tasks);
});

app.post('/api/tasks', (req, res) => {
  const { projectId, title, column, agent, priority, epic } = req.body;
  if (!projectId || !title?.trim()) return res.status(400).json({ error: 'projectId and title required' });
  const VALID_PRIORITIES = ['critical','high','medium','low','someday'];
  const tasks = readTasks();
  const task = {
    id: Date.now().toString(),
    projectId,
    title: title.trim(),
    column: column || 'Бэклог',
    agent: agent || '',
    epic: epic || '',
    priority: VALID_PRIORITIES.includes(priority) ? priority : 'medium',
    createdAt: new Date().toISOString()
  };
  tasks.unshift(task);
  writeTasks(tasks);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const tasks = readTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  ['column', 'title', 'agent', 'priority', 'projectId', 'epic'].forEach(k => {
    if (req.body[k] !== undefined) task[k] = req.body[k];
  });
  writeTasks(tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  tasks.splice(idx, 1);
  writeTasks(tasks);
  res.json({ ok: true });
});

// ─── CHAT ────────────────────────────────────────────────────────────────────
app.post('/api/chat', (req, res) => {
  const { message, history, projectId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const projects = readProjects();
  const project = projects.find(p => p.id === projectId) || projects[0];
  const kb = project?.useKnowledgeBase ? '\n\n---\n\n' + loadKB() : '';
  const systemPrompt = (project?.systemPrompt || '') + kb + TASK_ACTION_INSTRUCTION;

  const conversationContext = (history || [])
    .map(m => `${m.role === 'user' ? 'Никита' : 'Варвара'}: ${m.content}`)
    .join('\n');
  const fullPrompt = conversationContext ? `${conversationContext}\nНикита: ${message}` : message;

  console.log(`[${new Date().toISOString()}] [${project?.name}] "${message.slice(0, 60)}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let elapsed = 0;
  const heartbeat = setInterval(() => {
    elapsed += 3;
    res.write(`data: ${JSON.stringify({ thinking: elapsed })}\n\n`);
  }, 3000);

  const args = ['--print', '--system-prompt', systemPrompt, fullPrompt];
  const start = Date.now();

  execFile(CLAUDE_PATH, args, { maxBuffer: 10 * 1024 * 1024, env: buildEnv(), timeout: 120000 }, (err, stdout, stderr) => {
    clearInterval(heartbeat);
    const sec = ((Date.now() - start) / 1000).toFixed(1);

    if (err) {
      console.error(`[ERROR ${sec}s] ${err.message}`);
      res.write(`data: ${JSON.stringify({ error: stderr || err.message })}\n\n`);
    } else {
      const raw = stdout.trim();
      const actionMatch = raw.match(/%%ACTION:CREATE_TASK%%(.+?)%%END%%/s);
      const text = raw.replace(/%%ACTION:CREATE_TASK%%(.+?)%%END%%/s, '').trim();
      let action = null;
      if (actionMatch) {
        try { action = { type: 'CREATE_TASK', data: JSON.parse(actionMatch[1]) }; } catch (_) {}
      }
      console.log(`[OK ${sec}s] ${text.length} символов${action ? ' + ACTION:CREATE_TASK' : ''}`);
      res.write(`data: ${JSON.stringify({ text, action })}\n\n`);
    }
    res.end();
  });

  req.on('close', () => clearInterval(heartbeat));
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Варвара запущена на http://localhost:${PORT}`);
});
