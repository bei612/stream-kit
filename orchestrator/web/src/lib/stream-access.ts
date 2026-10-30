import { api } from '@/api/client'

export async function openViewingStream(loadStreamPath: () => Promise<string>): Promise<void> {
  // Reserve the tab during the user gesture, before network calls consume the
  // browser's transient activation (especially on mobile browsers).
  const tab = window.open('about:blank', '_blank')
  if (!tab) throw new Error('请允许打开新窗口后重试')
  tab.opener = null
  try {
    const path = await loadStreamPath()
    if (!path) throw new Error('应用没有可用的串流入口')
    const invitation = await createViewingInvitation(path)
    if (!tab.closed) tab.location.replace(invitation)
  } catch (error) {
    tab.close()
    throw error
  }
}

// Viewing links contain only short invitations, never management credentials.
export async function createViewingInvitation(portPath: string): Promise<string> {
  const source = new URL(`${window.location.protocol}//${window.location.hostname}:${portPath}`)
  const hostId = Number(source.searchParams.get('hostId'))
  const appId = Number(source.searchParams.get('appId'))
  if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isInteger(appId) || appId <= 0) {
    throw new Error('串流入口缺少有效的主机或应用编号')
  }
  const response = await api.inviteStreamViewers(hostId, appId)
  if (!response.data) throw new Error('无法创建观看邀请')
  const result = response.data
  const url = result.gateway_public_url
    ? new URL('stream.html', result.gateway_public_url.replace(/\/$/, '') + '/')
    : source
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('串流网关公开地址配置无效')
  if (window.location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('串流网关需要配置 HTTPS 公开地址')
  url.search = ''
  url.searchParams.set('hostId', String(hostId))
  url.searchParams.set('appId', String(appId))
  url.hash = new URLSearchParams({ join: result.invitation }).toString()
  return url.toString()
}
