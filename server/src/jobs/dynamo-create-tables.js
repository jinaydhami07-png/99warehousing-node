/**
 * Creates every DynamoDB table and index defined in src/db/dynamo/tables.js.
 *
 *   node src/jobs/dynamo-create-tables.js            # create what is missing
 *   node src/jobs/dynamo-create-tables.js --verify   # report only, change nothing
 *
 * Safe to re-run: a table that already exists is left exactly as it is. The
 * job never deletes or alters an existing table, because the one thing worse
 * than a missing index is a setup script that drops production data when
 * someone runs it twice.
 *
 * Against DynamoDB Local, set DYNAMO_ENDPOINT=http://localhost:8000 first.
 */
'use strict';

const {
  CreateTableCommand, DescribeTableCommand, ListTablesCommand,
  UpdateTimeToLiveCommand, DescribeTimeToLiveCommand,
} = require('@aws-sdk/client-dynamodb');
const { base, region, endpoint } = require('../db/dynamo/client');
const { TABLES } = require('../db/dynamo/tables');

const verifyOnly = process.argv.includes('--verify');

function definition(spec) {
  /* DynamoDB wants every key attribute declared, and ONLY key attributes —
     declaring a non-key attribute is a validation error, which is why
     tables.js lists exactly the keyed ones. */
  const keyed = new Set([spec.hash, spec.range].filter(Boolean));
  for (const idx of spec.indexes) { keyed.add(idx.hash); if (idx.range) keyed.add(idx.range); }

  return {
    TableName: spec.name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [...keyed].map((a) => ({
      AttributeName: a,
      AttributeType: spec.attributes[a] || 'S',
    })),
    KeySchema: [
      { AttributeName: spec.hash, KeyType: 'HASH' },
      ...(spec.range ? [{ AttributeName: spec.range, KeyType: 'RANGE' }] : []),
    ],
    ...(spec.indexes.length ? {
      GlobalSecondaryIndexes: spec.indexes.map((i) => ({
        IndexName: i.name,
        KeySchema: [
          { AttributeName: i.hash, KeyType: 'HASH' },
          ...(i.range ? [{ AttributeName: i.range, KeyType: 'RANGE' }] : []),
        ],
        Projection: { ProjectionType: i.project || 'ALL' },
      })),
    } : {}),
  };
}

async function waitActive(name) {
  for (let i = 0; i < 60; i += 1) {
    const d = await base.send(new DescribeTableCommand({ TableName: name }));
    const t = d.Table;
    const gsiReady = (t.GlobalSecondaryIndexes || []).every((g) => g.IndexStatus === 'ACTIVE');
    if (t.TableStatus === 'ACTIVE' && gsiReady) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} did not become ACTIVE in time`);
}

(async () => {
  console.log(`  region   : ${region}`);
  console.log(`  endpoint : ${endpoint || 'aws (real DynamoDB)'}`);
  console.log('');

  const existing = new Set((await base.send(new ListTablesCommand({}))).TableNames || []);

  for (const spec of Object.values(TABLES)) {
    if (existing.has(spec.name)) {
      const d = await base.send(new DescribeTableCommand({ TableName: spec.name }));
      const have = new Set((d.Table.GlobalSecondaryIndexes || []).map((g) => g.IndexName));
      const missing = spec.indexes.filter((i) => !have.has(i.name)).map((i) => i.name);
      console.log(`  = ${spec.name.padEnd(18)} exists  (${d.Table.ItemCount} items)` +
        (missing.length ? `  ⚠ missing index: ${missing.join(', ')}` : ''));
      continue;
    }
    if (verifyOnly) { console.log(`  ✖ ${spec.name.padEnd(18)} MISSING`); continue; }

    await base.send(new CreateTableCommand(definition(spec)));
    await waitActive(spec.name);
    console.log(`  + ${spec.name.padEnd(18)} created (${spec.indexes.length} index${spec.indexes.length === 1 ? '' : 'es'})`);

    /* TTL is a real-DynamoDB feature that local emulators commonly omit.
       It is an optimisation — expired audit rows are swept for free — so a
       local endpoint that cannot do it must not fail the whole setup. */
    if (spec.ttlAttribute) {
      try {
        const ttl = await base.send(new DescribeTimeToLiveCommand({ TableName: spec.name }));
        if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== 'ENABLED') {
          await base.send(new UpdateTimeToLiveCommand({
            TableName: spec.name,
            TimeToLiveSpecification: { Enabled: true, AttributeName: spec.ttlAttribute },
          }));
          console.log(`    ttl on ${spec.ttlAttribute}`);
        }
      } catch (err) {
        console.log(`    ttl skipped (${endpoint ? 'not supported by this local endpoint' : err.name})`);
      }
    }
  }
  console.log('\n  done');
  process.exit(0);
})().catch((e) => { console.error('  FAILED:', e.message); process.exit(1); });
