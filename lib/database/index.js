const { DATABASE } = require('../../config')
const { QueryTypes, UniqueConstraintError, Utils } = require('sequelize')
const path = require('path')
const fs = require('fs')

const logger = require('../utils/logger').createLogger('database')

// Initialize models
const models = {}

// Load all models
const modelsDir = path.join(__dirname, 'models')
const modelFiles = fs.readdirSync(modelsDir).filter(file => file.endsWith('.js'))

for (const file of modelFiles) {
  const modelName = path.basename(file, '.js')
  models[modelName] = require(path.join(modelsDir, file))(DATABASE)
}

/**
 * Additive schema update (SQLite and Postgres)
 *
 * `sequelize.sync({ alter: true })` is not used: on SQLite it rebuilds every
 * table and turns a composite unique index (or a composite primary key) into one
 * UNIQUE constraint per column; on Postgres it piles up duplicate unique
 * constraints on every boot. Instead, on each boot:
 *
 *   1. missing tables are created, with their indexes (`Model.sync()`);
 *   2. SQLite only: tables damaged by an earlier `alter: true` are rebuilt;
 *   3. columns missing from existing tables are added when they are nullable or
 *      have a default (an existing column is never altered or dropped);
 *   4. model-declared indexes missing from existing tables are created. A unique
 *      index that fails because of duplicate data only logs a warning.
 */

const q = (name) => DATABASE.getQueryInterface().quoteIdentifier(name, true)

const errorText = (err) => err?.original?.message || err?.message || String(err)

const isUniqueViolation = (err) =>
  err instanceof UniqueConstraintError ||
  err?.original?.code === '23505' ||
  /unique constraint|could not create unique index|duplicate key/i.test(errorText(err))

const isAlreadyExists = (err) => /already exists/i.test(errorText(err))

/** Table name as understood by the queryInterface (string, or { tableName, schema }) */
const tableOf = (model) => model.getTableName()

/** Plain list of the model's columns (virtual attributes excluded) */
const columnsOf = (model) =>
  Object.entries(model.tableAttributes).map(([name, attr]) => ({ column: attr.field || name, attr }))

/** True when the column definition gives a value to rows that already exist */
const hasSqlDefault = (attr) =>
  attr.defaultValue !== undefined && attr.defaultValue !== null && Utils.defaultValueSchemable(attr.defaultValue)

/** Rows of a raw SQLite query (lower-case `pragma` keeps Sequelize from post-processing it) */
const pragma = (sql, options) => DATABASE.query(sql, { type: QueryTypes.SELECT, ...options })

// ---------------------------------------------------------------------------
// SQLite repair
// ---------------------------------------------------------------------------

/**
 * Columns of an existing SQLite table that carry a UNIQUE constraint the model
 * does not ask for. These are the leftovers of `alter: true`:
 *  - composite unique index (Warn) -> UNIQUE on each column + the right index;
 *  - composite primary key (UserStats, GroupEconomy, GroupRole) -> UNIQUE on
 *    each key column + PRIMARY KEY (a, b).
 * A UNIQUE next to a single-column primary key is redundant but harmless, and
 * is left alone.
 */
async function findSpuriousUniqueColumns(model) {
  const attrs = columnsOf(model)
  const primaryKeys = attrs.filter(({ attr }) => attr.primaryKey)
  const soloPrimaryKey = primaryKeys.length === 1 ? primaryKeys[0].column : null
  const wantedUnique = new Set(attrs.filter(({ attr }) => attr.unique).map(({ column }) => column))

  const indexes = await pragma(`pragma index_list(${q(model.tableName)})`)
  const spurious = []
  for (const index of indexes) {
    // origin 'u' = UNIQUE constraint of the CREATE TABLE ('c' = CREATE INDEX, 'pk' = primary key)
    if (!index.unique || index.origin !== 'u') continue
    const columns = await pragma(`pragma index_info(${q(index.name)})`)
    if (columns.length !== 1) continue
    const column = columns[0].name
    if (column === soloPrimaryKey || wantedUnique.has(column)) continue
    spurious.push(column)
  }
  return spurious
}

/**
 * Rebuild a damaged SQLite table with the schema of the model, keeping its rows.
 * All or nothing: one transaction, foreign keys off (a pragma that SQLite ignores
 * inside a transaction, so it is set around it).
 * @returns {Promise<{ copied: number, dropped: number, backup: string|null }>}
 */
async function rebuildSqliteTable(model) {
  const table = model.tableName
  const old = `${table}__old`

  const [{ foreign_keys: foreignKeys } = {}] = await pragma('pragma foreign_keys')
  if (foreignKeys) await DATABASE.query('pragma foreign_keys = off')

  let started = false
  try {
    await DATABASE.query('BEGIN IMMEDIATE')
    started = true

    // Explicit indexes follow the renamed table and would clash with the new ones
    const indexes = await pragma(`pragma index_list(${q(table)})`)
    for (const index of indexes) {
      if (index.origin === 'c') await DATABASE.query(`DROP INDEX ${q(index.name)}`)
    }

    const oldColumns = (await pragma(`pragma table_info(${q(table)})`)).map(c => c.name)
    const attrs = columnsOf(model)
    const required = attrs.filter(({ column, attr }) =>
      !oldColumns.includes(column) && attr.allowNull === false && !hasSqlDefault(attr) && !attr.autoIncrement)
    if (required.length) {
      // INSERT OR IGNORE would silently skip every row
      throw new Error(`new required column(s) without default: ${required.map(r => r.column).join(', ')}`)
    }

    await DATABASE.query(`ALTER TABLE ${q(table)} RENAME TO ${q(old)}`)
    await model.sync()

    const common = attrs.map(a => a.column).filter(c => oldColumns.includes(c)).map(q).join(', ')
    await DATABASE.query(`INSERT OR IGNORE INTO ${q(table)} (${common}) SELECT ${common} FROM ${q(old)} ORDER BY rowid`)

    const [{ n: before }] = await pragma(`SELECT COUNT(*) AS n FROM ${q(old)}`)
    const [{ n: copied }] = await pragma(`SELECT COUNT(*) AS n FROM ${q(table)}`)
    const dropped = before - copied

    // Rows that could not be carried over stay available in a backup table
    let backup = null
    if (dropped > 0) {
      backup = `${table}__backup_${Date.now()}`
      await DATABASE.query(`ALTER TABLE ${q(old)} RENAME TO ${q(backup)}`)
    } else {
      await DATABASE.query(`DROP TABLE ${q(old)}`)
    }

    await DATABASE.query('COMMIT')
    started = false
    return { copied, dropped, backup }
  } catch (err) {
    if (started) await DATABASE.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    if (foreignKeys) await DATABASE.query('pragma foreign_keys = on')
  }
}

