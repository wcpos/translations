// Trans component usage
import { Trans } from 'react-i18next';

export function TransComponent() {
  return (
    <div>
      <Trans i18nKey="Welcome back, user!" />
      <Trans i18nKey="Click <bold>here</bold> for more" />
      <Trans i18nKey='Single quoted i18nKey' />
      <p>
        <Trans
          i18nKey="Multiline Trans component"
          components={{ br: <br /> }}
        />
      </p>
    </div>
  );
}
