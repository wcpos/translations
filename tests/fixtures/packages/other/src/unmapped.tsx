// This file is NOT in a mapped namespace
// Should trigger a warning and be skipped (unless explicit ns provided)
import { useTranslation } from 'react-i18next';

export function UnmappedComponent() {
  const { t } = useTranslation();

  return (
    <div>
      {/* These should trigger warnings */}
      <span>{t('Unmapped string without namespace')}</span>

      {/* This one has explicit ns, so it should work */}
      <span>{t('Mapped via explicit ns', { ns: 'core' })}</span>
    </div>
  );
}
