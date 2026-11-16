import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/api/client'
import { setToken } from '@/lib/utils'
import { useWSStore } from '@/stores/websocket'
import { Radio, ArrowRight } from 'lucide-react'
import { Input, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { LanguageSwitcher, useManagementLocale } from '@/i18n'

export default function Login() {
  const { t } = useManagementLocale()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) return

    setLoading(true)
    setError('')
    try {
      const data = await api.login(username, password)
      setToken(data.token)
      useWSStore.getState().connect()
      navigate('/', { replace: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录失败')
    }
    setLoading(false)
  }

  return (
    <div className="login-shell">
      <section className="login-intro">
        <div className="flex items-center gap-3"><span className="brand-mark"><Radio size={22} /></span><span className="brand-name">{t('brand.name')}</span></div>
        <h1>{t('login.heroTitle')}<br />{t('login.heroTitleSecond')}</h1>
        <p>{t('login.heroDescription')}</p>
        <div className="login-facts"><span>{t('login.factApps')}</span><span>{t('login.factStreams')}</span><span>{t('login.factControl')}</span></div>
      </section>
      <section className="login-form-area" aria-label={t('brand.serverConsole')}>
      <div className="login-form">
        <div className="mb-8">
          <div className="flex items-center justify-between gap-3"><p className="page-eyebrow">{t('brand.serverConsole')}</p><LanguageSwitcher /></div>
          <h2>{t('login.welcome')}</h2>
          <p className="text-sm text-muted-foreground mt-2">{t('login.formDescription')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="error">{error}</Alert>
          )}

          <div>
            <Label htmlFor="username">{t('login.username')}</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t('login.usernamePlaceholder')}
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <Label htmlFor="password">{t('login.password')}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder')}
              autoComplete="current-password"
            />
          </div>

          <Button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full"
          >
            {loading ? t('login.submitting') : t('login.submit')}<ArrowRight size={16} aria-hidden="true" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-6">{t('login.viewerHint')}</p>
      </div>
      </section>
    </div>
  )
}
