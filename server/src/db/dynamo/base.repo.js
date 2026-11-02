/**
 * Shared DynamoDB access helpers.
 *
 * These cover the handful of operations the services actually perform, and
 * nothing more. The point is that each entity repository below reads as a list
 * of access patterns rather than a pile of command construction.
 */
'use strict';

const crypto = require('crypto');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, ScanCommand, BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./client');

/**
 * 24 hex characters — the same shape MongoDB's ObjectId produced.
 * The route validators enforce that shape, so ids generated here stay valid
 * and rows migrated from MongoDB keep the ids they already had.
 */
const newId = () => crypto.randomBytes(12).toString('hex');

const nowIso = () => new Date().toISOString();

/* ── Expression building ───────────────────────────────────────────────────
   Every attribute name goes through a placeholder. DynamoDB has a long list
   of reserved words — `status`, `name`, `owner` and `views` are all on it, and
   all four are used here — and a raw name silently fails at runtime. */

let seq = 0;
const nextKey = () => `a${(seq = (seq + 1) % 100000)}`;

function buildNames(fields) {
  const names = {};
  for (const f of fields) names[`#${f}`] = f;
  return names;
}

/** Turns { status: 'approved', type: 'Warehouse' } into a FilterExpression. */
function buildFilter(filter = {}) {
  const parts = [];
  const names = {};
  const values = {};
  for (const [field, raw] of Object.entries(filter)) {
    if (raw === undefined || raw === null) continue;
    const n = `#f_${field}`;
    names[n] = field;

    if (Array.isArray(raw)) {
      if (!raw.length) continue;
      const keys = raw.map((v) => { const k = `:${nextKey()}`; values[k] = v; return k; });
      parts.push(`${n} IN (${keys.join(', ')})`);
    } else if (typeof raw === 'object' && (raw.gte !== undefined || raw.lte !== undefined || raw.gt !== undefined || raw.lt !== undefined)) {
      for (const [op, sym] of [['gte', '>='], ['lte', '<='], ['gt', '>'], ['lt', '<']]) {
        if (raw[op] === undefined) continue;
        const k = `:${nextKey()}`; values[k] = raw[op];
        parts.push(`${n} ${sym} ${k}`);
      }
    } else if (typeof raw === 'object' && raw.contains !== undefined) {
      const k = `:${nextKey()}`; values[k] = raw.contains;
      parts.push(`contains(${n}, ${k})`);
    } else {
      const k = `:${nextKey()}`; values[k] = raw;
      parts.push(`${n} = ${k}`);
    }
  }
  return parts.length
    ? { FilterExpression: parts.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values }
    : {};
}

/**
 * Reads an entire query or scan, following DynamoDB's pagination.
 *
 * DynamoDB returns at most 1MB per call and signals more with
 * LastEvaluatedKey. Code that ignores it appears to work for months and then
 * starts losing rows as the table grows, which is the worst possible failure
 * mode. `limit` caps how much is pulled when a caller only needs a page.
 */
