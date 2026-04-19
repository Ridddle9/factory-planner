/**
 * Patches prisma/schema.prisma to use PostgreSQL provider.
 * Called only during Railway build (not local dev).
 */
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaPath = path.join(__dirname, '../prisma/schema.prisma')

let schema = readFileSync(schemaPath, 'utf8')
schema = schema.replace('provider = "sqlite"', 'provider = "postgresql"')
writeFileSync(schemaPath, schema)
console.log('✓ Prisma schema patched: sqlite → postgresql')
