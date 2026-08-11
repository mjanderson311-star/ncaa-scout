'use strict';
/**
 * reclassify-plays.js
 * Re-runs classifyPlay() against every stored raw_text and updates play_type in-place.
 * No network requests — uses data already in the DB.
 *
 * Run: node reclassify-plays.js
 * Optional: node reclassify-plays.js --contest 6535171   (single contest only)
 */

try { require('dotenv').config(); } catch(e) {}

const { Pool } = require('pg');

const DB_NAME = process.env.PGDATABASE || 'ncaa_scout';
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 4 }
    : {
        host:     process.env.PGHOST     || 'localhost',
        port:     Number(process.env.PGPORT || 5432),
        user:     process.env.PGUSER     || process.env.USERNAME || 'postgres',
        password: process.env.PGPASSWORD || undefined,
        database: DB_NAME,
        max: 4,
      }
);

// ─── Classifier (must stay in sync with scraper.js classifyPlay) ────────────

function classifyPlay(desc) {
  if (!desc) return 'other';
  const d = desc.toLowerCase();
  // Strip parenthetical pitch-count/sequence annotations like "(0-1 K)" or "(B S K)"
  // so that "tripled to CF, RBI (0-1 K)" isn't misread as a strikeout.
  const dClean = d.replace(/\([^)]*\)/g, '');

  if (/struck? out|strikeout|strike out/.test(d) || /\bk\b/.test(dClean))   return 'strikeout';
  if (/walk(ed)?|base on balls|\bbb\b/.test(d))                              return 'walk';
  if (/hit by pitch|hbp/.test(d))                                            return 'hbp';
  if (/home run|homered|hr\b/.test(d))                                       return 'hr';
  if (/triple[d]?/.test(d))                                                  return 'triple';
  if (/double\s*play|\bgdp\b|\bdp\b/.test(d))                               return 'out';
  if (/double[d]?/.test(d))                                                  return 'double';
  if (/single[d]?/.test(d))                                                  return 'single';
  if (/sac(rifice)?\s*(fly|bunt)|sf\b|sh\b/.test(d))                        return 'sac';
  if (/wild pitch|wp\b/.test(d))                                             return 'wp';
  if (/passed ball|pb\b/.test(d))                                            return 'pb';
  if (/balk/.test(d))                                                        return 'balk';
  if (/stole|stolen base|sb\b/.test(d))                                      return 'steal';
  if (/caught stealing|\bcs\b/.test(d))                                      return 'caught_stealing';
  if (/pick(ed)? off|pickoff/.test(d))                                       return 'pickoff';
  if (/error/.test(d))                                                       return 'error';
  if (/grounded? (into|out)|ground(ed)? (ball|out)|flied? out|popped? up|lined? out|fly(ing)? out|fouled? out/.test(d))
                                                                             return 'out';
  if (/out/.test(d))                                                         return 'out';
  return 'other';
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const contestArg = process.argv.indexOf('--contest');
  const contestId  = contestArg !== -1 ? process.argv[contestArg + 1] : null;

  let whereClause = '';
  let queryParams = [];
  if (contestId) {
    whereClause = `JOIN ncaa_games g ON p.game_id = g.id WHERE g.contest_id = $1`;
    queryParams = [contestId];
    console.log(`Reclassifying plays for contest ${contestId} …`);
  } else {
    console.log('Reclassifying ALL plays in the database …');
  }

  const selectSQL = `
    SELECT p.id, p.raw_text, p.play_type
    FROM ncaa_plays p
    ${whereClause}
    ORDER BY p.id
  `;

  const { rows } = await pool.query(selectSQL, queryParams);
  console.log(`Loaded ${rows.length} plays.`);

  // Reclassify and collect changes
  const changes = [];
  const typeCounts = {};
  for (const row of rows) {
    const newType = classifyPlay(row.raw_text);
    typeCounts[newType] = (typeCounts[newType] || 0) + 1;
    if (newType !== row.play_type) {
      changes.push({ id: row.id, oldType: row.play_type, newType, raw: row.raw_text });
    }
  }

  console.log(`\nNew type distribution:`);
  Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).forEach(([t,c])=>console.log(`  ${t.padEnd(16)} ${c}`));
  console.log(`\nPlays that will change: ${changes.length}`);

  if (changes.length === 0) {
    console.log('Nothing to update.');
    await pool.end();
    return;
  }

  // Show a sample of changes for review
  console.log('\nSample changes (first 20):');
  changes.slice(0, 20).forEach(c =>
    console.log(`  id=${c.id}  ${c.oldType} → ${c.newType}  "${c.raw.slice(0, 80)}"`)
  );

  // Batch update in chunks of 500
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const chunk = changes.slice(i, i + CHUNK);
    // Build a VALUES list: (id, newType), ...
    const vals = chunk.map((c, j) => `($${j*2+1}::int, $${j*2+2})`).join(', ');
    const params = chunk.flatMap(c => [c.id, c.newType]);
    await pool.query(`
      UPDATE ncaa_plays AS p
      SET play_type = v.new_type
      FROM (VALUES ${vals}) AS v(id, new_type)
      WHERE p.id = v.id
    `, params);
    updated += chunk.length;
    process.stdout.write(`\rUpdated ${updated}/${changes.length} …`);
  }
  console.log(`\nDone. ${changes.length} plays reclassified.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
