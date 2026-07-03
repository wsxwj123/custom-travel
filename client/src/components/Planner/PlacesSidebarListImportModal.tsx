import ReactDOM from 'react-dom'
import ToggleSwitch from '../Settings/ToggleSwitch'
import type { SidebarState } from './usePlacesSidebar'

export function ListImportModal(S: SidebarState) {
  const {
    setListImportOpen, setListImportUrl, t, hasMultipleListImportProviders, availableListImportProviders,
    listImportProvider, setListImportProvider, listImportUrl, listImportLoading, handleListImport,
    listImportEnrich, setListImportEnrich, canEnrichImport,
    listImportText, setListImportText,
  } = S
  const isSocial = listImportProvider === 'social'
  const providerLabel = (p: string) =>
    p === 'google' ? t('places.importGoogleList') : p === 'naver' ? t('places.importNaverList') : t('places.importSocialList')
  const canSubmit = isSocial ? !!(listImportUrl.trim() || listImportText.trim()) : !!listImportUrl.trim()
  return ReactDOM.createPortal(
    <div
      onClick={() => { setListImportOpen(false); setListImportUrl('') }}
      className="bg-[rgba(0,0,0,0.4)]"
      style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-surface-card"
        style={{ borderRadius: 16, width: '100%', maxWidth: 440, padding: 24, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
      >
        <div className="text-content" style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
          {t('places.importList')}
        </div>
        {hasMultipleListImportProviders && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {availableListImportProviders.map(provider => (
              <button
                key={provider}
                onClick={() => setListImportProvider(provider)}
                className={listImportProvider === provider ? 'bg-accent text-accent-text' : 'bg-surface-tertiary text-content-muted'}
                style={{
                  padding: '6px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                }}
              >
                {providerLabel(provider)}
              </button>
            ))}
          </div>
        )}
        <div className="text-content-faint" style={{ fontSize: 12, marginBottom: 16 }}>
          {t(listImportProvider === 'google' ? 'places.googleListHint' : listImportProvider === 'naver' ? 'places.naverListHint' : 'places.socialListHint')}
        </div>
        <input
          type="text"
          value={listImportUrl}
          onChange={e => setListImportUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !listImportLoading) handleListImport() }}
          placeholder={listImportProvider === 'google' ? 'https://maps.app.goo.gl/...' : listImportProvider === 'naver' ? 'https://naver.me/...' : 'http://xhslink.com/... / https://b23.tv/...'}
          autoFocus
          className="bg-surface-tertiary text-content"
          style={{
            width: '100%', padding: '10px 14px', borderRadius: 10,
            border: '1px solid var(--border-primary)',
            fontSize: 13, outline: 'none',
            fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
        {isSocial && (
          <textarea
            value={listImportText}
            onChange={e => setListImportText(e.target.value)}
            placeholder={t('places.socialTextPlaceholder')}
            rows={5}
            className="bg-surface-tertiary text-content"
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10, marginTop: 8,
              border: '1px solid var(--border-primary)',
              fontSize: 13, outline: 'none', resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        )}
        {canEnrichImport && !isSocial && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-content" style={{ fontSize: 12, fontWeight: 600 }}>{t('places.enrichOnImport')}</div>
              <div className="text-content-faint" style={{ fontSize: 12, marginTop: 2 }}>{t('places.enrichOnImportHint')}</div>
            </div>
            <ToggleSwitch on={listImportEnrich} onToggle={() => setListImportEnrich(!listImportEnrich)} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button
            onClick={() => { setListImportOpen(false); setListImportUrl('') }}
            className="text-content"
            style={{
              padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)',
              background: 'none', fontSize: 13, fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleListImport}
            disabled={!canSubmit || listImportLoading}
            className={!canSubmit || listImportLoading ? 'bg-surface-tertiary text-content-faint' : 'bg-accent text-accent-text'}
            style={{
              padding: '8px 16px', borderRadius: 10, border: 'none',
              fontSize: 13, fontWeight: 500, cursor: !canSubmit || listImportLoading ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {listImportLoading ? t('common.loading') : t('common.import')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
