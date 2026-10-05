import { db } from './db.js';

db.exec('DELETE FROM deltas');
db.exec('DELETE FROM votes');
db.exec('DELETE FROM rounds');
db.exec('DELETE FROM room_players');
db.exec('DELETE FROM rooms');
db.exec('DELETE FROM players');
db.exec('VACUUM');

console.log('Base Minority vide.');