async function readAll(Command, params, { limit } = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new Command({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
    if (limit && items.length >= limit) return items.slice(0, limit);
  } while (ExclusiveStartKey);
  return items;
}

function makeRepo(table) {
  const T = table.name;

  /** Builds the primary key object for either a simple or composite key. */
  const keyOf = (a, b) => (table.range ? { [table.hash]: a, [table.range]: b } : { [table.hash]: a });

  return {
    table,
    newId,
    nowIso,

    async get(a, b) {
      const r = await doc.send(new GetCommand({ TableName: T, Key: keyOf(a, b) }));
      return r.Item || null;
    },

    async put(item) {
      await doc.send(new PutCommand({ TableName: T, Item: item }));
      return item;
    },

    async delete(a, b) {
      await doc.send(new DeleteCommand({ TableName: T, Key: keyOf(a, b) }));
    },

    /**
     * Partial update.
     * `set` assigns, `add` increments a number (DynamoDB's ADD, which is
     * atomic — two concurrent view counts cannot lose one another the way a
     * read-modify-write would), `remove` deletes attributes.
     */
    async update(a, b, { set = {}, add = {}, remove = [] } = {}) {
      const names = {};
      const values = {};
      const sets = [];
      const adds = [];
      const removes = [];

      for (const [f, v] of Object.entries(set)) {
        if (v === undefined) continue;
        const n = `#s_${f}`; const k = `:${nextKey()}`;
        names[n] = f; values[k] = v; sets.push(`${n} = ${k}`);
      }
      for (const [f, v] of Object.entries(add)) {
        const n = `#i_${f}`; const k = `:${nextKey()}`;
        names[n] = f; values[k] = v; adds.push(`${n} ${k}`);
      }
      for (const f of remove) { const n = `#r_${f}`; names[n] = f; removes.push(n); }

      const clauses = [
        sets.length ? `SET ${sets.join(', ')}` : '',
        adds.length ? `ADD ${adds.join(', ')}` : '',
        removes.length ? `REMOVE ${removes.join(', ')}` : '',
      ].filter(Boolean).join(' ');

      if (!clauses) return this.get(a, b);

      const r = await doc.send(new UpdateCommand({
        TableName: T,
        Key: keyOf(a, b),
        UpdateExpression: clauses,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ReturnValues: 'ALL_NEW',
      }));
      return r.Attributes || null;
    },

    /**
     * Query one partition of the table or of a secondary index.
     * `descending: true` reads newest-first when the sort key is a timestamp.
     */
    async query(hashValue, {
      index, hashField, filter, limit, descending = false, rangeCondition,
    } = {}) {
      const hf = hashField || (index ? table.indexes.find((i) => i.name === index)?.hash : table.hash);
      const names = { '#h': hf };
      const values = { ':h': hashValue };
      let KeyConditionExpression = '#h = :h';

      if (rangeCondition) {
        const rf = index ? table.indexes.find((i) => i.name === index)?.range : table.range;
        names['#r'] = rf;
        if (rangeCondition.gte !== undefined) { values[':r'] = rangeCondition.gte; KeyConditionExpression += ' AND #r >= :r'; }
        else if (rangeCondition.lte !== undefined) { values[':r'] = rangeCondition.lte; KeyConditionExpression += ' AND #r <= :r'; }
        else if (rangeCondition.eq !== undefined) { values[':r'] = rangeCondition.eq; KeyConditionExpression += ' AND #r = :r'; }
      }

      const f = buildFilter(filter);
      return readAll(QueryCommand, {
        TableName: T,
        ...(index ? { IndexName: index } : {}),
        KeyConditionExpression,
        ExpressionAttributeNames: { ...names, ...(f.ExpressionAttributeNames || {}) },
        ExpressionAttributeValues: { ...values, ...(f.ExpressionAttributeValues || {}) },
        ...(f.FilterExpression ? { FilterExpression: f.FilterExpression } : {}),
        ScanIndexForward: !descending,
      }, { limit });
    },

    /**
     * Full table read with an optional filter.
     * Reserved for the few cases with no usable partition — free-text search
     * and the admin "everything" views. DynamoDB charges for every row a Scan
     * reads, not the rows it returns, so these stay rare and are called out
     * where they are used.
     */
    async scan({ filter, limit } = {}) {
      const f = buildFilter(filter);
      return readAll(ScanCommand, { TableName: T, ...f }, { limit });
    },

    async count({ filter } = {}) {
      const f = buildFilter(filter);
      let total = 0; let ExclusiveStartKey;
      do {
        const r = await doc.send(new ScanCommand({ TableName: T, ...f, Select: 'COUNT', ExclusiveStartKey }));
        total += r.Count || 0;
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return total;
    },

    /** Writes in chunks of 25, DynamoDB's hard limit for a batch. */
    async batchPut(items) {
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        let request = { [T]: chunk.map((Item) => ({ PutRequest: { Item } })) };
        /* Unprocessed items are normal under throttling, not an error. Retry
           them with a short backoff rather than dropping rows silently. */
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const r = await doc.send(new BatchWriteCommand({ RequestItems: request }));
          const left = r.UnprocessedItems && r.UnprocessedItems[T];
          if (!left || !left.length) break;
          request = { [T]: left };
          await new Promise((res) => setTimeout(res, 2 ** attempt * 50));
        }
      }
      return items.length;
    },
  };
}

module.exports = { makeRepo, newId, nowIso, buildFilter, buildNames, readAll };
