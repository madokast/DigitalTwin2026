/** 部署/刷新脚本用：主动 C2C 探测；成功返回 null，失败返回英文原因（不含 secret） */
import { sendQqMessage } from '../../src/lib/qqbot'

export async function qqbotProbeSend(
  appId: string,
  appSecret: string,
  userOpenid: string,
  text: string,
): Promise<string | null> {
  const result = await sendQqMessage(text, {
    env: {
      QQBOT_APP_ID: appId,
      QQBOT_APP_SECRET: appSecret,
      QQBOT_USER_OPENID: userOpenid,
    },
  })
  if (result.ok) return null
  return result.error
}
