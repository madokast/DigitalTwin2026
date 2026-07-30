'use client'

import { useState, useEffect } from 'react'

interface Record {
  id: string
  happenedAt: string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

export default function Home() {
  const [token, setToken] = useState('')
  const [records, setRecords] = useState<Record[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 从 localStorage 读取 token
  useEffect(() => {
    const savedToken = localStorage.getItem('digitaltwin_token')
    if (savedToken) {
      setToken(savedToken)
    }
  }, [])

  // 保存 token 到 localStorage
  const saveToken = () => {
    localStorage.setItem('digitaltwin_token', token)
    alert('Token 已保存')
  }

  // 获取数据
  const fetchRecords = async () => {
    if (!token) {
      setError('请先设置 Token')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/query', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!res.ok) {
        throw new Error('请求失败')
      }

      const data = await res.json()
      setRecords(data.records)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">DigitalTwin2026</h1>
        
        {/* Token 设置 */}
        <div className="bg-white p-4 rounded-lg shadow mb-6">
          <h2 className="text-lg font-semibold mb-4">Token 设置</h2>
          <div className="flex gap-4">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="输入 Token"
              className="flex-1 px-4 py-2 border rounded-lg"
            />
            <button
              onClick={saveToken}
              className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              保存
            </button>
            <button
              onClick={fetchRecords}
              className="px-6 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
            >
              加载数据
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* 数据表格 */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-3 text-left">ID</th>
                <th className="px-4 py-3 text-left">时间</th>
                <th className="px-4 py-3 text-left">数值</th>
                <th className="px-4 py-3 text-left">文本</th>
                <th className="px-4 py-3 text-left">标签</th>
                <th className="px-4 py-3 text-left">客观背景</th>
                <th className="px-4 py-3 text-left">主观解读</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    加载中...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    暂无数据，点击"加载数据"获取
                  </td>
                </tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-mono">{record.id.slice(0, 8)}...</td>
                    <td className="px-4 py-3 text-sm">{new Date(record.happenedAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm">{record.valueNumber || '-'}</td>
                    <td className="px-4 py-3 text-sm max-w-xs truncate">{record.valueText || '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      {JSON.parse(record.tags).map((tag: string) => (
                        <span key={tag} className="inline-block bg-blue-100 text-blue-800 px-2 py-1 rounded mr-1 text-xs">
                          {tag}
                        </span>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-sm max-w-xs truncate">{record.objectiveContext}</td>
                    <td className="px-4 py-3 text-sm max-w-xs truncate">{record.subjectiveInterpretation || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 统计信息 */}
        {records.length > 0 && (
          <div className="mt-4 text-gray-500 text-sm">
            共 {records.length} 条记录
          </div>
        )}
      </div>
    </div>
  )
}
