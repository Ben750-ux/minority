import { api, subscribe, getSession, me } from './net.js';

const PRESETS = {
    standard: {
        label: 'Standard',
        detail: '15 s / 10 s / 5 s',
        values: { tQuestion: 15, tVote: 10, tReveal: 5, pMinority: 3, pBlankSolo: 3, pBlankMulti: 3, pTarget: 20 }
    },
    express: {
        label: 'Express',
        detail: '8 s / 5 s / 3 s',
        values: { tQuestion: 8, tVote: 5, tReveal: 3, pMinority: 2, pBlankSolo: 2, pBlankMulti: 2, pTarget: 12 }
    },
    long: {
        label: 'Longue partie',
        detail: '25 s / 15 s / 8 s',
        values: { tQuestion: 25, tVote: 15, tReveal: 8, pMinority: 1, pBlankSolo: 1, pBlankMulti: 1, pTarget: 50 }
    }
};

const MIN_PLAYERS = 3;

const session = getSession();
if (!session) {
    window.location.replace('login.html');
}

const el = {
    code: document.getElementById('roomCode'),
    copy: document.getElementById('copyCode'),
    count: document.getElementById('playerCount'),
    roster: document.getElementById('roster'),
    presets: document.getElementById('presets'),
    start: document.getElementById('start'),
    error: document.getElementById('error'),
    leave: document.getElementById('leaveLink'),
    configCards: [
        document.getElementById('configCard'),
        document.getElementById('configCard2'),
        document.getElementById('configCard3')
    ]
};

const inputs = {
    tQuestion: document.getElementById('tQuestion'),
    tVote: document.getElementById('tVote'),
    tReveal: document.getElementById('tReveal'),
    pMinority: document.getElementById('pMinority'),
    pBlankSolo: document.getElementById('pBlankSolo'),
    pBlankMulti: document.getElementById('pBlankMulti'),
    pTarget: document.getElementById('pTarget')
};

let room = null;
let configDirty = false;

function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
}

function buildPresets() {
    Object.entries(PRESETS).forEach(([key, preset]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset';
        btn.dataset.preset = key;
        btn.setAttribute('aria-pressed', 'false');

        const label = document.createElement('div');
        label.textContent = preset.label;

        const detail = document.createElement('span');
        detail.textContent = preset.detail;

        btn.append(label, detail);
        btn.addEventListener('click', async () => {
            Object.entries(preset.values).forEach(([id, value]) => {
                inputs[id].value = value;
            });
            el.presets.querySelectorAll('.preset').forEach((b) => {
                b.setAttribute('aria-pressed', String(b.dataset.preset === key));
            });
            await pushConfig();
        });

        el.presets.append(btn);
    });
}

function fillInputs(config) {
    Object.entries(config).forEach(([key, value]) => {
        if (inputs[key]) {
            inputs[key].value = value;
        }
    });
}

function readInputs() {
    const config = {};
    Object.entries(inputs).forEach(([id, input]) => {
        config[id] = Number(input.value);
    });
    return config;
}

async function pushConfig() {
    configDirty = false;
    try {
        await api(`/api/rooms/${room.code}/config`, { method: 'POST', body: readInputs() });
    } catch (err) {
        showError(err.message);
    }
}

function renderRoster() {
    el.roster.replaceChildren();
    el.count.textContent = `${room.players.length}/12`;

    room.players.forEach((player) => {
        const li = document.createElement('li');
        li.className = 'roster__row';

        const name = document.createElement('span');
        name.className = 'roster__player';
        name.textContent = player.name;

        const seat = document.createElement('span');
        seat.className = 'roster__seat';
        seat.textContent = `#${player.seat + 1}`;

        li.append(name, seat);

        if (player.isHost) {
            const tag = document.createElement('span');
            tag.className = 'host-tag';
            tag.textContent = 'maître de jeu';
            li.append(tag);
        }

        el.roster.append(li);
    });
}

function render() {
    const isHost = room.hostId === me()?.id;
    el.code.textContent = room.code;
    const hostName = room.players.find((p) => p.isHost)?.name;
    document.getElementById('lobbyTitle').textContent = isHost
        ? 'Ton salon'
        : `Salon de ${hostName ?? '?'}`;

    renderRoster();
    el.configCards.forEach((card) => {
        card.hidden = !isHost;
    });
    el.presets.hidden = !isHost;

    el.start.hidden = !isHost;
    el.start.disabled = isHost ? room.players.length < MIN_PLAYERS : true;

    if (isHost && !configDirty) {
        fillInputs(room.config);
    }
}

async function boot() {
    buildPresets();

    const code = new URLSearchParams(window.location.search).get('code')
        || sessionStorage.getItem('minority.room');

    if (!code) {
        const created = await api('/api/rooms', { method: 'POST', body: { config: {} } });
        sessionStorage.setItem('minority.room', created.room.code);
        window.location.replace(`lobby.html?code=${created.room.code}`);
        return;
    }

    sessionStorage.setItem('minority.room', code);

    try {
        const data = await api(`/api/rooms/${code}`);
        room = data.room;
        render();
    } catch (err) {
        sessionStorage.removeItem('minority.room');
        showError(`${err.message} — création d'un nouveau salon`);
        window.setTimeout(() => window.location.replace('lobby.html'), 1800);
        return;
    }

    subscribe(code, (next) => {
        room = next;
        render();
        if (next.status === 'playing' || next.status === 'over') {
            window.location.replace(`game.html?code=${next.code}`);
        }
    }, () => showError('connexion au salon perdue'));

    el.copy.addEventListener('click', () => {
        navigator.clipboard.writeText(el.code.textContent);
        el.copy.textContent = 'Copié !';
        setTimeout(() => {
            el.copy.textContent = 'Copier le code';
        }, 1400);
    });

    el.start.addEventListener('click', async () => {
        el.start.disabled = true;
        try {
            await api(`/api/rooms/${room.code}/start`, { method: 'POST' });
            window.location.href = `game.html?code=${room.code}`;
        } catch (err) {
            showError(err.message);
            el.start.disabled = false;
        }
    });

    el.leave.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
            await api(`/api/rooms/${room.code}/leave`, { method: 'POST' });
        } catch {
            /* deja parti */
        }
        sessionStorage.removeItem('minority.room');
        window.location.replace('login.html');
    });

    let timer = null;
    Object.values(inputs).forEach((input) => {
        input.addEventListener('change', () => {
            configDirty = true;
            clearTimeout(timer);
            timer = setTimeout(pushConfig, 400);
        });
    });
}

if (session) {
    boot().catch((err) => showError(err.message));
}