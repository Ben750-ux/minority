import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './db.js';
import * as game from './game.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Render injecte PORT ; sur disque persistant, DATA_DIR permet de pointer ailleurs que /data
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TOKENS = new Map();
const streams = new Map();

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                reject(game.httpError(413, 'corps trop gros'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(game.httpError(400, 'json invalide'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function authenticate(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
        ? header.slice(7)
        : url?.searchParams.get('token') || ''; // EventSource ne peut pas envoyer d'entetes

    if (!token) {
        throw game.httpError(401, 'jeton manquant');
    }

    const session = TOKENS.get(token);
    if (!session) {
        throw game.httpError(401, 'jeton invalide');
    }

    const player = store.playerById(session.playerId);
    if (!player) {
        throw game.httpError(401, 'joueur introuvable');
    }
    return player;
}

async function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '') {
        pathname = '/index.html';
    }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const filePath = join(ROOT, relative);

    if (!filePath.startsWith(ROOT)) {
        sendJson(res, 403, { error: 'acces refuse' });
        return;
    }

    try {
        const info = await stat(filePath);
        if (info.isDirectory()) {
            sendJson(res, 404, { error: 'introuvable' });
            return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><meta charset="utf-8"><title>404</title>'
            + '<body style="background:#0d1b2e;color:#fff;font-family:sans-serif;padding:3rem">'
            + '<h1>404</h1><p>Page introuvable.</p>'
            + '<p><a href="/" style="color:#F2B632">Retour au jeu</a></p></body>');
    }
}

function broadcastRoom(code) {
    const clients = streams.get(code);
    if (!clients || clients.size === 0) {
        return;
    }
    const payload = `data: ${JSON.stringify({ type: 'state', room: game.publicRoom(code) })}\n\n`;
    clients.forEach((res) => res.write(payload));
}

function openStream(code, req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');

    if (!streams.has(code)) {
        streams.set(code, new Set());
    }
    streams.get(code).add(res);

    const initial = `data: ${JSON.stringify({ type: 'state', room: game.publicRoom(code) })}\n\n`;
    res.write(initial);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        streams.get(code)?.delete(res);
        if (streams.get(code)?.size === 0) {
            streams.delete(code);
        }
    });
}

const ROUTES = {
    'GET /api/health': async (req, res) => {
        sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), rooms: store.roomCount() });
    },

    'POST /api/session': async (req, res) => {
        const { name } = await readJson(req);
        const clean = String(name ?? '').trim().slice(0, 16);
        if (!clean) {
            throw game.httpError(400, 'pseudo obligatoire');
        }

        const token = randomBytes(24).toString('hex');
        const id = randomUUID();
        store.createPlayer(clean, token, id);
        TOKENS.set(token, { playerId: id });

        sendJson(res, 200, { token, player: store.playerById(id) });
    },

    'POST /api/rooms': async (req, res) => {
        const player = authenticate(req);
        const { config } = await readJson(req);
        const code = game.createRoom(player);
        if (config && typeof config === 'object') {
            game.setConfig(code, config);
        }
        sendJson(res, 201, { room: game.publicRoom(code) });
    },

    'POST /api/rooms/:code/join': async (req, res) => {
        const player = authenticate(req);
        const { code } = req.params;
        game.join(code.toUpperCase(), player);
        sendJson(res, 200, { room: game.publicRoom(code.toUpperCase()) });
    },

    'POST /api/rooms/:code/leave': async (req, res) => {
        const player = authenticate(req);
        game.leave(req.params.code.toUpperCase(), player.id);
        sendJson(res, 200, { ok: true });
    },

    'GET /api/rooms/:code': async (req, res) => {
        authenticate(req);
        const room = game.publicRoom(req.params.code.toUpperCase());
        if (!room) {
            throw game.httpError(404, 'salon introuvable');
        }
        sendJson(res, 200, { room });
    },

    'POST /api/rooms/:code/config': async (req, res) => {
        const player = authenticate(req);
        const code = req.params.code.toUpperCase();
        const room = store.getRoom(code);
        if (!room) {
            throw game.httpError(404, 'salon introuvable');
        }
        if (room.host_id !== player.id) {
            throw game.httpError(403, 'seul le maitre de jeu regle la partie');
        }
        game.setConfig(code, await readJson(req));
        sendJson(res, 200, { room: game.publicRoom(code) });
    },

    'POST /api/rooms/:code/start': async (req, res) => {
        const player = authenticate(req);
        game.start(req.params.code.toUpperCase(), player);
        sendJson(res, 200, { room: game.publicRoom(req.params.code.toUpperCase()) });
    },

    'POST /api/rooms/:code/question': async (req, res) => {
        const player = authenticate(req);
        const { text } = await readJson(req);
        game.submitQuestion(req.params.code.toUpperCase(), player, text);
        sendJson(res, 200, { ok: true });
    },

    'POST /api/rooms/:code/vote': async (req, res) => {
        const player = authenticate(req);
        const { answer } = await readJson(req);
        game.castVote(req.params.code.toUpperCase(), player, answer);
        sendJson(res, 200, { ok: true });
    },

    'POST /api/rooms/:code/rematch': async (req, res) => {
        const player = authenticate(req);
        game.rematch(req.params.code.toUpperCase(), player);
        sendJson(res, 200, { room: game.publicRoom(req.params.code.toUpperCase()) });
    },

    'GET /api/rooms/:code/events': async (req, res) => {
        authenticate(req, req.url);
        openStream(req.params.code.toUpperCase(), req, res);
    }
};

