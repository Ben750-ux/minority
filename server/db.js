import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// Sur Render, le disque systeme est en lecture seule : DATA_DIR vaut /var/data (disk persistant).
// En local, on retombe sur <projet>/data. DB_PATH force un chemin precis (instances de test).
const dataDir = process.env.DATA_DIR
    ? process.env.DATA_DIR
    : join(rootDir, 'data');

mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || join(dataDir, 'minority.db');

let db;

try {
    db = new DatabaseSync(dbPath);
} catch (err) {
    console.error(`[minority] impossible d'ouvrir ${dbPath} : ${err.message}`);
    console.error('[minority] DATA_DIR doit pointer vers un dossier inscriptible (ex: /var/data).');
    process.exit(1);
}

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS players (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        token      TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
        code         TEXT PRIMARY KEY,
        host_id      TEXT NOT NULL REFERENCES players(id),
        t_question   INTEGER NOT NULL DEFAULT 15,
        t_vote       INTEGER NOT NULL DEFAULT 10,
        t_reveal     INTEGER NOT NULL DEFAULT 5,
        p_minority   INTEGER NOT NULL DEFAULT 3,
        p_blank_solo INTEGER NOT NULL DEFAULT 3,
        p_blank_multi INTEGER NOT NULL DEFAULT 3,
        p_target     INTEGER NOT NULL DEFAULT 20,
        status       TEXT NOT NULL DEFAULT 'lobby',
        round        INTEGER NOT NULL DEFAULT 0,
        asker_id     TEXT,
        phase        TEXT NOT NULL DEFAULT 'idle',
        phase_end    INTEGER,
        question     TEXT,
        winner_id    TEXT,
        created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_players (
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        seat      INTEGER NOT NULL,
        score     INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_code, player_id)
    );

    CREATE TABLE IF NOT EXISTS rounds (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        number     INTEGER NOT NULL,
        asker_id   TEXT NOT NULL REFERENCES players(id),
        question   TEXT,
        revealed   INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        UNIQUE (room_code, number)
    );

    CREATE TABLE IF NOT EXISTS votes (
        round_id  INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        answer    TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'blank')),
        at        INTEGER NOT NULL,
        PRIMARY KEY (round_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS deltas (
        round_id  INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        delta     INTEGER NOT NULL,
        reason    TEXT NOT NULL,
        PRIMARY KEY (round_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_code);
    CREATE INDEX IF NOT EXISTS idx_rounds_room ON rounds(room_code, number);
    CREATE INDEX IF NOT EXISTS idx_votes_round ON votes(round_id);
`);

const q = {
    insertPlayer: db.prepare('INSERT INTO players (id, name, token, created_at) VALUES (?, ?, ?, ?)'),
    playerByToken: db.prepare('SELECT * FROM players WHERE token = ?'),
    playerById: db.prepare('SELECT id, name FROM players WHERE id = ?'),
    renamePlayer: db.prepare('UPDATE players SET name = ? WHERE id = ?'),

    insertRoom: db.prepare(`
        INSERT INTO rooms (code, host_id, t_question, t_vote, t_reveal,
                           p_minority, p_blank_solo, p_blank_multi, p_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    roomByCode: db.prepare('SELECT * FROM rooms WHERE code = ?'),
    updateConfig: db.prepare(`
        UPDATE rooms SET t_question = ?, t_vote = ?, t_reveal = ?,
               p_minority = ?, p_blank_solo = ?, p_blank_multi = ?, p_target = ?
        WHERE code = ?
    `),
    setStatus: db.prepare('UPDATE rooms SET status = ? WHERE code = ?'),
    setPhase: db.prepare('UPDATE rooms SET phase = ?, phase_end = ?, asker_id = ?, question = ? WHERE code = ?'),
    setQuestion: db.prepare('UPDATE rooms SET question = ? WHERE code = ?'),
    bumpRound: db.prepare('UPDATE rooms SET round = round + 1 WHERE code = ?'),
    setWinner: db.prepare('UPDATE rooms SET winner_id = ?, status = ? WHERE code = ?'),
    resetScores: db.prepare('UPDATE room_players SET score = 0 WHERE room_code = ?'),
    setRound: db.prepare('UPDATE rooms SET round = ? WHERE code = ?'),

    insertRoomPlayer: db.prepare(
        'INSERT OR IGNORE INTO room_players (room_code, player_id, seat, joined_at) VALUES (?, ?, ?, ?)'
    ),
    roomPlayer: db.prepare('SELECT * FROM room_players WHERE room_code = ? AND player_id = ?'),
    maxSeat: db.prepare('SELECT MAX(seat) AS seat FROM room_players WHERE room_code = ?'),
    roomCount: db.prepare('SELECT COUNT(*) AS n FROM rooms'),
    members: db.prepare(`
        SELECT p.id, p.name, rp.seat, rp.score
        FROM room_players rp JOIN players p ON p.id = rp.player_id
        WHERE rp.room_code = ? ORDER BY rp.seat
    `),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_code = ?'),
    removeMember: db.prepare('DELETE FROM room_players WHERE room_code = ? AND player_id = ?'),
    addScore: db.prepare('UPDATE room_players SET score = MAX(0, score + ?) WHERE room_code = ? AND player_id = ?'),
    transferHost: db.prepare('UPDATE rooms SET host_id = ? WHERE code = ?'),

    insertRound: db.prepare(`
        INSERT OR IGNORE INTO rounds (room_code, number, asker_id, question, started_at)
        VALUES (?, ?, ?, ?, ?)
    `),
    roundByNumber: db.prepare('SELECT * FROM rounds WHERE room_code = ? AND number = ?'),
    setRoundQuestion: db.prepare('UPDATE rounds SET question = ?, revealed = 1 WHERE id = ?'),
    clearRounds: db.prepare('DELETE FROM rounds WHERE room_code = ?'),

    insertVote: db.prepare(
        'INSERT OR REPLACE INTO votes (round_id, player_id, answer, at) VALUES (?, ?, ?, ?)'
    ),
    votesOf: db.prepare('SELECT player_id, answer FROM votes WHERE round_id = ?'),
    voteCount: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE round_id = ?'),
    voteOf: db.prepare('SELECT answer FROM votes WHERE round_id = ? AND player_id = ?'),

    insertDelta: db.prepare(
        'INSERT OR REPLACE INTO deltas (round_id, player_id, delta, reason) VALUES (?, ?, ?, ?)'
    ),
    deltasOf: db.prepare('SELECT player_id, delta, reason FROM deltas WHERE round_id = ?')
};

export function now() {
    return Date.now();
}

export function createPlayer(name, token, id) {
    q.insertPlayer.run(id, name, token, now());
    return q.playerById.get(id);
}

export function playerByToken(token) {
    return q.playerByToken.get(token);
}

export function playerById(id) {
    return q.playerById.get(id);
}

export function renamePlayer(id, name) {
    q.renamePlayer.run(name, id);
}

export function createRoom(code, hostId, config) {
    q.insertRoom.run(
        code, hostId,
        config.tQuestion, config.tVote, config.tReveal,
        config.pMinority, config.pBlankSolo, config.pBlankMulti, config.pTarget,
        now()
    );
    return q.roomByCode.get(code);
}

export function getRoom(code) {
    return q.roomByCode.get(code);
}

export function updateConfig(code, config) {
    q.updateConfig.run(
        config.tQuestion, config.tVote, config.tReveal,
        config.pMinority, config.pBlankSolo, config.pBlankMulti, config.pTarget,
        code
    );
}

export function roomPlayers(code) {
    return q.members.all(code);
}

export function roomMembersCount(code) {
    return q.memberCount.get(code).n;
}

export function isMember(code, playerId) {
    return Boolean(q.roomPlayer.get(code, playerId));
}

export function joinRoom(code, playerId) {
    q.insertRoomPlayer.run(code, playerId, (q.maxSeat.get(code).seat ?? -1) + 1, now());
    return q.roomPlayer.get(code, playerId);
}

export function leaveRoom(code, playerId) {
    q.removeMember.run(code, playerId);
}

export function setRoomStatus(code, status) {
    q.setStatus.run(status, code);
}

export function setPhase(code, phase, phaseEnd, askerId, question) {
    q.setPhase.run(phase, phaseEnd, askerId, question, code);
}

export function setQuestion(code, question) {
    q.setQuestion.run(question, code);
}

export function currentRound(code) {
    return q.roundByNumber.get(code, currentRoundNumber(code));
}

export function currentRoundNumber(code) {
    return q.roomByCode.get(code).round;
}

export function nextRoundNumber(code) {
    q.bumpRound.run(code);
    return currentRoundNumber(code);
}

export function resetScores(code) {
    q.resetScores.run(code);
}

export function restartRoom(code) {
    q.setRound.run(0, code);
    q.setWinner.run(null, 'lobby', code);
    // Les rounds repartent de 1 : on efface ceux de la partie precedente,
    // sinon les votes de l'ancien round 1 sont encore en base et la
    // revelation se declenche des le premier vote de la nouvelle partie.
    q.clearRounds.run(code);
}

export function declareWinner(code, playerId) {
    q.setWinner.run(playerId, 'over', code);
}

export function ensureRound(code, number, askerId) {
    q.insertRound.run(code, number, askerId, null, now());
    return q.roundByNumber.get(code, number);
}

export function saveQuestion(roundId, question) {
    q.setRoundQuestion.run(question, roundId);
}

export function castVote(roundId, playerId, answer) {
    q.insertVote.run(roundId, playerId, answer, now());
}

export function hasVoted(roundId, playerId) {
    return Boolean(q.voteOf.get(roundId, playerId));
}

export function votesOf(roundId) {
    return q.votesOf.all(roundId);
}

export function voteCount(roundId) {
    return q.voteCount.get(roundId).n;
}

export function saveDelta(roundId, playerId, delta, reason) {
    q.insertDelta.run(roundId, playerId, delta, reason);
}

export function deltasOf(roundId) {
    return q.deltasOf.all(roundId);
}

export function applyDelta(code, playerId, delta) {
    q.addScore.run(delta, code, playerId);
}

export function transferHost(code, playerId) {
    q.transferHost.run(playerId, code);
}

export function roomCount() {
    return q.roomCount.get().n;
}

export { db };