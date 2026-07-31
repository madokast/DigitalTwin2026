/** 调 Bot API sendMessage；成功返回 null，失败返回英文原因（不含 token） */
export async function telegramProbeSend(
  token: string,
  userId: string,
  text: string,
): Promise<string | null> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Telegram probe request failed: ${msg}`
  }
  let body: { ok?: boolean; description?: string } = {}
  try {
    body = (await res.json()) as { ok?: boolean; description?: string }
  } catch {
    return `Telegram sendMessage failed (HTTP ${res.status}, invalid JSON)`
  }
  if (!res.ok || !body.ok) {
    const reason = body.description || `HTTP ${res.status}`
    return `Telegram sendMessage failed: ${reason}`
  }
  return null
}