async function repairSqlite(existing, summary) {
  for (const model of existing) {
    const table = model.tableName
    try {
      const spurious = await findSpuriousUniqueColumns(model)
      if (!spurious.length) continue

      const { copied, dropped, backup } = await rebuildSqliteTable(model)
      summary.repaired.push(table)
      logger.info(`Database repaired: table ${table} rebuilt (removed UNIQUE on ${spurious.join(', ')}), ${copied} row(s) kept`)
      if (dropped > 0) {
        const message = `${table}: ${dropped} row(s) broke the model constraints and were not copied (first row kept per key); original data kept in table ${backup}`
        summary.warnings.push(message)
        logger.warn(message)
      }
    } catch (err) {
      const message = `${table}: repair failed, table left unchanged (${errorText(err)})`
      summary.errors.push(message)
      logger.error(message)
    }
  }
}

// ---------------------------------------------------------------------------
// Additive steps (both dialects)
// ---------------------------------------------------------------------------

async function addMissingColumns(model, summary) {
  const qi = DATABASE.getQueryInterface()
  const table = tableOf(model)
  const existing = await qi.describeTable(table)

  for (const { column, attr } of columnsOf(model)) {
    if (existing[column]) continue

    const label = `${model.tableName}.${column}`
    const nullable = attr.allowNull !== false
    if (attr.primaryKey || attr.autoIncrement || (!nullable && !hasSqlDefault(attr))) {
      const message = `${label}: column missing but cannot be added to an existing table (not null without default, or key); add it by hand`
      summary.errors.push(message)
      logger.error(message)
      continue
    }

    try {
      await qi.addColumn(table, column, attr)
      summary.columns.push(label)
    } catch (err) {
      const message = `${label}: could not add column (${errorText(err)})`
      summary.errors.push(message)
      logger.error(message)
    }
  }
}

async function ensureIndexes(model, summary) {
  const qi = DATABASE.getQueryInterface()
  const table = tableOf(model)
  const present = new Set((await qi.showIndex(table)).map(index => index.name))

  for (const index of model._indexes || []) {
    if (present.has(index.name)) continue

    const label = `${model.tableName}.${index.name}`
    try {
      await qi.addIndex(table, { ...index })
      summary.indexes.push(label)
    } catch (err) {
      if (isAlreadyExists(err)) continue
      const message = isUniqueViolation(err)
        ? `${label}: unique index not created, the table holds duplicate rows (${errorText(err)}). Remove the duplicates; it is retried on each boot`
        : `${label}: could not create index (${errorText(err)})`
      if (isUniqueViolation(err)) {
        summary.warnings.push(message)
        logger.warn(message)
      } else {
        summary.errors.push(message)
        logger.error(message)
      }
    }
  }
}

/** One line, only when something changed */
function logSummary(summary) {
  const parts = []
  if (summary.created.length) parts.push(`${summary.created.length} table(s) created`)
  if (summary.repaired.length) parts.push(`${summary.repaired.length} table(s) repaired (${summary.repaired.join(', ')})`)
  if (summary.columns.length) parts.push(`${summary.columns.length} column(s) added (${summary.columns.join(', ')})`)
  if (summary.indexes.length) parts.push(`${summary.indexes.length} index(es) created (${summary.indexes.join(', ')})`)
  if (parts.length) logger.info(`Database schema updated: ${parts.join('; ')}`)
}

/**
 * Bring the schema up to date. Never drops or alters an existing column.
 * @returns {Promise<{created: string[], repaired: string[], columns: string[], indexes: string[], warnings: string[], errors: string[]}>}
 */
async function sync() {
  const qi = DATABASE.getQueryInterface()
  const summary = { created: [], repaired: [], columns: [], indexes: [], warnings: [], errors: [] }

  const ordered = []
  DATABASE.modelManager.forEachModel(model => ordered.push(model), { reverse: false })

  // 1. Missing tables (with their indexes). Existing ones are only completed below
  const existing = []
  for (const model of ordered) {
    if (await qi.tableExists(tableOf(model))) {
      existing.push(model)
    } else {
      await model.sync()
      summary.created.push(model.tableName)
    }
  }

  // 2. Damage left by `alter: true` on SQLite
  if (DATABASE.getDialect() === 'sqlite') await repairSqlite(existing, summary)

  // 3 and 4. Missing columns, then missing indexes (an index may need a new column)
  for (const model of existing) {
    // Postgres: new ENUM values (no-op on SQLite)
    await qi.ensureEnums(tableOf(model), model.tableAttributes, {}, model)
    await addMissingColumns(model, summary)
    await ensureIndexes(model, summary)
  }

  logSummary(summary)
  return summary
}

// Export models and database
module.exports = {
  ...models,
  DATABASE,
  sync
}
