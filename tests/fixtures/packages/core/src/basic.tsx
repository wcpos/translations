// Basic t() calls - should be extracted with ns: "core"
import { useTranslation } from 'react-i18next';

export function BasicComponent() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('Welcome to WCPOS')}</h1>
      <p>{t('This is a test string')}</p>
      <button>{t("Double quoted string")}</button>
    </div>
  );
}
