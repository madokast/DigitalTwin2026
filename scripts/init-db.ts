import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)

async function initDB() {
  try {
    console.log('连接数据库...')
    
    // 读取 SQL 文件
    const sqlFile = join(__dirname, 'init-db.sql')
    const sqlContent = readFileSync(sqlFile, 'utf-8')
    
    // 执行 SQL
    console.log('执行建表脚本...')
    await sql.unsafe(sqlContent)
    
    console.log('数据库初始化完成！')
  } catch (error) {
    console.error('初始化失败:', error)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

initDB()
