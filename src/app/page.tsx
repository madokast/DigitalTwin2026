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

type View = 'home' | 'settings' | 'records' | 'tags'

export default function Home() {
  const [token, setToken] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [records, setRecords] = useState<Record[]>([])
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({})
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [view, setView] = useState<View>('home')

  useEffect(() => {
    const savedToken = localStorage.getItem('digitaltwin_token')
    const savedAdmin = localStorage.getItem('digitaltwin_admin_token')
    if (savedToken) setToken(savedToken)
    if (savedAdmin) setAdminToken(savedAdmin)
  }, [])

  const saveTokens = () => {
    localStorage.setItem('digitaltwin_token', token)
    localStorage.setItem('digitaltwin_admin_token', adminToken)
    setView('home')
    setMessage('已保存')
  }

  const fetchRecords = async () => {
    if (!token && !adminToken) {
      setError('请先设置 Token 或 Admin Token')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/query', {
        headers: {
          Authorization: `Bearer ${token || adminToken}`,
        },
      })

      if (!res.ok) {
        throw new Error('请求失败')
      }

      const data = await res.json()
      setRecords(data.records)
      setView('records')
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchTags = async () => {
    const auth = adminToken || token
    if (!auth) {
      setError('请先设置 Token 或 Admin Token')
      return
    }

    setLoading(true)
    setError('')
    setMessage('')

    try {
      const res = await fetch('/api/query/tags', {
        headers: { Authorization: `Bearer ${auth}` },
      })
      if (!res.ok) throw new Error('拉取标签失败')
      const data = await res.json()
      setTagCounts(data.tags ?? {})
      setView('tags')
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setLoading(false)
    }
  }

  const renameTag = async () => {
    if (!adminToken) {
      setError('标签替换需要 Admin Token（不要把 Admin Token 交给 AI）')
      return
    }
    if (!renameFrom || !renameTo) {
      setError('请填写 from 与 to')
      return
    }

    setLoading(true)
    setError('')
    setMessage('')

    try {
      const res = await fetch('/api/admin/tags/rename', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: renameFrom, to: renameTo }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || '替换失败')
      }
      setMessage(`已更新 ${data.updated} 条记录`)
      setRenameFrom('')
      setRenameTo('')
      const tagsRes = await fetch('/api/query/tags', {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      const tagsData = await tagsRes.json()
      setTagCounts(tagsData.tags ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : '替换失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {view === 'home' && (
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
              onClick={fetchTags}
              disabled={loading}
              className="w-full px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400"
            >
              标签管理
            </button>

            <button
              onClick={() => {
                setError('')
                setMessage('')
                setView('settings')
              }}
              className="w-full px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              设置
            </button>
          </div>

          {message && (
            <div className="mt-4 text-green-700 text-sm w-full max-w-xs">{message}</div>
          )}
          {error && (
            <div className="mt-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded w-full max-w-xs">
              {error}
            </div>
          )}
        </div>
      )}

      {view === 'settings' && (
        <div className="min-h-screen p-4">
          <div className="max-w-md mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">设置</h2>
              <button
                onClick={() => setView('home')}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="bg-white p-4 rounded-lg shadow space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  API Token（AI / 查询录入）
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="DIGITAL_TWIN_TOKEN"
                  className="w-full px-4 py-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Admin Token（仅网页改库，勿给 AI）
                </label>
                <input
                  type="password"
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  placeholder="DIGITAL_TWIN_ADMIN_TOKEN"
                  className="w-full px-4 py-2 border rounded-lg"
                />
              </div>

              <button
                onClick={saveTokens}
                className="w-full px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'tags' && (
        <div className="min-h-screen p-4">
          <div className="max-w-md mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">标签管理</h2>
              <button
                onClick={() => setView('home')}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="bg-white p-4 rounded-lg shadow mb-4">
              <h3 className="font-medium mb-3">现有标签</h3>
              {Object.keys(tagCounts).length === 0 ? (
                <p className="text-sm text-gray-500">暂无标签</p>
              ) : (
                <ul className="space-y-1 text-sm font-mono">
                  {Object.entries(tagCounts).map(([tag, count]) => (
                    <li key={tag} className="flex justify-between">
                      <span>{tag}</span>
                      <span className="text-gray-500">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white p-4 rounded-lg shadow space-y-3">
              <h3 className="font-medium">全局替换</h3>
              <input
                value={renameFrom}
                onChange={(e) => setRenameFrom(e.target.value)}
                placeholder="from，如 exercise"
                className="w-full px-4 py-2 border rounded-lg"
              />
              <input
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                placeholder="to，如 workout"
                className="w-full px-4 py-2 border rounded-lg"
              />
              <button
                onClick={renameTag}
                disabled={loading}
                className="w-full px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400"
              >
                {loading ? '处理中...' : '替换'}
              </button>
              {message && <p className="text-sm text-green-700">{message}</p>}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          </div>
        </div>
      )}

      {view === 'records' && (
        <div className="min-h-screen p-4">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">记录</h2>
              <button
                onClick={() => setView('home')}
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
