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
  const [showSettings, setShowSettings] = useState(false)
  const [showRecords, setShowRecords] = useState(false)

  // 从 localStorage 读取 token
  useEffect(() => {
    const savedToken = localStorage.getItem('digitaltwin_token')
    if (savedToken) {
      setToken(savedToken)
    }
  }, [])

  // 保存 token
  const saveToken = () => {
    localStorage.setItem('digitaltwin_token', token)
    setShowSettings(false)
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
      setShowRecords(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 主页 */}
      {!showSettings && !showRecords && (
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
          <h1 className="text-2xl font-bold mb-8">DigitalTwin2026</h1>
          
          <div className="flex flex-col gap-4 w-full max-w-xs">
            <button
              onClick={fetchRecords}
              disabled={loading}
              className="w-full px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400"
            >
              {loading ? '加载中...' : '查看记录'}
            </button>
            
            <button
              onClick={() => setShowSettings(true)}
              className="w-full px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              设置
            </button>
          </div>

          {error && (
            <div className="mt-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded w-full max-w-xs">
              {error}
            </div>
          )}
        </div>
      )}

      {/* 设置页面 */}
      {showSettings && (
        <div className="min-h-screen p-4">
          <div className="max-w-md mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">设置</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            
            <div className="bg-white p-4 rounded-lg shadow">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="输入 Token"
                className="w-full px-4 py-2 border rounded-lg mb-4"
              />
              <button
                onClick={saveToken}
                className="w-full px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 记录展示页面 */}
      {showRecords && (
        <div className="min-h-screen p-4">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">记录</h2>
              <button
                onClick={() => setShowRecords(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            
            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm">ID</th>
                    <th className="px-3 py-2 text-left text-sm">时间</th>
                    <th className="px-3 py-2 text-left text-sm">数值</th>
                    <th className="px-3 py-2 text-left text-sm">文本</th>
                    <th className="px-3 py-2 text-left text-sm">标签</th>
                    <th className="px-3 py-2 text-left text-sm">客观背景</th>
                    <th className="px-3 py-2 text-left text-sm">主观解读</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs font-mono">{record.id.slice(0, 8)}...</td>
                      <td className="px-3 py-2 text-xs">{new Date(record.happenedAt).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs">{record.valueNumber || '-'}</td>
                      <td className="px-3 py-2 text-xs max-w-[150px] truncate">{record.valueText || '-'}</td>
                      <td className="px-3 py-2 text-xs">
                        {JSON.parse(record.tags).map((tag: string) => (
                          <span key={tag} className="inline-block bg-blue-100 text-blue-800 px-1 py-0.5 rounded mr-1 text-xs">
                            {tag}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[150px] truncate">{record.objectiveContext}</td>
                      <td className="px-3 py-2 text-xs max-w-[150px] truncate">{record.subjectiveInterpretation || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 text-gray-500 text-sm">
              共 {records.length} 条记录
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
