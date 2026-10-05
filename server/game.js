import * as store from './db.js';

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;

const rooms = new Map();
let broadcaster = () => { };

export function setBroadcaster(fn) {
    broadcaster = fn;
}

function code() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export function sanitizeConfig(input) {
    const clamp = (value, min, max, fallback) => {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    return {
        tQuestion: clamp(input.tQuestion, 5, 60, 15),
        tVote: clamp(input.tVote, 3, 60, 10),
        tReveal: clamp(input.tReveal, 2, 30, 5),
        pMinority: clamp(input.pMinority, 0, 20, 3),
        pBlankSolo: clamp(input.pBlankSolo, 0, 20, 3),
        pBlankMulti: clamp(input.pBlankMulti, 0, 20, 3),
        pTarget: clamp(input.pTarget, 3, 200, 20)
    };
}

export function createRoom(player) {
    let newCode = code();
    while (store.getRoom(newCode)) {
        newCode = code();
    }

    const config = sanitizeConfig({});
    store.createRoom(newCode, player.id, config);
    store.joinRoom(newCode, player.id);
    getRuntime(newCode);

    return newCode;
}

function getRuntime(roomCode) {
    const existing = rooms.get(roomCode);
    if (existing) {
        return existing;
    }

    const runtime = { timers: new Map(), revealing: false };
    rooms.set(roomCode, runtime);
    return runtime;
}

export function clearTimers(roomCode) {
    const runtime = rooms.get(roomCode);
    if (!runtime) {
        return;
    }
    runtime.timers.forEach((id) => clearTimeout(id));
    runtime.timers.clear();
}

function schedule(roomCode, delay, fn) {
    const runtime = getRuntime(roomCode);
    const id = setTimeout(() => {
        runtime.timers.delete(id);
        fn();
    }, delay);
    runtime.timers.set(id, id);
}

export function publicRoom(roomCode) {
    const room = store.getRoom(roomCode);
    if (!room) {
        return null;
    }

    const members = store.roomPlayers(roomCode);
    const round = room.round ? store.currentRound(roomCode) : null;
    const revealed = Boolean(round?.revealed);

    return {
        code: room.code,
        hostId: room.host_id,
        status: room.status,
        phase: room.phase,
        round: room.round,
        phaseEnd: room.phase_end,
        question: room.question,
        askerId: room.asker_id,
        winnerId: room.winner_id,
        config: {
            tQuestion: room.t_question,
            tVote: room.t_vote,
            tReveal: room.t_reveal,
            pMinority: room.p_minority,
            pBlankSolo: room.p_blank_solo,
            pBlankMulti: room.p_blank_multi,
            pTarget: room.p_target
        },
        players: members.map((m) => ({
            id: m.id,
            name: m.name,
            seat: m.seat,
            score: m.score,
            isHost: m.id === room.host_id,
            isAsker: m.id === room.asker_id
        })),
        votes: round ? store.votesOf(round.id).length : 0,
        voterCount: members.length,
        reveal: revealed && round ? buildReveal(room, round) : null
    };
}

function buildReveal(room, round) {
    const votes = store.votesOf(round.id);
    const members = store.roomPlayers(room.code);
    const voterIds = new Set(members.map((m) => m.id));

    const groups = { yes: [], no: [], blank: [] };
    votes.forEach((v) => {
        if (voterIds.has(v.player_id)) {
            groups[v.answer].push(v.player_id);
        }
    });

    // Le blanc est une abstention, pas une reponse : il ne compte pas dans la minorite.
    // On ne compare que oui/non, et uniquement les groupes ayant au moins un votant,
    // sinon un groupe vide serait toujours "minoritaire".
    const answered = ['yes', 'no'].filter((key) => groups[key].length > 0);
    const min = answered.length ? Math.min(...answered.map((key) => groups[key].length)) : 0;
    const minorityKeys = min > 0 ? answered.filter((key) => groups[key].length === min) : [];

    const deltas = new Map();
    members.forEach((m) => deltas.set(m.id, { delta: 0, reasons: [] }));

    minorityKeys.forEach((key) => {
        groups[key].forEach((id) => {
            deltas.get(id).delta += room.p_minority;
            deltas.get(id).reasons.push('minority');
        });
    });

    const blanks = groups.blank;
    if (blanks.length === 1) {
        deltas.get(blanks[0]).delta += room.p_blank_solo;
        deltas.get(blanks[0]).reasons.push('blank-solo');
    } else if (blanks.length > 1) {
        blanks.forEach((id) => {
            deltas.get(id).delta -= room.p_blank_multi;
            deltas.get(id).reasons.push('blank-multi');
        });
    }

    return {
        question: round.question,
        groups: Object.entries(groups).map(([key, ids]) => ({
            key,
            count: ids.length,
            players: ids.map((id) => members.find((m) => m.id === id)?.name ?? '?')
        })),
        minorityKeys,
        blankSoloId: blanks.length === 1 ? blanks[0] : null,
        blankMultiIds: blanks.length > 1 ? blanks : [],
        deltas: members.map((m) => ({
            id: m.id,
            name: m.name,
            ...deltas.get(m.id)
        }))
    };
}

export function setConfig(roomCode, input) {
    store.updateConfig(roomCode, sanitizeConfig(input));
    emit(roomCode);
}

export function join(roomCode, player) {
    const room = store.getRoom(roomCode);
    if (!room) {
        throw httpError(404, 'salon introuvable');
    }
    if (room.status !== 'lobby') {
        throw httpError(409, 'la partie a deja commence');
    }
    if (!store.isMember(roomCode, player.id)) {
        if (store.roomMembersCount(roomCode) >= MAX_PLAYERS) {
            throw httpError(409, 'salon complet');
        }
        store.joinRoom(roomCode, player.id);
    }
    emit(roomCode);
}

export function leave(roomCode, playerId) {
    const room = store.getRoom(roomCode);
    if (!room) {
        return;
    }
    store.leaveRoom(roomCode, playerId);

    if (room.host_id === playerId) {
        const remaining = store.roomPlayers(roomCode);
        if (remaining.length) {
            store.transferHost(roomCode, remaining[0].id);
        } else {
            clearTimers(roomCode);
            store.setRoomStatus(roomCode, 'lobby');
        }
    }
    emit(roomCode);
}

export function start(roomCode, player) {
    const room = store.getRoom(roomCode);
    assertHost(room, player);
    if (room.status !== 'lobby') {
        throw httpError(409, 'partie deja lancee');
    }
    if (store.roomMembersCount(roomCode) < MIN_PLAYERS) {
        throw httpError(400, `il faut au moins ${MIN_PLAYERS} joueurs`);
    }

    clearTimers(roomCode);
    store.resetScores(roomCode);
    store.restartRoom(roomCode);
    store.setRoomStatus(roomCode, 'playing');
    startAskerTurn(roomCode);
}

function assertHost(room, player) {
    if (!room) {
        throw httpError(404, 'salon introuvable');
    }
    if (room.host_id !== player.id) {
        throw httpError(403, 'seul le maitre de jeu peut faire cela');
    }
}

function startAskerTurn(roomCode) {
    const room = store.getRoom(roomCode);
    const members = store.roomPlayers(roomCode);
    if (!members.length) {
        store.setRoomStatus(roomCode, 'lobby');
        emit(roomCode);
        return;
    }

    const number = store.nextRoundNumber(roomCode);
    const asker = members[(number - 1) % members.length];

    store.ensureRound(roomCode, number, asker.id);
    store.setPhase(roomCode, 'question', Date.now() + room.t_question * 1000, asker.id, null);
    emit(roomCode);

    schedule(roomCode, room.t_question * 1000, () => startVoting(roomCode));
}

export function submitQuestion(roomCode, player, text) {
    const room = store.getRoom(roomCode);
    const question = String(text ?? '').trim().slice(0, 140);

    if (room.phase !== 'question') {
        throw httpError(409, 'ce n est pas le tour de question');
    }
    if (room.asker_id !== player.id) {
        throw httpError(403, 'vous ne posez pas la question');
    }

    clearTimers(roomCode);
    store.setQuestion(roomCode, question || null);

    const round = store.currentRound(roomCode);

    if (!question) {
        // Le questionneur n'a rien dit : la manche est annulée, personne ne marque.
        store.saveQuestion(round.id, null);
        skipRound(roomCode);
        return;
    }

    store.saveQuestion(round.id, question);
    startVoting(roomCode);
}

function skipRound(roomCode) {
    if (store.roomMembersCount(roomCode) === 1) {
        finish(roomCode, store.roomPlayers(roomCode)[0].id);
        return;
    }
    store.setPhase(roomCode, 'reveal', Date.now() + 1800, null, null);
    emit(roomCode);
    schedule(roomCode, 1800, () => startAskerTurn(roomCode));
}

function startVoting(roomCode) {
    const room = store.getRoom(roomCode);

    store.setPhase(roomCode, 'vote', Date.now() + room.t_vote * 1000, room.asker_id, room.question);
    emit(roomCode);

    schedule(roomCode, room.t_vote * 1000, () => revealRound(roomCode));
}

export function castVote(roomCode, player, answer) {
    const room = store.getRoom(roomCode);
    const round = store.currentRound(roomCode);

    if (room.phase !== 'vote') {
        // Re-vote du meme joueur alors que le scrutin vient de se clore :
        // le vote est deja enregistre, on le confirme plutot que de renvoyer une erreur.
        if (room.phase === 'reveal' && round && store.hasVoted(round.id, player.id)) {
            return;
        }
        throw httpError(409, 'le vote est ferme');
    }
    if (!['yes', 'no', 'blank'].includes(answer)) {
        throw httpError(400, 'vote invalide');
    }

    // Tout le monde vote, y compris le questionneur et le maitre de jeu.
    store.castVote(round.id, player.id, answer);

    if (store.voteCount(round.id) >= store.roomMembersCount(roomCode)) {
        revealRound(roomCode);
    }
}

function revealRound(roomCode) {
    const runtime = getRuntime(roomCode);
    if (runtime.revealing) {
        return;
    }
    const room = store.getRoom(roomCode);
    if (!room || room.phase !== 'vote') {
        return;
    }
    runtime.revealing = true;
    clearTimers(roomCode);

    const round = store.currentRound(roomCode);
    const snapshot = buildReveal(room, round);

    snapshot.deltas.forEach((entry) => {
        if (entry.delta !== 0) {
            store.saveDelta(round.id, entry.id, entry.delta, entry.reasons[0] ?? 'none');
            store.applyDelta(roomCode, entry.id, entry.delta);
        }
    });

    store.setPhase(roomCode, 'reveal', Date.now() + room.t_reveal * 1000, room.asker_id, room.question);
    emit(roomCode);

    schedule(roomCode, room.t_reveal * 1000, () => {
        runtime.revealing = false;
        const champion = store.roomPlayers(roomCode).find((p) => p.score >= room.p_target);
        if (champion) {
            finish(roomCode, champion.id);
        } else {
            startAskerTurn(roomCode);
        }
    });
}

function finish(roomCode, winnerId) {
    clearTimers(roomCode);
    store.declareWinner(roomCode, winnerId);
    store.setPhase(roomCode, 'over', null, null, null);
    emit(roomCode);
}

export function rematch(roomCode, player) {
    const room = store.getRoom(roomCode);
    assertHost(room, player);

    clearTimers(roomCode);
    getRuntime(roomCode).revealing = false;
    store.resetScores(roomCode);
    store.restartRoom(roomCode);
    store.setRoomStatus(roomCode, 'playing');
    startAskerTurn(roomCode);
}

export function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

export function emit(roomCode) {
    broadcaster(roomCode);
}