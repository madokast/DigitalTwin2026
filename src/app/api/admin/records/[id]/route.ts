import { NextRequest, NextResponse } from 'next/server'

/**
 * 记录编辑 API 已废弃（2026-08-04 定案，见 docs/20260804-log-review.md §5
 * 与 docs/20260804-scope-closure.md 终止项 7）：对一切记录一律 410 Gone。
 * 不读请求体、不做任何校验（proxy 层鉴权先于本路由）。
 */
export const RECORD_EDIT_RETIRED_ERROR = 'The record editing API is retired (Gone)'

export async function PATCH(
  _request: NextRequest,
  _context: { params: Promise<{ id: string }> },
) {
  void _request
  void _context
  return NextResponse.json({ error: RECORD_EDIT_RETIRED_ERROR }, { status: 410 })
}
