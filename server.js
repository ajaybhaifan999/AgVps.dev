const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Persistence ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let users = loadJson(USERS_FILE, {});
// owner bootstrap
const OWNER_USER = 'Agajayofficial';
const OWNER_PASS = 'agajay';
if (!users[OWNER_USER]) {
  users[OWNER_USER] = {
    username: OWNER_USER,
    password: OWNER_PASS,
    role: 'owner',
    createdAt: Date.now(),
    expiresAt: null,           // infinite
    maxFiles: null,            // infinite
  };
  saveJson(USERS_FILE, users);
}

let servers = loadJson(SERVERS_FILE, {}); // { serverId: { owner, name, file, createdAt, status } }
const runningProcs = {};   // serverId -> child process
const runningLogs = {};    // serverId -> array of log lines (ring buffer)
const logSubs = {};        // serverId -> Set of res (SSE clients)

function pushLog(serverId, line) {
  if (!runningLogs[serverId]) runningLogs[serverId] = [];
  runningLogs[serverId].push(line);
  if (runningLogs[serverId].length > 2000) runningLogs[serverId].shift();
  if (logSubs[serverId]) {
    for (const res of logSubs[serverId]) {
      try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
    }
  }
}

// ---------- App middleware ----------
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

function getUser(req) {
  const u = req.session.user;
  if (!u) return null;
  const fresh = users[u];
  if (!fresh) return null;
  if (fresh.expiresAt && Date.now() > fresh.expiresAt) return null;
  return fresh;
}
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u;
  next();
}
function requireOwner(req, res, next) {
  const u = getUser(req);
  if (!u || u.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  req.user = u;
  next();
}

// ---------- Multer (uploads) ----------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const u = getUser(req);
    if (!u) return cb(new Error('Unauthorized'));
    const dir = path.join(UPLOAD_DIR, u.username);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) { cb(null, file.originalname); },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB

// ---------- Auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = users[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (u.expiresAt && Date.now() > u.expiresAt) {
    return res.status(403).json({ error: 'Account expired' });
  }
  req.session.user = u.username;
  res.json({ ok: true, role: u.role, redirect: u.role === 'owner' ? '/owner.html' : '/dashboard.html' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    username: u.username, role: u.role,
    expiresAt: u.expiresAt, maxFiles: u.maxFiles,
    createdAt: u.createdAt,
  });
});

// ---------- Owner: manage users ----------
app.get('/api/owner/users', requireOwner, (req, res) => {
  const list = Object.values(users).map(u => ({
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
    maxFiles: u.maxFiles,
    expired: u.expiresAt ? Date.now() > u.expiresAt : false,
  }));
  res.json(list);
});

app.post('/api/owner/users', requireOwner, (req, res) => {
  const { username, password, days, maxFiles } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  if (users[username]) return res.status(400).json({ error: 'User already exists' });
  const expiresAt = days && Number(days) > 0 ? Date.now() + Number(days) * 86400000 : null;
  users[username] = {
    username, password,
    role: 'user',
    createdAt: Date.now(),
    expiresAt,
    maxFiles: maxFiles && Number(maxFiles) > 0 ? Number(maxFiles) : null,
  };
  saveJson(USERS_FILE, users);
  res.json({ ok: true });
});

