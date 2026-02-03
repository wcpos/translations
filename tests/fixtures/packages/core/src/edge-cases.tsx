// Edge cases for extraction
import { useTranslation } from 'react-i18next';

export function EdgeCases() {
  const { t } = useTranslation();
  const name = 'test';

  return (
    <div>
      {/* Template literal without interpolation - should work */}
      <span>{t(`Template literal string`)}</span>

      {/* Template literal WITH interpolation - should warn and skip */}
      <span>{t(`Hello ${name}`)}</span>

      {/* Escaped quotes */}
      <span>{t('String with \'escaped\' quotes')}</span>
      <span>{t("String with \"escaped\" double quotes")}</span>

      {/* Empty string - edge case */}
      <span>{t('')}</span>

      {/* Multiline string */}
      <span>{t('This is a very long string that ' +
        'spans multiple lines in the source')}</span>
    </div>
  );
}
