import { setManagementLocale, useManagementLocale, type ManagementLocale } from './locale'

export default function LanguageSwitcher() {
  const { locale, t } = useManagementLocale()
  return <label className="locale-switcher">
    <span className="sr-only">{t('common.language')}</span>
    <select aria-label={t('common.language')} value={locale} onChange={event => setManagementLocale(event.target.value as ManagementLocale)}>
      <option value="zh-CN">中文</option>
      <option value="en">English</option>
    </select>
  </label>
}
