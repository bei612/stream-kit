import { Link } from 'react-router'
import type { ReactNode } from 'react'
import { ArrowUp, CheckCircle2, CircleHelp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Page } from '@/components/layout/Page'
import { useManagementLocale } from '@/i18n'

const sections = [
  ['overview', 'docs.overviewTitle'],
  ['quick-start', 'docs.quickStartTitle'],
  ['apps', 'docs.appsTitle'],
  ['sessions', 'docs.sessionsTitle'],
  ['audio', 'docs.audioTitle'],
  ['operations', 'docs.troubleshootTitle'],
] as const

export default function Docs() {
  const { t } = useManagementLocale()
  return (
    <Page title={t('docs.title')} eyebrow={t('docs.eyebrow')} description={t('docs.description')}>
      <div className="docs-layout">
        <aside className="docs-toc panel" aria-label={t('docs.toc')}>
          <h2 className="panel-title">{t('docs.toc')}</h2>
          <nav>
            {sections.map(([id, key]) => <a key={id} href={`#${id}`}>{t(key)}</a>)}
          </nav>
        </aside>
        <div className="docs-content">
          <p className="docs-screenshot-note">{t('docs.screenshotNote')}</p>
          <DocSection id="overview" title={t('docs.overviewTitle')}>
            <p>{t('docs.overviewBody')}</p>
            <h3 className="docs-subtitle">{t('docs.serverUsageTitle')}</h3>
            <p>{t('docs.serverUsageBody')}</p>
            <div className="docs-role-grid">
              <Card><span className="docs-role-icon"><CheckCircle2 size={17} /></span><strong>{t('brand.serverConsole')}</strong><p>{t('docs.serverRole')}</p></Card>
              <Card><span className="docs-role-icon"><CircleHelp size={17} /></span><strong>{t('brand.client')}</strong><p>{t('docs.clientRole')}</p></Card>
            </div>
          </DocSection>

          <DocSection id="quick-start" title={t('docs.quickStartTitle')}>
            <p>{t('docs.quickStartBody')}</p>
            <ol className="docs-steps">
              <li><b>1</b><span>{t('docs.stepApps')}</span></li>
              <li><b>2</b><span>{t('docs.stepStart')}</span></li>
              <li><b>3</b><span>{t('docs.stepShare')}</span></li>
            </ol>
            <GuideFigure src="/docs/screenshots/dashboard.png" alt={t('docs.dashboardFigure')} caption={t('docs.dashboardFigure')} />
          </DocSection>

          <DocSection id="apps" title={t('docs.appsTitle')}>
            <p>{t('docs.appsBody')}</p>
            <GuideFigure src="/docs/screenshots/apps.png" alt={t('docs.appsFigure')} caption={t('docs.appsFigure')} />
            <GuideFigure src="/docs/screenshots/upload.png" alt={t('docs.uploadFigure')} caption={t('docs.uploadFigure')} />
            <p>{t('docs.uploadStorage')}</p>
            <GuideFigure src="/docs/screenshots/components.png" alt={t('docs.componentsFigure')} caption={t('docs.componentsFigure')} />
          </DocSection>

          <DocSection id="sessions" title={t('docs.sessionsTitle')}>
            <p>{t('docs.sessionsBody')}</p>
            <GuideFigure src="/docs/screenshots/sessions.png" alt={t('docs.sessionsFigure')} caption={t('docs.sessionsFigure')} />
          </DocSection>

          <DocSection id="audio" title={t('docs.audioTitle')}>
            <p>{t('docs.audioBody')}</p>
            <h3 className="docs-subtitle">{t('docs.clientUsageTitle')}</h3>
            <p>{t('docs.clientUsageBody')}</p>
            <ol className="docs-steps">
              <li><b>1</b><span>{t('docs.clientStepOpen')}</span></li>
              <li><b>2</b><span>{t('docs.clientStepPermission')}</span></li>
              <li><b>3</b><span>{t('docs.clientStepControl')}</span></li>
            </ol>
            <GuideFigure src="/docs/screenshots/client.png" alt={t('docs.clientFigure')} caption={t('docs.clientFigure')} />
            <div className="docs-note"><CircleHelp size={17} /><span>{t('docs.audioNote')}</span></div>
          </DocSection>

          <DocSection id="operations" title={t('docs.troubleshootTitle')}>
            <p>{t('docs.troubleshootBody')}</p>
            <GuideFigure src="/docs/screenshots/logs.png" alt={t('docs.logsFigure')} caption={t('docs.logsFigure')} />
            <div className="docs-links">
              <Link to="/components">{t('nav.components')}</Link>
              <Link to="/apps">{t('nav.apps')}</Link>
              <Link to="/logs">{t('nav.logs')}</Link>
            </div>
          </DocSection>
          <a className="docs-top-link" href="#overview"><ArrowUp size={14} /> {t('docs.backToTop')}</a>
        </div>
      </div>
    </Page>
  )
}

function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="docs-section"><h2>{title}</h2>{children}</section>
}

function GuideFigure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return <figure className="docs-figure"><img src={src} alt={alt} loading="lazy" /><figcaption>{caption}</figcaption></figure>
}
