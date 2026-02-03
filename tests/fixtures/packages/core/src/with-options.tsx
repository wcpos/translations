// t() calls with options
import { useTranslation } from 'react-i18next';

export function OptionsComponent() {
  const { t } = useTranslation();

  return (
    <div>
      {/* With context */}
      <span>{t('Open', { _context: 'button' })}</span>
      <span>{t('Open', { _context: 'status' })}</span>

      {/* With explicit namespace - should override default */}
      <span>{t('Pro Feature', { ns: 'pro' })}</span>
      <span>{t('Legacy tags style', { _tags: 'legacy' })}</span>

      {/* With placeholders */}
      <span>{t('Hello {name}', { name: 'World' })}</span>
      <span>{t('You have {count} items')}</span>
    </div>
  );
}
