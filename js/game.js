import { api, subscribe, getSession, me } from './net.js';

const LABELS = { yes: 'OUI', no: 'NON', blank: 'BLANC' };

const session = getSession();
const code = new URLSearchParams(window.location.search).get('code')
    || sessionStorage.getItem('minority.room');

if (!session || !code) {
    window.location.replace('login.html');
}

const el = {
    round: document.getElementById('roundNumber'),
    phaseLabel: document.getElementById('phaseLabel'),
    timer: document.getElementById('timer'),
    timerBox: document.getElementById('timerBox'),
    scoreboard: document.getElementById('scoreboard'),
    waiting: document.getElementById('waitingHint'),
    error: document.getElementById('error'),
    revealGroups: document.getElementById('revealGroups'),
    revealDeltas: document.getElementById('revealDeltas'),
    revealQuestion: document.getElementById('revealQuestion'),
    podium: document.getElementById('podium'),
    winnerName: document.getElementById('winnerName'),
    rematch: document.getElementById('rematch'),
    askerName: document.getElementById('askerName'),
    questionInput: document.getElementById('questionInput'),
    questionSubmit: document.getElementById('questionSubmit'),
    ballotQuestion: document.getElementById('ballotQuestion'),
    views: {
        asker: document.getElementById('askerView'),
        waiting: document.getElementById('waitingView'),
        ballot: document.getElementById('ballotView'),
        reveal: document.getElementById('revealView'),
        winner: document.getElementById('winnerView')
    }
};

let room = null;
let myVote = null;
let tickId = null;

function show(name) {
    Object.entries(el.views).forEach(([key, node]) => {
        node.hidden = key !== name;
    });
}

function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
    setTimeout(() => {
        el.error.hidden = true;
    }, 3000);
}

function tick() {
    if (!room?.phaseEnd || room.phase === 'over') {
        el.timer.textContent = '—';
        el.timerBox.classList.remove('is-warning');
        return;
    }
    const left = Math.max(0, Math.ceil((room.phaseEnd - Date.now()) / 1000));
    el.timer.textContent = left;
    el.timerBox.classList.toggle('is-warning', left <= 3 && room.phase !== 'idle');
}

function renderScoreboard() {
    el.scoreboard.replaceChildren();
    el.round.textContent = room.round || 0;

    room.players.forEach((player) => {
        const chip = document.createElement('span');
        chip.className = 'score-chip';
        if (player.id === room.askerId) {
            chip.classList.add('is-turn');
        }

        const name = document.createElement('span');
        name.textContent = player.name;

        const score = document.createElement('b');
        score.textContent = player.score;

        chip.append(name, ' ', score);
        el.scoreboard.append(chip);
    });
}

function renderAsker() {
    el.askerName.textContent = room.players.find((p) => p.id === room.askerId)?.name ?? '—';
    el.questionInput.disabled = false;
    el.questionSubmit.disabled = false;
    el.phaseLabel.textContent = 'Au joueur de poser la question';
    el.questionInput.focus();
}

function renderReveal() {
    const reveal = room.reveal;
    el.revealQuestion.textContent = reveal.question ?? '—';
    el.revealGroups.replaceChildren();
    el.revealDeltas.replaceChildren();

    reveal.groups.forEach((group) => {
        const li = document.createElement('li');
        li.className = 'group';

        if (reveal.minorityKeys.includes(group.key)) {
            li.classList.add('is-minority');
        }
        if (group.key === 'blank') {
            li.classList.add('is-blank');
        }

        const label = document.createElement('span');
        label.className = 'group__label';
        label.textContent = `${LABELS[group.key]} · ${group.count}`;

        const wrap = document.createElement('span');
        wrap.className = 'group__players';

        group.players.forEach((name) => {
            const tag = document.createElement('span');
            tag.className = 'group__player';
            tag.textContent = name;
            wrap.append(tag);
        });

        const tagText = group.key !== 'blank'
            ? ''
            : reveal.blankSoloId && group.count === 1
                ? 'blanc unique'
                : reveal.blankMultiIds.length > 1
                    ? 'blanc multiple'
                    : '';

        if (tagText) {
            const tag = document.createElement('span');
            tag.className = `group__tag ${tagText === 'blanc multiple' ? 'group__tag--bad' : 'group__tag--good'}`;
            tag.textContent = tagText;
            wrap.append(tag);
        }

        li.append(label, wrap);
        el.revealGroups.append(li);
    });

    reveal.deltas.forEach((entry) => {
        const chip = document.createElement('span');
        const sign = entry.delta > 0 ? '+' : entry.delta < 0 ? '−' : '±';
        chip.className = `delta ${entry.delta > 0 ? 'delta--plus' : entry.delta < 0 ? 'delta--minus' : 'delta--zero'}`;
        chip.innerHTML = `${escapeHtml(entry.name)} <b>${sign}${Math.abs(entry.delta)}</b>`;
        el.revealDeltas.append(chip);
    });
}



