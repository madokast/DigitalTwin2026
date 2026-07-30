import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)

async function checkDB() {
  try {
    // 检查表是否存在
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `
    console.log('表列表:', tables.map(t => t.table_name))
    
    // 检查 records 表结构
    const columns = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'records'
      ORDER BY ordinal_position
    `
    console.log('\nrecords 表结构:')
    columns.forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(可空)' : '(必填)'}`)
    })
    
    // 检查约束
    const constraints = await sql`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'records'
    `
    console.log('\n约束:', constraints.map(c => `${c.constraint_name} (${c.constraint_type})`))
    
  } catch (error) {
    console.error('检查失败:', error)
  } finally {
    await sql.end()
  }
}

checkDB()
