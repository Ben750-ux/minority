import { api, subscribe, getSession, me } from './net.js';

const MIN_PLAYERS = 3;

const session = getSession();
const code = new URLSearchParams(window.location.search).get('code')
    || sessionStorage.getItem('minority.room');

if (!session || !code) {
    window.location.replace('login.html');
}

const el = {
    code: document.getElementById('code'),
    count: document.getElementById('count'),
    countLabel: document.getElementById('countLabel'),
    players: document.getElementById('players'),
    hint: document.getElementById('hint'),
    error: document.getElementById('error'),
    copy: document.getElementById('copy'),
    leave: document.getElementById('leave')
};

let room = null;
let leaving = false;

function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
}

function renderPlayers() {
    el.players.replaceChildren();

    room.players.forEach((player) => {
        const li = document.createElement('li');
        li.className = 'wait__player';

        if (player.isHost) {
            li.classList.add('wait__player--host');
        }
        if (player.id === me()?.id) {
            li.classList.add('wait__player--self');
        }

        const avatar = document.createElement('span');
        avatar.className = 'wait__avatar';
        avatar.textContent = player.name.charAt(0);

        const name = document.createElement('span');
        name.className = 'wait__name';
        name.textContent = player.name;

        li.append(avatar, name);

        if (player.isHost) {
            const tag = document.createElement('span');
            tag.className = 'wait__tag wait__tag--host';
            tag.textContent = 'maître de jeu';
            li.append(tag);
        } else if (player.id === me()?.id) {
            const tag = document.createElement('span');
            tag.className = 'wait__tag wait__tag--you';
            tag.textContent = 'vous';
            li.append(tag);
        }

        el.players.append(li);
    });

    if (!room.players.length) {
        const empty = document.createElement('li');
        empty.className = 'wait__waiting';
        empty.textContent = 'Personne pour l\'instant.';
        el.players.append(empty);
    }
}

function render() {
    el.code.textContent = room.code;

    const n = room.players.length;
    el.count.textContent = n;
    el.countLabel.textContent = n > 1 ? 'joueurs connectés' : 'joueur connecté';

    renderPlayers();

    const ready = n >= MIN_PLAYERS;
    el.hint.textContent = ready
        ? `Tout est prêt, le maître de jeu peut lancer la partie.`
        : `Encore ${MIN_PLAYERS - n} joueur${MIN_PLAYERS - n > 1 ? 's' : ''} attendu${MIN_PLAYERS - n > 1 ? 's' : ''}.`;
    el.hint.classList.toggle('wait__hint--ready', ready);

    // Le maître de jeu a son propre écran de réglages.
    if (room.hostId === me()?.id) {
        window.location.replace(`lobby.html?code=${room.code}`);
    }

    // Le maître de jeu a lancé : tout le monde bascule sur la partie.
    if (room.status === 'playing' || room.status === 'over') {
        window.location.replace(`game.html?code=${room.code}`);
    }
}

el.copy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(room.code);
        el.copy.textContent = 'Copié !';
        setTimeout(() => {
            el.copy.textContent = 'Copier le code';
        }, 1500);
    } catch {
        showError(`Copie impossible. Note le code : ${room.code}`);
    }
});

el.leave.addEventListener('click', async () => {
    if (leaving) {
        return;
    }
    leaving = true;

    try {
        await api(`/api/rooms/${room.code}/leave`, { method: 'POST' });
    } catch {
        /* deja parti */
    }

    sessionStorage.removeItem('minority.room');
    window.location.replace('login.html');
});

api(`/api/rooms/${code}`)
    .then((data) => {
        room = data.room;
        render();
        subscribe(code, (next) => {
            room = next;
            render();
        }, () => showError('Connexion perdue. Recharge la page.'));
    })
    .catch((err) => {
        sessionStorage.removeItem('minority.room');
        showError(`${err.message}`);
        setTimeout(() => window.location.replace('login.html'), 2500);
    });