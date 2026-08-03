const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const dataFile = path.join(__dirname, 'data.json');
const sseClients = new Set();

function buildDefaultState() {
  const conversations = [
    { id: 'general', name: 'General', description: 'Daily chatter and quick hello messages' },
    { id: 'cozy', name: 'Cozy Corner', description: 'Gentle conversations and soft updates' },
    { id: 'plans', name: 'Project Notes', description: 'Ideas, milestones, and cozy planning' },
  ];

  const messages = {};
  conversations.forEach((conversation) => {
    messages[conversation.id] = [
      {
        id: `${conversation.id}-welcome`,
        username: 'Moonbloom',
        text: conversation.id === 'general'
          ? 'Welcome to the general room. Say hello and start the conversation.'
          : conversation.id === 'cozy'
            ? 'This is the cozy corner for softer, longer chats.'
            : 'A little planning room for notes, ideas, and updates.',
        timestamp: new Date().toISOString(),
        kind: 'system',
        conversation: conversation.id,
      },
    ];
  });

  return { users: {}, conversations, messages };
}

function loadState() {
  if (!fs.existsSync(dataFile)) {
    return buildDefaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      ...buildDefaultState(),
      ...parsed,
      conversations: parsed.conversations || buildDefaultState().conversations,
      messages: parsed.messages || buildDefaultState().messages,
      users: parsed.users || {},
    };
  } catch (error) {
    return buildDefaultState();
  }
}

function persistState(state) {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
}

let state = loadState();
persistState(state);

function broadcastSse(eventType, payload) {
  const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try {
      client.write(data);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function createUser(username, password) {
  const key = username.toLowerCase();
  const user = {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    username,
    password,
    online: true,
    lastSeen: new Date().toISOString(),
  };
  state.users[key] = user;
  persistState(state);
  broadcastSse('presence', { users: serializeUsers() });
  return user;
}

function getUser(username) {
  return state.users[username.toLowerCase()];
}

function updateUserActivity(username) {
  const user = getUser(username);
  if (user) {
    user.online = true;
    user.lastSeen = new Date().toISOString();
    persistState(state);
    broadcastSse('presence', { users: serializeUsers() });
  }
}

function addMessage(payload) {
  const conversationId = payload.conversation || 'general';
  if (!state.messages[conversationId]) {
    state.messages[conversationId] = [];
  }

  const entry = {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    username: payload.username,
    text: payload.text,
    timestamp: new Date().toISOString(),
    kind: 'user',
    conversation: conversationId,
    status: 'sent',
  };

  state.messages[conversationId].push(entry);
  if (state.messages[conversationId].length > 200) {
    state.messages[conversationId] = state.messages[conversationId].slice(-200);
  }
  persistState(state);
  broadcastSse('message', { conversation: conversationId, message: entry });
  return entry;
}

function createConversation(name, description) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const conversation = {
    id,
    name,
    description: description || 'A new cozy room',
  };
  state.conversations.push(conversation);
  state.messages[conversation.id] = [];
  persistState(state);
  broadcastSse('conversation', { conversation });
  return conversation;
}

function serializeUsers() {
  return Object.values(state.users).map((user) => ({
    id: user.id,
    username: user.username,
    online: user.online,
    lastSeen: user.lastSeen,
  }));
}

function serializeConversations() {
  return state.conversations.map((conversation) => {
    const roomMessages = state.messages[conversation.id] || [];
    const lastMessage = roomMessages[roomMessages.length - 1];
    return {
      id: conversation.id,
      name: conversation.name,
      description: conversation.description,
      preview: lastMessage ? lastMessage.text : 'No messages yet',
    };
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath) {
  const absolutePath = path.join(publicDir, filePath);
  if (!absolutePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(absolutePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, app: 'Moonbloom' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const username = String(parsed.username || '').trim();
        const password = String(parsed.password || '').trim();
        if (!username || !password) {
          sendJson(res, 400, { ok: false, message: 'Username and password are required.' });
          return;
        }
        let user = getUser(username);
        if (!user) {
          user = createUser(username, password);
        } else if (user.password !== password) {
          sendJson(res, 401, { ok: false, message: 'Incorrect password.' });
          return;
        }
        updateUserActivity(username);
        sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username, online: true, lastSeen: user.lastSeen } });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    sendJson(res, 200, { ok: true, conversations: serializeConversations() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/conversations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const name = String(parsed.name || '').trim();
        const description = String(parsed.description || '').trim();
        if (!name) {
          sendJson(res, 400, { ok: false, message: 'A room name is required.' });
          return;
        }
        const room = createConversation(name, description);
        sendJson(res, 200, { ok: true, conversation: room });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: 'Invalid room payload.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const conversation = url.searchParams.get('conversation') || 'general';
    sendJson(res, 200, { ok: true, messages: state.messages[conversation] || [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/messages') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const username = String(parsed.username || '').trim();
        const text = String(parsed.text || '').trim();
        const conversation = String(parsed.conversation || 'general').trim();
        if (!username || !text) {
          sendJson(res, 400, { ok: false, message: 'A username and message are required.' });
          return;
        }
        const user = getUser(username);
        if (!user) {
          sendJson(res, 404, { ok: false, message: 'User not found. Please sign in first.' });
          return;
        }
        updateUserActivity(username);
        const entry = addMessage({ username, text, conversation });
        sendJson(res, 200, { ok: true, message: entry });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: 'Invalid message body.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    sendJson(res, 200, { ok: true, users: serializeUsers() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    serveFile(res, 'index.html');
    return;
  }

  serveFile(res, url.pathname === '/' ? 'index.html' : url.pathname);
});

function listenWithFallback(portToTry) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = portToTry + 1;
      console.warn(`Port ${portToTry} is busy. Trying ${nextPort} instead.`);
      listenWithFallback(nextPort);
      return;
    }

    console.error('Failed to start Moonbloom server:', error);
    process.exit(1);
  });

  server.listen(portToTry, '0.0.0.0', () => {
    console.log(`Moonbloom chat server is running at http://localhost:${portToTry}`);
  });
}

listenWithFallback(port);
