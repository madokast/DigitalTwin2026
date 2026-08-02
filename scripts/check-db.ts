import { loadTestEnv } from './lib/test-env'

loadTestEnv()
import postgres from 'postgres'

const client = postgres(process.env.DATABASE_URL!)

async function checkDB() {
  try {
    // 检查表是否存在
    const tables = await client`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `
    console.log('Tables:', tables.map(t => t.table_name))
    
    // 检查 records 表结构
    const columns = await client`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'records'
      ORDER BY ordinal_position
    `
    console.log('\nrecords schema:')
    columns.forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(nullable)' : '(required)'}`)
    })
    
    // 检查约束
    const constraints = await client`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'records'
    `
    console.log('\nConstraints:', constraints.map(c => `${c.constraint_name} (${c.constraint_type})`))
    
  } catch (error) {
    console.error('Check failed:', error)
  } finally {
    await client.end()
  }
}

checkDB()