function matchRoute(method, pathname) {
    const direct = ROUTES[`${method} ${pathname}`];
    if (direct) {
        return { handler: direct, params: {} };
    }

    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts.length < 3) {
        return null;
    }

    for (const key of Object.keys(ROUTES)) {
        const [routeMethod, routePath] = key.split(' ');
        if (routeMethod !== method) {
            continue;
        }

        const routeParts = routePath.split('/').filter(Boolean);
        if (routeParts.length !== parts.length) {
            continue;
        }

        const params = {};
        let ok = true;

        for (let i = 0; i < routeParts.length; i += 1) {
            if (routeParts[i].startsWith(':')) {
                params[routeParts[i].slice(1)] = decodeURIComponent(parts[i]);
            } else if (routeParts[i] !== parts[i]) {
                ok = false;
                break;
            }
        }

        if (ok) {
            return { handler: ROUTES[key], params };
        }
    }

    return null;
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
        const route = matchRoute(req.method, pathname);
        if (!route) {
            // Une route /api/* inconnue doit toujours répondre du JSON, sinon
            // fetch() côté client echoue sur un body HTML.
            if (pathname.startsWith('/api/')) {
                sendJson(res, 404, { error: 'route inconnue' });
            } else if (req.method === 'GET' || req.method === 'HEAD') {
                await serveStatic(req, res, pathname);
            } else {
                sendJson(res, 404, { error: 'route inconnue' });
            }
            return;
        }

        req.params = route.params;
        req.url = url;
        await route.handler(req, res);
    } catch (err) {
        const status = err.status || 500;
        if (status === 500) {
            console.error('[minority]', err);
        }
        if (status === 401) {
            console.warn(`[401] ${req.method} ${pathname} :: ${err.message} :: token=${(req.headers.authorization || '').slice(7, 15) || url.searchParams.get('token')?.slice(0, 8) || 'AUCUN'}`);
        }
        if (!res.headersSent) {
            sendJson(res, status, { error: err.message || 'erreur serveur' });
        }
    }
});

game.setBroadcaster(broadcastRoom);

server.listen(PORT, HOST, () => {
    console.log(`Minority — http://localhost:${PORT}`);
    console.log(`Base SQLite : ${process.env.DB_PATH || join(ROOT, 'data', 'minority.db')}`);
});