app.delete('/api/owner/users/:username', requireOwner, (req, res) => {
  const u = req.params.username;
  if (u === OWNER_USER) return res.status(400).json({ error: 'Cannot delete owner' });
  delete users[u];
  saveJson(USERS_FILE, users);
  // cleanup uploads
  try { fs.rmSync(path.join(UPLOAD_DIR, u), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// ---------- Files ----------
app.get('/api/files', requireAuth, (req, res) => {
  const dir = path.join(UPLOAD_DIR, req.user.username);
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).map(name => {
    const s = fs.statSync(path.join(dir, name));
    return { name, size: s.size, mtime: s.mtimeMs };
  });
  res.json(list);
});

app.post('/api/files/upload', requireAuth, (req, res, next) => {
  // enforce max files
  const dir = path.join(UPLOAD_DIR, req.user.username);
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const max = req.user.maxFiles;
  upload.array('files', 200)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (max != null) {
      const after = fs.readdirSync(dir).length;
      if (after > max) {
        // remove the just-uploaded over-limit ones
        const files = (req.files || []).map(f => f.path);
        while (fs.readdirSync(dir).length > max && files.length) {
          try { fs.unlinkSync(files.pop()); } catch {}
        }
        return res.status(400).json({ error: `File limit reached (${max})` });
      }
    }
    res.json({ ok: true, count: (req.files || []).length });
  });
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  const p = path.join(UPLOAD_DIR, req.user.username, req.params.name);
  if (!p.startsWith(path.join(UPLOAD_DIR, req.user.username))) return res.status(400).end();
  try { fs.unlinkSync(p); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Servers (run scripts) ----------
function detectRunner(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return ['python3', [file]];
  if (ext === '.js') return ['node', [file]];
  if (ext === '.sh') return ['bash', [file]];
  return ['bash', ['-c', file]]; // fallback raw command
}

app.get('/api/servers', requireAuth, (req, res) => {
  const list = Object.values(servers).filter(s =>
    req.user.role === 'owner' || s.owner === req.user.username
  );
  res.json(list);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name, file } = req.body || {};
  if (!name || !file) return res.status(400).json({ error: 'name & file required' });
  const filePath = path.join(UPLOAD_DIR, req.user.username, file);
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found, upload it first' });
  const id = crypto.randomBytes(6).toString('hex');
  servers[id] = {
    id, name, file,
    owner: req.user.username,
    createdAt: Date.now(),
    status: 'stopped',
  };
  saveJson(SERVERS_FILE, servers);
  res.json(servers[id]);
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const s = servers[req.params.id];
  if (!s) return res.status(404).end();
  if (s.owner !== req.user.username && req.user.role !== 'owner') return res.status(403).end();
  if (runningProcs[s.id]) { try { runningProcs[s.id].kill('SIGKILL'); } catch {} }
  delete servers[s.id];
  delete runningLogs[s.id];
  saveJson(SERVERS_FILE, servers);
  res.json({ ok: true });
});

app.post('/api/servers/:id/start', requireAuth, (req, res) => {
  const s = servers[req.params.id];
  if (!s) return res.status(404).end();
  if (s.owner !== req.user.username && req.user.role !== 'owner') return res.status(403).end();
  if (runningProcs[s.id]) return res.status(400).json({ error: 'Already running' });

  const cwd = path.join(UPLOAD_DIR, s.owner);
  const [cmd, args] = detectRunner(s.file);
  const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  runningProcs[s.id] = child;
  s.status = 'running';
  s.startedAt = Date.now();
  saveJson(SERVERS_FILE, servers);
  pushLog(s.id, `[system] started ${cmd} ${args.join(' ')}`);

  child.stdout.on('data', d => d.toString().split('\n').forEach(l => l && pushLog(s.id, l)));
  child.stderr.on('data', d => d.toString().split('\n').forEach(l => l && pushLog(s.id, `[err] ${l}`)));
  child.on('exit', code => {
    pushLog(s.id, `[system] exited with code ${code}`);
    s.status = 'stopped';
    saveJson(SERVERS_FILE, servers);
    delete runningProcs[s.id];
  });

  res.json({ ok: true });
});

app.post('/api/servers/:id/stop', requireAuth, (req, res) => {
  const s = servers[req.params.id];
  if (!s) return res.status(404).end();
  if (s.owner !== req.user.username && req.user.role !== 'owner') return res.status(403).end();
  const p = runningProcs[s.id];
  if (p) { try { p.kill('SIGKILL'); } catch {} }
  s.status = 'stopped';
  saveJson(SERVERS_FILE, servers);
  res.json({ ok: true });
});

// ---------- Logs (SSE) ----------
app.get('/api/servers/:id/logs', requireAuth, (req, res) => {
  const s = servers[req.params.id];
  if (!s) return res.status(404).end();
  if (s.owner !== req.user.username && req.user.role !== 'owner') return res.status(403).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  for (const line of runningLogs[s.id] || []) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  if (!logSubs[s.id]) logSubs[s.id] = new Set();
  logSubs[s.id].add(res);
  req.on('close', () => logSubs[s.id]?.delete(res));
});

// ---------- Module install (pip / pkg) ----------
app.post('/api/install', requireAuth, (req, res) => {
  const { manager, name } = req.body || {};
  if (!name || !/^[a-zA-Z0-9._\-+=<>]+$/.test(name))
    return res.status(400).json({ error: 'Invalid module name' });
  let cmd;
  if (manager === 'pip') cmd = `pip install ${name}`;
  else if (manager === 'pkg') cmd = `apt-get install -y ${name} || pkg install -y ${name}`;
  else return res.status(400).json({ error: 'manager must be pip or pkg' });

  exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      cmd,
      stdout: stdout?.slice(-8000) || '',
      stderr: stderr?.slice(-8000) || '',
    });
  });
});

// ---------- Static & routing ----------
app.use(express.static(path.join(ROOT, 'public')));

app.get('/', (req, res) => {
  const u = getUser(req);
  if (!u) return res.redirect('/login.html');
  res.redirect(u.role === 'owner' ? '/owner.html' : '/dashboard.html');
});

// guard html pages
app.get(['/owner.html'], (req, res, next) => {
  const u = getUser(req);
  if (!u || u.role !== 'owner') return res.redirect('/login.html');
  next();
});
app.get(['/dashboard.html'], (req, res, next) => {
  const u = getUser(req);
  if (!u) return res.redirect('/login.html');
  next();
});

app.listen(PORT, () => console.log(`Agajay VPS Panel running on :${PORT}`));
