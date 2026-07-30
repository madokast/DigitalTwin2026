-- DigitalTwin2026 数据库初始化脚本
-- 创建记录表（唯一表）

CREATE TABLE IF NOT EXISTS records (
  id UUID PRIMARY KEY,
  happened_at TIMESTAMPTZ NOT NULL,
  value_numeric NUMERIC,
  value_text TEXT,
  tags TEXT NOT NULL,
  context TEXT,
  
  -- 确保 value_numeric 和 value_text 至少填一个
  CONSTRAINT chk_value CHECK (
    value_numeric IS NOT NULL OR value_text IS NOT NULL
  ),
  
  -- 确保 tags 是有效的 JSON 数组且不为空
  CONSTRAINT chk_tags CHECK (
    tags ~ '^\[.+\]$'
  )
);

-- 创建索引：按 happened_at 查询
CREATE INDEX IF NOT EXISTS idx_records_happened_at ON records (happened_at);

-- 创建索引：按 tags 模糊搜索
CREATE INDEX IF NOT EXISTS idx_records_tags ON records USING GIN (to_tsvector('simple', tags));