function renderWinner() {
    const winner = room.players.find((p) => p.id === room.winnerId);
    el.winnerName.textContent = winner?.name ?? '—';
    el.rematch.hidden = room.hostId !== me()?.id;

    el.podium.replaceChildren();
    [...room.players]
        .sort((a, b) => b.score - a.score)
        .forEach((player, index) => {
            const row = document.createElement('li');
            row.className = 'podium__row';
            if (index === 0) {
                row.classList.add('is-first');
            }

            const name = document.createElement('span');
            name.textContent = `${index + 1}. ${player.name}`;

            const score = document.createElement('b');
            score.textContent = `${player.score} pts`;

            row.append(name, score);
            el.podium.append(row);
        });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function render() {
    renderScoreboard();
    tick();

    if (room.status === 'over') {
        show('winner');
        renderWinner();
        return;
    }

    if (room.phase === 'question') {
        if (room.askerId === me()?.id) {
            show('asker');
            renderAsker();
        } else {
            show('waiting');
        }
        return;
    }

    if (room.phase === 'vote') {
        el.ballotQuestion.textContent = room.question ?? '—';

        if (room.askerId === me()?.id) {
            show('waiting');
            return;
        }

        show('ballot');
        document.querySelectorAll('.ballot__btn').forEach((btn) => {
            btn.disabled = myVote !== null;
        });
        el.waiting.textContent = myVote
            ? `Vote envoyé : ${LABELS[myVote].toLowerCase()}. En attente des autres…`
            : `En attente des votes… ${room.votes}/${room.voterCount}`;
        return;
    }

    if (room.phase === 'reveal') {
        if (room.reveal) {
            show('reveal');
            renderReveal();
        } else {
            show('waiting');
            el.waiting.textContent = 'Aucun joueur n\'a répondu à la question.';
        }
    }
}

document.querySelectorAll('.ballot__btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
        if (myVote) {
            return;
        }
        myVote = btn.dataset.vote;

        try {
            await api(`/api/rooms/${room.code}/vote`, { method: 'POST', body: { answer: myVote } });
        } catch (err) {
            myVote = null;
            showError(err.message);
        }
        render();
    });
});

el.questionSubmit.addEventListener('click', async () => {
    const text = el.questionInput.value.trim();
    el.questionSubmit.disabled = true;
    el.questionInput.disabled = true;

    try {
        await api(`/api/rooms/${room.code}/question`, { method: 'POST', body: { text } });
    } catch (err) {
        showError(err.message);
        el.questionSubmit.disabled = false;
        el.questionInput.disabled = false;
    }
});

el.questionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        el.questionSubmit.click();
    }
});

el.rematch.addEventListener('click', async () => {
    el.rematch.disabled = true;
    try {
        myVote = null;
        el.questionInput.value = '';
        await api(`/api/rooms/${room.code}/rematch`, { method: 'POST' });
    } catch (err) {
        showError(err.message);
    }
    el.rematch.disabled = false;
});

function boot() {
    tickId = setInterval(tick, 250);

    subscribe(code, (next) => {
        const previousPhase = room?.phase;
        room = next;

        if (previousPhase === 'vote' && next.phase !== 'vote') {
            myVote = null;
        }

        render();
    }, (err) => {
        clearInterval(tickId);
        showError(err.message);
    });
}

api(`/api/rooms/${code}`)
    .then((data) => {
        room = data.room;
        render();
        boot();
    })
    .catch(() => {
        sessionStorage.removeItem('minority.room');
        window.location.replace('lobby.html');
    });